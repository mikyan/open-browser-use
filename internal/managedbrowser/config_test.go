package managedbrowser

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
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
		"manifest.json":          `{"manifest_version":3,"background":{"service_worker":"background.js","type":"module"},"permissions":["nativeMessaging"]}`,
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
