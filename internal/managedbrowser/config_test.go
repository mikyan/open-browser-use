package managedbrowser

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestOwnedDirectoryRefusesExistingUserContents(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows managed ownership")
	}
	root := t.TempDir()
	file := filepath.Join(root, "user-data.txt")
	if err := os.WriteFile(file, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := ownDirectory(root, ".owner.json", "test"); err == nil {
		t.Fatal("adopted nonempty unowned directory")
	}
	if data, err := os.ReadFile(file); err != nil || string(data) != "keep" {
		t.Fatalf("user data changed: %q, %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(root, ".owner.json")); !os.IsNotExist(err) {
		t.Fatalf("created owner record despite rejection: %v", err)
	}
}

func TestOwnedDirectoryDoesNotReplaceForeignOwner(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows managed ownership")
	}
	root := t.TempDir()
	if err := ownDirectory(root, ".owner.json", "first"); err != nil {
		t.Fatal(err)
	}
	if err := ownDirectory(root, ".owner.json", "second"); err == nil {
		t.Fatal("replaced another owner")
	}
	if err := ownDirectory(root, ".owner.json", "first"); err != nil {
		t.Fatal(err)
	}
}

func TestStagePreservesRuntimeAndChangesOnlyDeclaredConfiguration(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows managed paths")
	}
	root := t.TempDir()
	source, target := filepath.Join(root, "source"), filepath.Join(root, "target")
	if err := os.Mkdir(source, 0700); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"manifest.json":          `{"manifest_version":3,"version":"1.2.3","background":{"service_worker":"background.js","type":"module"},"permissions":["nativeMessaging"]}`,
		"background.js":          "original native backend",
		"managed-config.js":      "export default null;\n",
		"managed-native-host.js": "original resolver",
		"content.js":             "original renderer",
	}
	for file, value := range files {
		if err := os.WriteFile(filepath.Join(source, file), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	name := "com.openbrowseruse.managed.n" + strings.Repeat("a", 32)
	id, err := stageExtension(context.Background(), source, target, "dGVzdCBwdWJsaWMga2V5", name)
	if err != nil {
		t.Fatal(err)
	}
	if len(id) != 32 {
		t.Fatalf("extension id %q", id)
	}
	for file, value := range files {
		original, err := os.ReadFile(filepath.Join(source, file))
		if err != nil || string(original) != value {
			t.Fatalf("source %s modified", file)
		}
		if file == "manifest.json" || file == "managed-config.js" {
			continue
		}
		actual, err := os.ReadFile(filepath.Join(target, file))
		if err != nil || string(actual) != value {
			t.Fatalf("staged runtime %s differs", file)
		}
	}
	data, _ := os.ReadFile(filepath.Join(target, "managed-config.js"))
	if !strings.Contains(string(data), `"version":1`) || !strings.Contains(string(data), name) {
		t.Fatalf("configuration %s", data)
	}
	data, _ = os.ReadFile(filepath.Join(target, "manifest.json"))
	var manifest map[string]any
	if err := json.Unmarshal(data, &manifest); err != nil || manifest["key"] != "dGVzdCBwdWJsaWMga2V5" || !reflect.DeepEqual(manifest["permissions"], []any{"nativeMessaging"}) {
		t.Fatalf("manifest drift: %v %v", manifest, err)
	}
	if manifest["version_name"] != "1.2.3" || manifest["version"] == "1.2.3" {
		t.Fatalf("staged cache generation lost product display version: %v", manifest)
	}
	workerScript := "managed-worker-" + strings.Repeat("a", 32) + ".js"
	if !reflect.DeepEqual(manifest["background"], map[string]any{"service_worker": workerScript, "type": "module"}) {
		t.Fatalf("wrong managed worker entry: %v", manifest["background"])
	}
	data, err = os.ReadFile(filepath.Join(target, workerScript))
	if err != nil || string(data) != "import \"./background.js\";\n" {
		t.Fatalf("wrapper is not the static original worker import: %q, %v", data, err)
	}
	entries, err := os.ReadDir(target)
	if err != nil || len(entries) != len(files)+1 {
		t.Fatalf("unexpected staged files: %v, %v", entries, err)
	}
}

func TestStageUsesRunCacheGenerationWithStableExtensionIdentity(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows managed paths")
	}
	source := stagingSource(t, `"version":"1.2.3","version_name":"1.2.3 preview",`)
	names := []string{
		"com.openbrowseruse.managed.n00000000000000000000000000000001",
		"com.openbrowseruse.managed.n00000000000000000000000000000002",
		"com.openbrowseruse.managed.nffffffffffffffffffffffffffffffff",
	}
	versions := make(map[string]string)
	var extensionID string
	for _, nativeName := range append(names, names[0]) {
		target := filepath.Join(t.TempDir(), "extension")
		id, err := stageExtension(context.Background(), source, target, "dGVzdCBwdWJsaWMga2V5", nativeName)
		if err != nil {
			t.Fatal(err)
		}
		if extensionID != "" && id != extensionID {
			t.Fatal("cache generation changed extension identity")
		}
		extensionID = id
		data, err := os.ReadFile(filepath.Join(target, "manifest.json"))
		if err != nil {
			t.Fatal(err)
		}
		var manifest map[string]any
		if err := json.Unmarshal(data, &manifest); err != nil {
			t.Fatal(err)
		}
		version, ok := manifest["version"].(string)
		parts := strings.Split(version, ".")
		if !ok || len(parts) != 4 || version == "0.0.0.0" || manifest["version_name"] != "1.2.3 preview" {
			t.Fatalf("invalid cache generation/display: %v", manifest)
		}
		for _, part := range parts {
			value, err := strconv.ParseUint(part, 10, 16)
			if err != nil || strconv.FormatUint(value, 10) != part {
				t.Fatalf("invalid Chromium version component %q", part)
			}
		}
		for previousName, previousVersion := range versions {
			if (previousName == nativeName) != (previousVersion == version) {
				t.Fatalf("generation did not follow the full native name: %s / %s", nativeName, previousName)
			}
		}
		versions[nativeName] = version
		script := "managed-worker-" + strings.TrimPrefix(nativeName, "com.openbrowseruse.managed.n") + ".js"
		if manifest["background"].(map[string]any)["service_worker"] != script {
			t.Fatal("worker entry did not follow the full run ID")
		}
		entry, err := os.ReadFile(filepath.Join(target, script))
		if err != nil || string(entry) != "import \"./background.js\";\n" {
			t.Fatalf("missing static wrapper: %s, %v", entry, err)
		}
		config, err := os.ReadFile(filepath.Join(target, "managed-config.js"))
		if err != nil || !strings.Contains(string(config), nativeName) {
			t.Fatalf("full native identity missing: %s, %v", config, err)
		}
	}
	if len(versions) != len(names) {
		t.Fatal("missing staged run")
	}
}

func TestStageNeverOverwritesWorkerEntryCollision(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows managed paths")
	}
	runID := strings.Repeat("a", 32)
	script := "managed-worker-" + runID + ".js"
	for _, kind := range []string{"source", "source-case", "target"} {
		t.Run(kind, func(t *testing.T) {
			source := stagingSource(t, `"version":"1.2.3",`)
			target := filepath.Join(t.TempDir(), "extension")
			collision := filepath.Join(source, script)
			if kind == "source-case" {
				collision = filepath.Join(source, strings.ToUpper(script))
			} else if kind == "target" {
				if err := os.Mkdir(target, 0700); err != nil {
					t.Fatal(err)
				}
				collision = filepath.Join(target, script)
			}
			if err := os.WriteFile(collision, []byte("must remain"), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := stageExtension(context.Background(), source, target, "dGVzdCBwdWJsaWMga2V5", "com.openbrowseruse.managed.n"+runID); err == nil {
				t.Fatal("worker entry collision accepted")
			}
			data, err := os.ReadFile(collision)
			if err != nil || string(data) != "must remain" {
				t.Fatalf("colliding file overwritten: %q, %v", data, err)
			}
			if kind != "target" {
				if _, err := os.Stat(target); !os.IsNotExist(err) {
					t.Fatalf("source conflict copied runtime: %v", err)
				}
			}
		})
	}
}

func TestManagedWorkerScriptRejectsIncompleteRunIdentity(t *testing.T) {
	for _, runID := range []string{"", "../background", strings.Repeat("a", 31), strings.Repeat("a", 33), strings.Repeat("A", 32), strings.Repeat("g", 32)} {
		if script, err := managedWorkerScript(runID); err == nil || script != "" {
			t.Fatalf("invalid run identity %q produced %q: %v", runID, script, err)
		}
	}
}

func TestStageRejectsInvalidNativeHostBeforeCopying(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows managed paths")
	}
	source := stagingSource(t, `"version":"1.2.3",`)
	for _, name := range []string{"", "host", "com.openbrowseruse.managed.n" + strings.Repeat("a", 31), "com.openbrowseruse.managed.n" + strings.Repeat("a", 33), "com.openbrowseruse.managed.n" + strings.Repeat("A", 32), "com.openbrowseruse.managed.n" + strings.Repeat("z", 32)} {
		target := filepath.Join(t.TempDir(), "extension")
		if _, err := stageExtension(context.Background(), source, target, "dGVzdCBwdWJsaWMga2V5", name); err == nil || !strings.Contains(err.Error(), "native host name") {
			t.Fatalf("invalid native host %q: %v", name, err)
		}
		if _, err := os.Stat(target); !os.IsNotExist(err) {
			t.Fatalf("copied runtime for invalid native host: %v", err)
		}
	}
}

func TestStageDoesNotHideInvalidSourceVersion(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows managed paths")
	}
	for _, versionFields := range []string{``, `"version":1,`, `"version":"",`, `"version":"0.0.0.0",`, `"version":"1.2.3.4.5",`, `"version":"65536",`, `"version":"01.2.3",`, `"version":"+1",`, `"version":"1.0-preview",`, `"version":"1.2.3","version_name":1,`} {
		source := stagingSource(t, versionFields)
		if _, err := stageExtension(context.Background(), source, filepath.Join(t.TempDir(), "extension"), "dGVzdCBwdWJsaWMga2V5", "com.openbrowseruse.managed.n"+strings.Repeat("a", 32)); err == nil || !strings.Contains(err.Error(), "version") {
			t.Fatalf("invalid source version %s: %v", versionFields, err)
		}
	}
}

func TestStageAcceptsChromiumSourceVersionLimits(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows managed paths")
	}
	for _, version := range []string{"1", "0.1.0.0", "65535.65535.65535.65535"} {
		source := stagingSource(t, `"version":"`+version+`","version_name":"",`)
		target := filepath.Join(t.TempDir(), "extension")
		if _, err := stageExtension(context.Background(), source, target, "dGVzdCBwdWJsaWMga2V5", "com.openbrowseruse.managed.n"+strings.Repeat("a", 32)); err != nil {
			t.Fatalf("valid source version %q: %v", version, err)
		}
		data, err := os.ReadFile(filepath.Join(target, "manifest.json"))
		var manifest map[string]any
		if err != nil || json.Unmarshal(data, &manifest) != nil || manifest["version_name"] != version {
			t.Fatalf("source display version not retained: %s, %v", data, err)
		}
	}
}

func stagingSource(t *testing.T, versionFields string) string {
	t.Helper()
	source := t.TempDir()
	files := map[string]string{
		"manifest.json":          `{"manifest_version":3,` + versionFields + `"background":{"service_worker":"background.js","type":"module"},"permissions":["nativeMessaging"]}`,
		"background.js":          "original native backend",
		"managed-config.js":      "export default null;\n",
		"managed-native-host.js": "original resolver",
	}
	for file, value := range files {
		if err := os.WriteFile(filepath.Join(source, file), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return source
}

func TestStageCancellationDoesNotCopyRuntime(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows managed paths")
	}
	root := t.TempDir()
	source, target := filepath.Join(root, "source"), filepath.Join(root, "target")
	if err := os.Mkdir(source, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "original"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := stageExtension(ctx, source, target, "key", "host"); err != context.Canceled {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("created stage after canceled deadline: %v", err)
	}
}

func TestPrivateEnvironmentIsolatesNativeDiscovery(t *testing.T) {
	root := t.TempDir()
	t.Setenv("TEMP", "inherited-sensitive-temp")
	t.Setenv("TMP", "inherited-sensitive-tmp")
	t.Setenv("LOCALAPPDATA", "inherited-sensitive-local")
	t.Setenv("APPDATA", "inherited-sensitive-roaming")
	t.Setenv("USERPROFILE", "inherited-sensitive-profile")
	t.Setenv("HOME", "inherited-sensitive-home")
	env, err := privateEnvironment(root)
	if err != nil {
		t.Fatal(err)
	}
	wanted := map[string]string{"TEMP": "temp", "TMP": "temp", "LOCALAPPDATA": "local", "APPDATA": "roaming", "USERPROFILE": "user"}
	seen := make(map[string]int)
	for _, item := range env {
		key, value, _ := strings.Cut(item, "=")
		key = strings.ToUpper(key)
		if key == "HOME" {
			t.Fatal("retained HOME")
		}
		if dir, ok := wanted[key]; ok {
			seen[key]++
			if value != filepath.Join(root, dir) {
				t.Fatalf("foreign %s %s", key, value)
			}
		}
	}
	for key := range wanted {
		if seen[key] != 1 {
			t.Fatalf("override %s count %d", key, seen[key])
		}
	}
}
