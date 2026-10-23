//go:build windows

package managedbrowser

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func ownedStartDirectories(t *testing.T, config SetupConfig) (string, string) {
	t.Helper()
	nameDir := filepath.Join(config.Root, config.Name)
	profileDir := filepath.Join(nameDir, "profile")
	for _, entry := range []struct{ path, marker, owner string }{
		{config.Root, ".managed-root.json", "open-browser-use-managed-v1"},
		{nameDir, ".managed-name.json", config.Name},
		{profileDir, ".managed-profile.json", config.Name},
	} {
		if err := ownDirectory(entry.path, entry.marker, entry.owner); err != nil {
			t.Fatal(err)
		}
	}
	return nameDir, profileDir
}

func historicalRunJunction(t *testing.T, parent, target string) string {
	t.Helper()
	if err := os.MkdirAll(parent, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(parent, "runtime-cache-link")
	createPlatformTestJunction(t, link, target)
	// Remove only the test junction itself, never its target or descendants.
	t.Cleanup(func() {
		if err := os.Remove(link); err != nil {
			t.Error(err)
		}
	})
	return link
}

func TestManagedLaunchDoesNotConsumeHistoricalRunEnvironment(t *testing.T) {
	config := setupTestConfig(t, "close")
	nameDir, profileDir := ownedStartDirectories(t, config)
	oldRun := filepath.Join(nameDir, "runs", strings.Repeat("a", 32))
	outside := t.TempDir()
	link := historicalRunJunction(t, filepath.Join(oldRun, "user", "cache"), outside)
	files := map[string]string{
		filepath.Join(oldRun, "original-receipt.json"):    `{"keep":"old run"}`,
		filepath.Join(profileDir, "persistent-site-data"): "keep profile",
		filepath.Join(outside, "untouched"):               "never an input to the next run",
	}
	for path, content := range files {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	linkTarget, err := os.Readlink(link)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateTree(oldRun); err == nil {
		t.Fatal("historical fixture must contain a real rejected reparse point")
	}
	// The existing helper is this Go test executable, not a browser. This tests
	// the public StartSetup path and real profile lock without launching Chrome.
	s := startSetupTest(t, config)
	if s.info.ProfileDir != profileDir || s.info.RunDir == oldRun || filepath.Dir(s.info.RunDir) != filepath.Dir(oldRun) {
		t.Fatalf("new run did not isolate its environment: %+v", s.info)
	}
	if _, err := StartSetup(context.Background(), config); err == nil || !strings.Contains(err.Error(), "profile is unavailable") {
		t.Fatalf("historical data bypassed original profile lock: %v", err)
	}
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertSetupClosed(t, s, false)
	for path, content := range files {
		if data, err := os.ReadFile(path); err != nil || string(data) != content {
			t.Fatalf("original file changed: %s: %q, %v", path, data, err)
		}
	}
	if actual, err := os.Readlink(link); err != nil || actual != linkTarget {
		t.Fatalf("historical junction changed: %q, %v", actual, err)
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 1 || entries[0].Name() != "untouched" {
		t.Fatalf("new run wrote through historical junction: %v, %v", entries, err)
	}
}

func TestManagedLaunchRejectsConsumedReparsePaths(t *testing.T) {
	for _, kind := range []string{"root", "name", "root-marker", "name-marker", "profile", "profile-marker", "profile-child", "runs"} {
		t.Run(kind, func(t *testing.T) {
			config := setupTestConfig(t, "close")
			nameDir := filepath.Join(config.Root, config.Name)
			profileDir := filepath.Join(nameDir, "profile")
			if kind != "root" && kind != "root-marker" {
				if err := ownDirectory(config.Root, ".managed-root.json", "open-browser-use-managed-v1"); err != nil {
					t.Fatal(err)
				}
			}
			if kind != "root" && kind != "root-marker" && kind != "name" && kind != "name-marker" {
				if err := ownDirectory(nameDir, ".managed-name.json", config.Name); err != nil {
					t.Fatal(err)
				}
			}
			if kind == "profile-child" || kind == "runs" {
				if err := ownDirectory(profileDir, ".managed-profile.json", config.Name); err != nil {
					t.Fatal(err)
				}
			}
			paths := map[string]string{
				"root": config.Root, "name": nameDir, "profile": profileDir,
				"root-marker":    filepath.Join(config.Root, ".managed-root.json"),
				"name-marker":    filepath.Join(nameDir, ".managed-name.json"),
				"profile-marker": filepath.Join(profileDir, ".managed-profile.json"),
				"profile-child":  filepath.Join(profileDir, "nested-cache"),
				"runs":           filepath.Join(nameDir, "runs"),
			}
			link, target := paths[kind], t.TempDir()
			if err := os.MkdirAll(filepath.Dir(link), 0o700); err != nil {
				t.Fatal(err)
			}
			createPlatformTestJunction(t, link, target)
			t.Cleanup(func() { _ = os.Remove(link) })
			s, err := StartSetup(context.Background(), config)
			if s != nil {
				_ = s.Close(context.Background())
				t.Fatal("launched through a consumed reparse point")
			}
			if err == nil || !strings.Contains(err.Error(), "reparse points") {
				t.Fatalf("%s was not rejected as a reparse point: %v", kind, err)
			}
			entries, err := os.ReadDir(target)
			if err != nil || len(entries) != 0 {
				t.Fatalf("rejected start changed reparse target: %v, %v", entries, err)
			}
		})
	}
}

func TestManagedProfileTreeIsValidatedOnlyAfterLock(t *testing.T) {
	config := setupTestConfig(t, "close")
	nameDir, profileDir := ownedStartDirectories(t, config)
	lock, err := platformLock(nameDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lock.Close() })
	historicalRunJunction(t, profileDir, t.TempDir())
	if _, err := StartSetup(context.Background(), config); err == nil || !strings.Contains(err.Error(), "profile is unavailable") {
		t.Fatalf("inspected live profile before acquiring its lock: %v", err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := StartSetup(context.Background(), config); err == nil || !strings.Contains(err.Error(), "reparse points") {
		t.Fatalf("reused profile tree escaped validation after lock release: %v", err)
	}
}

func TestManagedExtensionSourceStillRejectsNestedReparse(t *testing.T) {
	source, target := t.TempDir(), filepath.Join(t.TempDir(), "staged")
	historicalRunJunction(t, source, t.TempDir())
	_, err := stageExtension(context.Background(), source, target, "dGVzdCBwdWJsaWMga2V5", "com.openbrowseruse.managed.n"+strings.Repeat("b", 32))
	if err == nil || !strings.Contains(err.Error(), "reparse points") {
		t.Fatalf("consumed extension source escaped full tree validation: %v", err)
	}
	if _, err := os.Lstat(target); !os.IsNotExist(err) {
		t.Fatalf("invalid extension created staging: %v", err)
	}
}
