package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func writeProfileExtensionPreferences(t *testing.T, profileDir string, tables map[string]any) {
	t.Helper()
	if err := os.MkdirAll(profileDir, 0o700); err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(map[string]any{"extensions": tables})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profileDir, "Secure Preferences"), payload, 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeUnpackedProfileManifest(t *testing.T, version string) string {
	t.Helper()
	dir := t.TempDir()
	payload, err := json.Marshal(map[string]any{"name": "Open Browser Use", "version": version})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), payload, 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestUnpackedExtensionPreferenceTableUsesCatalogueBrand(t *testing.T) {
	operaDir := writeUnpackedProfileManifest(t, "1.0.0")
	otherDir := writeUnpackedProfileManifest(t, "9.0.0")
	operaTable := map[string]any{defaultChromeExtensionID: map[string]any{
		"path": operaDir, "location": 4, "disable_reasons": []any{},
		"service_worker_registration_info": map[string]any{"version": "1.0.0"},
	}}
	otherTable := map[string]any{defaultChromeExtensionID: map[string]any{"path": otherDir}}
	for _, browser := range []string{"chrome", "chrome-beta", "edge", "brave", "vivaldi", "bitbrowser", "opera"} {
		t.Run(browser, func(t *testing.T) {
			profile := t.TempDir()
			writeProfileExtensionPreferences(t, profile, map[string]any{"opsettings": operaTable})
			got, ok := detectExtensionInProfile(browser, profile, defaultChromeExtensionID)
			if ok != (browser == "opera") || (ok && got.Source != filepath.Join(operaDir, "manifest.json")) {
				t.Fatalf("Opera-only table crossed brand boundary: got %#v, %v", got, ok)
			}

			writeProfileExtensionPreferences(t, profile, map[string]any{"settings": otherTable})
			got, ok = detectExtensionInProfile(browser, profile, defaultChromeExtensionID)
			if ok != (browser != "opera") || (ok && got.Version != "9.0.0") {
				t.Fatalf("standard table crossed brand boundary: got %#v, %v", got, ok)
			}

			writeProfileExtensionPreferences(t, profile, map[string]any{"settings": otherTable, "opsettings": operaTable})
			got, ok = detectExtensionInProfile(browser, profile, defaultChromeExtensionID)
			wantDir := otherDir
			if browser == "opera" {
				wantDir = operaDir
			}
			if !ok || got.Source != filepath.Join(wantDir, "manifest.json") {
				t.Fatalf("conflicting tables did not honor catalogue brand: got %#v, %v", got, ok)
			}
		})
	}
}

func TestOperaUnpackedPreferencesRequireExtensionPathAndManifest(t *testing.T) {
	for _, test := range []struct {
		name  string
		entry map[string]any
		found bool
	}{
		{"missing path", map[string]any{"manifest": map[string]any{"version": "1.0.0"}}, false},
		{"blank path", map[string]any{"path": " ", "manifest": map[string]any{"version": "1.0.0"}}, false},
		{"missing manifest", map[string]any{"path": t.TempDir(), "service_worker_registration_info": map[string]any{"version": "1.0.0"}}, false},
		{"embedded manifest", map[string]any{"path": t.TempDir(), "manifest": map[string]any{"version": "1.0.0"}}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			profile := t.TempDir()
			writeProfileExtensionPreferences(t, profile, map[string]any{
				"opsettings": map[string]any{defaultChromeExtensionID: test.entry},
			})
			got, ok := detectExtensionInProfile("opera", profile, defaultChromeExtensionID)
			if ok != test.found || (ok && (got.Version != "1.0.0" || got.Source != filepath.Join(profile, "Secure Preferences"))) {
				t.Fatalf("got %#v, %v; want found %v", got, ok, test.found)
			}
		})
	}
}

func TestOperaUnpackedProfileDiscoveryDefaultAndDirectRoot(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Opera catalogue support is currently Windows-only")
	}
	for _, directory := range []string{"Default", "."} {
		t.Run(directory, func(t *testing.T) {
			isolatedBrowserHome(t)
			root, err := browserRootForInstallSelector("opera")
			if err != nil {
				t.Fatal(err)
			}
			unpackedDir := writeUnpackedProfileManifest(t, "1.0.0")
			profile := filepath.Join(root.Root, directory)
			// Reduced shape from a real Opera Secure Preferences record: no
			// extensions.settings or embedded manifest, only opsettings + path.
			writeProfileExtensionPreferences(t, profile, map[string]any{
				"opsettings": map[string]any{defaultChromeExtensionID: map[string]any{
					"path": unpackedDir, "location": 4, "disable_reasons": []any{},
					"service_worker_registration_info": map[string]any{"version": "1.0.0"},
				}},
			})
			writeExtensionStorageAtRoot(t, root.Root, directory, defaultChromeExtensionID, "opera-profile-instance")
			profiles, err := listInstalledChromeProfiles()
			if err != nil || len(profiles) != 1 {
				t.Fatalf("installed profiles = %#v, %v", profiles, err)
			}
			got := profiles[0]
			if got.Browser != "opera" || got.Directory != directory || got.Target != "opera:"+directory ||
				got.ExtensionID != defaultChromeExtensionID || got.Version != "1.0.0" || got.Source != filepath.Join(unpackedDir, "manifest.json") {
				t.Fatalf("incorrect Opera profile identity: %#v", got)
			}
			detected, ok := detectInstalledChromeExtensionByID(defaultChromeExtensionID)
			if !ok || detected.Version != "1.0.0" || detected.Source != got.Source {
				t.Fatalf("extension status missed the installed Opera extension: %#v, %v", detected, ok)
			}
			browser, _, _, resolvedDir, _, ok := resolveProfileForInstanceID(defaultChromeExtensionID, "opera-profile-instance")
			if !ok || browser != "opera" || resolvedDir != directory {
				t.Fatalf("connected profile identity = %q/%q, %v", browser, resolvedDir, ok)
			}
		})
	}
}
