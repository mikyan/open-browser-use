package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestChromiumBrowserCatalogueNamespacesAndEnvironment(t *testing.T) {
	home, local, roaming, config := t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir()
	roots, err := browserCatalogueWithEnvironment("windows", home, local, roaming, config)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"brave":   filepath.Join(local, "BraveSoftware", "Brave-Browser", "User Data"),
		"vivaldi": filepath.Join(local, "Vivaldi", "User Data"),
		"opera":   filepath.Join(roaming, "Opera Software", "Opera Stable"),
	}
	var chrome nativeManifestInstallPlan
	for _, root := range roots {
		plan, err := planNativeManifestInstall("windows", home, local, root, "")
		if err != nil {
			t.Fatal(err)
		}
		if root.BrowserID == "chrome" {
			chrome = plan
		}
		if path, ok := want[root.BrowserID]; ok {
			if root.Root != path || plan != chrome {
				t.Fatalf("%s catalog = %#v / %#v; chrome %#v", root.BrowserID, root, plan, chrome)
			}
			if root.DirectProfile != (root.BrowserID == "opera") {
				t.Fatalf("unexpected direct layout: %#v", root)
			}
			delete(want, root.BrowserID)
		}
	}
	if len(want) != 0 {
		t.Fatalf("missing browsers: %v", want)
	}
	roots, err = browserCatalogueWithEnvironment("linux", home, local, roaming, config)
	if err != nil {
		t.Fatal(err)
	}
	for _, root := range roots {
		if !strings.HasPrefix(root.Root, config+string(filepath.Separator)) {
			t.Fatalf("ignored XDG_CONFIG_HOME: %#v", root)
		}
	}
}

func TestSharedNativeManifestPreservesOriginsAndRegisteredPath(t *testing.T) {
	isolatedBrowserHome(t)
	calls := noNativeRegistration(t)
	binary := testNativeBinary(t)
	first, err := installNativeManifestForBrowser(strings.Repeat("a", 32), binary, "", "chrome")
	if err != nil {
		t.Fatal(err)
	}
	registered := filepath.Join(t.TempDir(), "registered-host.json")
	data, _ := os.ReadFile(first)
	if err := os.WriteFile(registered, data, 0o600); err != nil {
		t.Fatal(err)
	}
	// The configured path, not merely the default path, is authoritative.
	readNativeHostRegistration = func(string) (string, error) { return registered, nil }
	selector := "chrome"
	if runtime.GOOS == "windows" {
		selector = "chrome-beta"
	}
	second, err := installNativeManifestForBrowser(strings.Repeat("b", 32), binary, "", selector)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" && second != registered {
		t.Fatalf("registered path lost: %q", second)
	}
	stable, _ := stableNativeHostPath()
	origins, err := ownedNativeManifestOrigins(second, stable)
	want := []string{"chrome-extension://" + strings.Repeat("a", 32) + "/", "chrome-extension://" + strings.Repeat("b", 32) + "/"}
	if err != nil || !reflect.DeepEqual(origins, want) {
		t.Fatalf("merged origins=%v err=%v", origins, err)
	}
	if runtime.GOOS == "windows" && ((*calls)[len(*calls)-1][1] != registered) {
		t.Fatal("registration did not retain owned path")
	}
}

func TestNativeManifestConflictsHaveNoInstallSideEffects(t *testing.T) {
	for _, mutate := range []string{"foreign-name", "foreign-path", "foreign-type", "wildcard", "unknown-field", "duplicate-key", "oversized-tail", "registered-missing", "registered-foreign", "registry-error"} {
		t.Run(mutate, func(t *testing.T) {
			isolatedBrowserHome(t)
			calls := noNativeRegistration(t)
			stable, _ := stableNativeHostPath()
			path, _ := defaultNativeHostManifestPath()
			manifest, _ := nativeManifest(strings.Repeat("a", 32), stable)
			switch mutate {
			case "foreign-name":
				manifest["name"] = "another.host"
			case "foreign-path":
				manifest["path"] = filepath.Join(t.TempDir(), "foreign.exe")
			case "foreign-type":
				manifest["type"] = "other"
			case "wildcard":
				manifest["allowed_origins"] = []string{"chrome-extension://*/"}
			case "unknown-field":
				manifest["unexpected"] = true
			}
			payload, _ := json.Marshal(manifest)
			if mutate == "duplicate-key" {
				payload = append([]byte(`{"type":"other",`), payload[1:]...)
			}
			if mutate == "oversized-tail" {
				payload = append(payload, bytes.Repeat([]byte(" "), 65537)...)
				payload = append(payload, []byte(`{"bad":true}`)...)
			}
			if strings.HasPrefix(mutate, "registered-") || mutate == "registry-error" {
				if runtime.GOOS != "windows" {
					t.Skip("Windows registry preflight")
				}
				other := filepath.Join(t.TempDir(), "registered.json")
				readNativeHostRegistration = func(string) (string, error) {
					if mutate == "registry-error" {
						return "", fmt.Errorf("registry denied")
					}
					return other, nil
				}
				if mutate == "registered-foreign" {
					os.WriteFile(other, []byte(`{"name":"foreign"}`), 0o600)
				}
			}
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, payload, 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := installNativeManifestForBrowser(strings.Repeat("b", 32), testNativeBinary(t), "", "chrome"); err == nil {
				t.Fatal("expected conflict")
			}
			after, _ := os.ReadFile(path)
			if !bytes.Equal(after, payload) || len(*calls) != 0 {
				t.Fatal("conflict mutated manifest/registration")
			}
			if _, err := os.Stat(filepath.Dir(stable)); !os.IsNotExist(err) {
				t.Fatalf("conflict prepared stable binary/lock: %v", err)
			}
		})
	}
}

func TestNativeManifestExportDoesNotMergeOrInspectRegistration(t *testing.T) {
	isolatedBrowserHome(t)
	calls := noNativeRegistration(t)
	readNativeHostRegistration = func(string) (string, error) { t.Fatal("export inspected registry"); return "", nil }
	path := filepath.Join(t.TempDir(), "export.json")
	if err := os.WriteFile(path, []byte(`{"name":"old unrelated export"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := installNativeManifestForBrowser(strings.Repeat("c", 32), testNativeBinary(t), path, "chrome"); err != nil {
		t.Fatal(err)
	}
	stable, _ := stableNativeHostPath()
	origins, err := ownedNativeManifestOrigins(path, stable)
	if err != nil || !reflect.DeepEqual(origins, []string{"chrome-extension://" + strings.Repeat("c", 32) + "/"}) || len(*calls) != 0 {
		t.Fatalf("export=%v %v", origins, err)
	}
}

func TestNativeManifestInstallationLockRejectsOverlapAndReleases(t *testing.T) {
	isolatedBrowserHome(t)
	noNativeRegistration(t)
	binary := testNativeBinary(t)
	first, err := prepareNativeManifestInstallation("", binary, "", "chrome")
	if err != nil {
		t.Fatal(err)
	}
	second, err := prepareNativeManifestInstallation("", binary, "", "chrome")
	if err == nil {
		second.unlock()
		first.unlock()
		t.Fatal("overlapping install was admitted")
	}
	first.unlock()
	third, err := prepareNativeManifestInstallation("", binary, "", "chrome")
	if err != nil {
		t.Fatal(err)
	}
	defer third.unlock()
	if _, err := third.install(""); err != nil {
		t.Fatal(err)
	}
}

func TestCopiedProfileInstanceCannotSelectBrowserOrUUID(t *testing.T) {
	isolatedBrowserHome(t)
	const instance = "11111111-aaaa-bbbb-cccc-1234567890ab"
	chrome, _ := browserRootForInstallSelector("chrome")
	writeExtensionStorageAtRoot(t, chrome.Root, "Default", defaultChromeExtensionID, instance)
	// Two files in one profile still resolve uniquely.
	storage := filepath.Join(chrome.Root, "Default", "Local Extension Settings", defaultChromeExtensionID)
	if err := os.WriteFile(filepath.Join(storage, "duplicate.ldb"), []byte(instance), 0o600); err != nil {
		t.Fatal(err)
	}
	if match, message := uniqueProfileForInstanceID(defaultChromeExtensionID, instance); match == nil || message != "" {
		t.Fatalf("single profile=%#v %s", match, message)
	}
	edge, _ := browserRootForInstallSelector("edge")
	writeExtensionStorageAtRoot(t, edge.Root, "Default", defaultChromeExtensionID, instance)
	payload := map[string]any{"result": map[string]any{"metadata": map[string]any{"extensionId": defaultChromeExtensionID, "extensionInstanceId": instance}}}
	info := connectedProfileFromInfo("test-endpoint", payload)
	if !strings.Contains(info.ResolutionError, "ambiguous") || info.Browser != "" || info.Target != "" {
		t.Fatalf("ambiguous profile=%#v", info)
	}
	if browserSelectorMatches("chrome", info) || browserSelectorMatches("edge", info) || profileSelectorMatches(instance, info) || profileSelectorMatches("Default", info) {
		t.Fatal("ambiguous profile was selected")
	}
	if _, _, _, _, _, ok := resolveProfileForInstanceID(defaultChromeExtensionID, instance); ok {
		t.Fatal("legacy resolver silently picked first profile")
	}
}

func TestOperaRootAndNestedProfilesAreExplicitAndUnique(t *testing.T) {
	root := browserProfileRoot{BrowserID: "opera", Root: t.TempDir(), DirectProfile: true}
	if err := os.WriteFile(filepath.Join(root.Root, "Preferences"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root.Root, "Default"), 0o700); err != nil {
		t.Fatal(err)
	}
	profiles, err := browserProfileDirs(root)
	if err != nil || len(profiles) != 2 {
		t.Fatalf("profiles=%v %v", profiles, err)
	}
	if browserProfileDirectory(root, root.Root) != "." || browserProfileDirectory(root, profiles[0]) != "Default" {
		t.Fatal("unstable root profile identity")
	}
	root.DirectProfile = false
	profiles, err = browserProfileDirs(root)
	if err != nil || len(profiles) != 1 {
		t.Fatalf("generic root guessed direct profile: %v %v", profiles, err)
	}
}

func TestNewBrowsersRejectAutomaticSetupBeforeMutation(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("all three Windows selectors")
	}
	for _, browser := range []string{"brave", "opera", "vivaldi"} {
		t.Run(browser, func(t *testing.T) {
			home := isolatedBrowserHome(t)
			calls := noNativeRegistration(t)
			for _, args := range [][]string{{"setup", "--browser", browser}, {"setup", "--browser", browser, "--zip", "nonexistent.zip"}} {
				command := newRootCommand()
				command.SetOut(&bytes.Buffer{})
				command.SetErr(&bytes.Buffer{})
				command.SetArgs(args)
				if err := command.Execute(); err == nil || !strings.Contains(err.Error(), "not implemented") {
					t.Fatalf("%v=%v", args, err)
				}
			}
			if _, err := installChromeExternalExtensionForBrowser("", filepath.Join(home, "external.json"), browser); err == nil {
				t.Fatal("external extension fallback")
			}
			entries, _ := os.ReadDir(home)
			if len(entries) != 0 || len(*calls) != 0 {
				t.Fatal("unsupported mode mutated installation")
			}
		})
	}
}

func TestZIPPreflightKeepsExistingUnpackedAndInputZIP(t *testing.T) {
	for _, capacity := range []bool{false, true} {
		t.Run(fmt.Sprint(capacity), func(t *testing.T) {
			isolatedBrowserHome(t)
			calls := noNativeRegistration(t)
			path := filepath.Join(t.TempDir(), "extension.zip")
			if err := writeTestExtensionZIP(path); err != nil {
				t.Fatal(err)
			}
			zipBefore, _ := os.ReadFile(path)
			unpacked, _ := defaultUnpackedExtensionDir()
			if err := os.MkdirAll(unpacked, 0o700); err != nil {
				t.Fatal(err)
			}
			sentinel := filepath.Join(unpacked, "existing-user-installation")
			if err := os.WriteFile(sentinel, []byte("keep"), 0o600); err != nil {
				t.Fatal(err)
			}
			stable, _ := stableNativeHostPath()
			manifestPath, _ := defaultNativeHostManifestPath()
			manifest, _ := nativeManifest("", stable)
			if capacity {
				origins := []string{"chrome-extension://" + defaultChromeExtensionID + "/"}
				for n := 0; len(origins) < 128; n++ {
					id := []byte(strings.Repeat("a", 32))
					id[30] = byte('a' + n/16)
					id[31] = byte('a' + n%16)
					origins = append(origins, "chrome-extension://"+string(id)+"/")
				}
				manifest["allowed_origins"] = origins
			} else {
				manifest["name"] = "foreign.host"
			}
			data, _ := json.Marshal(manifest)
			if err := os.MkdirAll(filepath.Dir(manifestPath), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(manifestPath, data, 0o600); err != nil {
				t.Fatal(err)
			}
			command := newRootCommand()
			command.SetOut(&bytes.Buffer{})
			command.SetErr(&bytes.Buffer{})
			command.SetArgs([]string{"setup", "--zip", path, "--no-open", "--path", testNativeBinary(t)})
			if err := command.Execute(); err == nil {
				t.Fatal("expected preflight failure")
			}
			zipAfter, _ := os.ReadFile(path)
			kept, _ := os.ReadFile(sentinel)
			if !bytes.Equal(zipBefore, zipAfter) || string(kept) != "keep" || len(*calls) != 0 {
				t.Fatal("preflight changed ZIP/unpacked/registry")
			}
			if _, err := os.Stat(filepath.Dir(stable)); !os.IsNotExist(err) {
				t.Fatalf("preflight prepared binary: %v", err)
			}
		})
	}
}

func TestKeyedZIPPreflightRejectsAliasedManifest(t *testing.T) {
	aliases := []string{"./manifest.json", "dir/../manifest.json"}
	if runtime.GOOS == "windows" {
		aliases = append(aliases, "MANIFEST.JSON", `.\manifest.json`, "manifest.json.", "manifest.json ", "manifest.json::$DATA")
	}
	for _, alias := range aliases {
		t.Run(alias, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "extension.zip")
			file, err := os.Create(path)
			if err != nil {
				t.Fatal(err)
			}
			writer := zip.NewWriter(file)
			for _, name := range []string{"manifest.json", alias} {
				entry, err := writer.Create(name)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := entry.Write([]byte(`{"manifest_version":3}`)); err != nil {
					t.Fatal(err)
				}
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			file.Close()
			if _, err := keyedExtensionIDFromZIP(path); err == nil {
				t.Fatal("accepted aliased manifest")
			}
		})
	}
}
