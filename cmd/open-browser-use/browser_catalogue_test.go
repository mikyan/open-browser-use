package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/ifuryst/open-browser-use/internal/host"
)

func isolatedBrowserHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	for key, value := range map[string]string{
		"HOME": home, "USERPROFILE": home,
		"LOCALAPPDATA":   filepath.Join(home, "AppData", "Local"),
		"APPDATA":        filepath.Join(home, "AppData", "Roaming"),
		"XDG_CACHE_HOME": filepath.Join(home, ".cache"),
	} {
		t.Setenv(key, value)
	}
	return home
}

func noNativeRegistration(t *testing.T) *[][2]string {
	t.Helper()
	previous := registerNativeHostManifest
	calls := [][2]string{}
	registerNativeHostManifest = func(key, value string) error {
		calls = append(calls, [2]string{key, value})
		return nil
	}
	t.Cleanup(func() { registerNativeHostManifest = previous })
	return &calls
}

func testNativeBinary(t *testing.T) string {
	t.Helper()
	name := filepath.Join(t.TempDir(), "open-browser-use.exe")
	if err := os.WriteFile(name, []byte("test executable\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return name
}

func TestBrowserCatalogueEdgeDefaults(t *testing.T) {
	home := filepath.Join(t.TempDir(), "user")
	local := filepath.Join(t.TempDir(), "local")
	for _, test := range []struct{ goos, want string }{
		{"windows", filepath.Join(local, "Microsoft", "Edge", "User Data")},
		{"darwin", filepath.Join(home, "Library", "Application Support", "Microsoft Edge")},
		{"linux", filepath.Join(home, ".config", "microsoft-edge")},
	} {
		t.Run(test.goos, func(t *testing.T) {
			roots, err := browserCatalogue(test.goos, home, local)
			if err != nil {
				t.Fatal(err)
			}
			var found []browserProfileRoot
			for _, root := range roots {
				if root.BrowserID == "edge" {
					found = append(found, root)
				}
			}
			want := []browserProfileRoot{{BrowserID: "edge", BrowserName: "Microsoft Edge", Root: test.want}}
			if !reflect.DeepEqual(found, want) {
				t.Fatalf("Edge default = %#v, want %#v", found, want)
			}
		})
	}
	if _, err := browserCatalogue("unknown", home, local); err == nil {
		t.Fatal("unknown platforms must not silently use Chrome roots")
	}
	roots, err := browserCatalogue("windows", home, "")
	if err != nil || roots[len(roots)-1].Root != filepath.Join(home, "AppData", "Local", "Microsoft", "Edge", "User Data") {
		t.Fatalf("LOCALAPPDATA fallback: %#v, %v", roots, err)
	}
}

func TestNativeManifestInstallPlanSeparatesEdge(t *testing.T) {
	home, local := t.TempDir(), t.TempDir()
	roots, err := browserCatalogue("windows", home, local)
	if err != nil {
		t.Fatal(err)
	}
	plans := map[string]nativeManifestInstallPlan{}
	for _, root := range roots {
		plan, err := planNativeManifestInstall("windows", home, local, root, "")
		if err != nil {
			t.Fatal(err)
		}
		plans[root.BrowserID] = plan
	}
	if plans["chrome"] != plans["chrome-beta"] {
		t.Fatal("Chrome channels should retain the documented shared registration")
	}
	if plans["edge"].ManifestPath == plans["chrome"].ManifestPath {
		t.Fatal("Edge must not overwrite Chrome's allowed origins")
	}
	if want := `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\` + host.NativeHostName; plans["edge"].RegistryKey != want {
		t.Fatalf("Edge registry = %q, want %q", plans["edge"].RegistryKey, want)
	}
	if want := filepath.Join(local, "OpenBrowserUse", "NativeMessagingHosts", "edge", host.NativeHostName+".json"); plans["edge"].ManifestPath != want {
		t.Fatalf("Edge manifest = %q, want %q", plans["edge"].ManifestPath, want)
	}
	for _, goos := range []string{"darwin", "linux"} {
		root := browserProfileRoot{BrowserID: "edge", Root: filepath.Join(home, goos, "Edge")}
		plan, err := planNativeManifestInstall(goos, home, local, root, "")
		if err != nil || plan.RegistryKey != "" || plan.ManifestPath != filepath.Join(root.Root, "NativeMessagingHosts", host.NativeHostName+".json") {
			t.Fatalf("%s plan = %#v, %v", goos, plan, err)
		}
	}
	if _, err := planNativeManifestInstall("windows", home, local, browserProfileRoot{BrowserID: "unverified"}, ""); err == nil {
		t.Fatal("must not guess an unverified browser's registry")
	}
}

func TestBrowserSelectorEdgeAndProfileDiscovery(t *testing.T) {
	isolatedBrowserHome(t)
	for _, selector := range []string{"edge", " EDGE ", "Microsoft Edge", "microsoft edge"} {
		root, err := browserRootForInstallSelector(selector)
		if err != nil || root.BrowserID != "edge" {
			t.Fatalf("selector %q = %#v, %v", selector, root, err)
		}
	}
	for _, selector := range []string{"edge:Default", "edge", "Microsoft Edge"} {
		if !browserSelectorMatches(selector, connectedProfileInfo{Browser: "edge", BrowserName: "Microsoft Edge", Directory: "Default", Target: "edge:Default"}) {
			t.Fatalf("connected Edge profile did not match %q", selector)
		}
	}
	for _, browser := range []string{"chrome", "edge"} {
		root, err := browserRootForInstallSelector(browser)
		if err != nil {
			t.Fatal(err)
		}
		writeLocalStateAtRoot(t, root.Root, `{"profile":{"info_cache":{"Default":{"name":"Work"},"Profile 1":{"name":"Work"}}}}`)
		for _, profile := range []string{"Default", "Profile 1"} {
			writeExtensionManifestAtRoot(t, root.Root, profile, defaultChromeExtensionID, "1.0.0")
			writeExtensionStorageAtRoot(t, root.Root, profile, defaultChromeExtensionID, browser+"-"+profile+"-instance")
		}
	}
	profiles, err := listInstalledChromeProfiles()
	if err != nil || len(profiles) != 4 {
		t.Fatalf("profiles = %#v, %v", profiles, err)
	}
	for _, browser := range []string{"chrome", "edge"} {
		for _, directory := range []string{"Default", "Profile 1"} {
			id, _, _, dir, display, ok := resolveProfileForInstanceID(defaultChromeExtensionID, browser+"-"+directory+"-instance")
			if !ok || id != browser || dir != directory || display != "Work" {
				t.Fatalf("profile identity crossed browser boundary: %s/%s = %s/%s %q %v", browser, directory, id, dir, display, ok)
			}
		}
	}
}

func TestUnknownBrowserFailsBeforeInstallationMutation(t *testing.T) {
	for _, args := range [][]string{
		{"install-manifest", "--browser", "unverified"},
		{"install-manifest", "--browser", "unverified", "--output", "OUT"},
		{"setup", "--browser", "unverified"},
		{"setup", "--browser", "unverified", "--zip", "missing.zip", "--no-open"},
		{"setup", "beta", "--browser", "unverified", "--no-open"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			home := isolatedBrowserHome(t)
			calls := noNativeRegistration(t)
			for i := range args {
				if args[i] == "OUT" {
					args[i] = filepath.Join(home, "export", "manifest.json")
				}
			}
			cmd := newRootCommand()
			var output bytes.Buffer
			cmd.SetOut(&output)
			cmd.SetErr(&output)
			cmd.SetArgs(args)
			err := cmd.Execute()
			if err == nil || !strings.Contains(err.Error(), "unknown browser selector") {
				t.Fatalf("expected selector error before binary/ZIP resolution, got %v", err)
			}
			entries, err := os.ReadDir(home)
			if err != nil || len(entries) != 0 || len(*calls) != 0 {
				t.Fatalf("unknown browser mutated installation: entries=%v registrations=%v err=%v", entries, *calls, err)
			}
		})
	}
}

func TestInstallEdgeManifestExportDoesNotRegister(t *testing.T) {
	home := isolatedBrowserHome(t)
	calls := noNativeRegistration(t)
	output := filepath.Join(home, "export", "edge.json")
	cmd := newRootCommand()
	var stdout bytes.Buffer
	cmd.SetOut(&stdout)
	cmd.SetArgs([]string{"install-manifest", "--browser", "edge", "--path", testNativeBinary(t), "--output", output})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 0 || strings.TrimSpace(stdout.String()) != output {
		t.Fatalf("export registered a host: calls=%v output=%q", *calls, stdout.String())
	}
	if _, err := os.Stat(output); err != nil {
		t.Fatal(err)
	}
	defaultPath, err := defaultNativeHostManifestPathForBrowser("edge")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(defaultPath); !os.IsNotExist(err) {
		t.Fatalf("export also wrote default install path: %v", err)
	}
}

func TestInstallEdgeAndChromeKeepIndependentOrigins(t *testing.T) {
	isolatedBrowserHome(t)
	calls := noNativeRegistration(t)
	binary := testNativeBinary(t)
	chromeID, edgeID := strings.Repeat("a", 32), strings.Repeat("b", 32)
	chromePath, err := installNativeManifestForBrowser(chromeID, binary, "", "chrome")
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(chromePath)
	if err != nil {
		t.Fatal(err)
	}
	edgePath, err := installNativeManifestForBrowser(edgeID, binary, "", "edge")
	if err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(chromePath)
	if err != nil || chromePath == edgePath || !bytes.Equal(before, after) {
		t.Fatalf("Edge changed Chrome's manifest: %v", err)
	}
	edge, err := os.ReadFile(edgePath)
	if err != nil || !bytes.Contains(edge, []byte(edgeID)) || bytes.Contains(edge, []byte(chromeID)) {
		t.Fatalf("unexpected Edge origins: %s, %v", edge, err)
	}
	if runtime.GOOS == "windows" {
		want := [][2]string{
			{`HKCU\Software\Google\Chrome\NativeMessagingHosts\` + host.NativeHostName, chromePath},
			{`HKCU\Software\Microsoft\Edge\NativeMessagingHosts\` + host.NativeHostName, edgePath},
		}
		if !reflect.DeepEqual(*calls, want) {
			t.Fatalf("wrong registry operations: %#v", *calls)
		}
	} else if len(*calls) != 0 {
		t.Fatal("non-Windows installation attempted registry writes")
	}
}

func TestEdgeSetupRejectsUnimplementedModesBeforeMutation(t *testing.T) {
	for _, args := range [][]string{
		{"setup", "--browser", "edge"},
		{"setup", "--browser", "edge", "--zip", "missing.zip"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			home := isolatedBrowserHome(t)
			calls := noNativeRegistration(t)
			cmd := newRootCommand()
			var output bytes.Buffer
			cmd.SetOut(&output)
			cmd.SetErr(&output)
			cmd.SetArgs(args)
			if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), "not implemented") {
				t.Fatalf("expected explicit unsupported Edge mode, got %v", err)
			}
			entries, err := os.ReadDir(home)
			if err != nil || len(entries) != 0 || len(*calls) != 0 {
				t.Fatalf("unsupported setup mutated state: %v %v %v", entries, *calls, err)
			}
		})
	}
}

func TestCobraEdgeZIPSetupNoOpen(t *testing.T) {
	isolatedBrowserHome(t)
	t.Setenv("PATH", t.TempDir())
	calls := noNativeRegistration(t)
	zipPath := filepath.Join(t.TempDir(), "extension.zip")
	if err := writeTestExtensionZIP(zipPath); err != nil {
		t.Fatal(err)
	}
	cmd := newRootCommand()
	var output bytes.Buffer
	cmd.SetOut(&output)
	cmd.SetArgs([]string{"setup", "--browser", "edge", "--zip", zipPath, "--no-open", "--path", testNativeBinary(t)})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"edge://extensions", "Load unpacked", "info --browser edge"} {
		if !strings.Contains(output.String(), want) {
			t.Fatalf("missing Edge setup instruction %q: %s", want, output.String())
		}
	}
	if strings.Contains(output.String(), "chrome://extensions") || strings.Contains(output.String(), "drag in") {
		t.Fatalf("Edge setup gave Chrome-only instructions: %s", output.String())
	}
	manifestPath, err := defaultNativeHostManifestPathForBrowser("edge")
	if err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err := json.Unmarshal(payload, &manifest); err != nil {
		t.Fatal(err)
	}
	expectedID, err := extensionIDFromPublicKey(betaExtensionPublicKey)
	if err != nil || !strings.Contains(string(payload), "chrome-extension://"+expectedID+"/") {
		t.Fatalf("native host origin does not match unpacked extension: %s, %v", payload, err)
	}
	if runtime.GOOS == "windows" && (len(*calls) != 1 || (*calls)[0][0] != `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\`+host.NativeHostName) {
		t.Fatalf("Edge ZIP setup registered the wrong browser: %v", *calls)
	}
	chromePath, err := defaultNativeHostManifestPathForBrowser("chrome")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(chromePath); !os.IsNotExist(err) {
		t.Fatalf("Edge ZIP setup wrote Chrome manifest: %v", err)
	}
}
