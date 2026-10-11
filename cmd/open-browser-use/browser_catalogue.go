package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/ifuryst/open-browser-use/internal/host"
)

// browserCatalogue describes verified default user-data roots, without reading
// profiles or changing the filesystem. Custom and portable roots need explicit
// discovery support; do not infer them from another Chromium browser's layout.
func browserCatalogue(goos, home, localAppData string) ([]browserProfileRoot, error) {
	return browserCatalogueWithEnvironment(goos, home, localAppData, "", "")
}

func browserCatalogueWithEnvironment(goos, home, localAppData, roamingAppData, configHome string) ([]browserProfileRoot, error) {
	if strings.TrimSpace(localAppData) == "" {
		localAppData = filepath.Join(home, "AppData", "Local")
	}
	if strings.TrimSpace(roamingAppData) == "" {
		roamingAppData = filepath.Join(home, "AppData", "Roaming")
	}
	if !filepath.IsAbs(configHome) {
		configHome = filepath.Join(home, ".config")
	}
	switch goos {
	case "windows":
		return []browserProfileRoot{
			{BrowserID: "chrome", BrowserName: "Google Chrome", Root: filepath.Join(localAppData, "Google", "Chrome", "User Data")},
			{BrowserID: "chrome-beta", BrowserName: "Google Chrome Beta", Root: filepath.Join(localAppData, "Google", "Chrome Beta", "User Data")},
			{BrowserID: "brave", BrowserName: "Brave", Root: filepath.Join(localAppData, "BraveSoftware", "Brave-Browser", "User Data")},
			{BrowserID: "vivaldi", BrowserName: "Vivaldi", Root: filepath.Join(localAppData, "Vivaldi", "User Data")},
			{BrowserID: "opera", BrowserName: "Opera", Root: filepath.Join(roamingAppData, "Opera Software", "Opera Stable"), DirectProfile: true},
			{BrowserID: "edge", BrowserName: "Microsoft Edge", Root: filepath.Join(localAppData, "Microsoft", "Edge", "User Data")},
		}, nil
	case "darwin":
		return []browserProfileRoot{
			{BrowserID: "chrome", BrowserName: "Google Chrome", Root: filepath.Join(home, "Library", "Application Support", "Google", "Chrome")},
			{BrowserID: "chrome-beta", BrowserName: "Google Chrome Beta", Root: filepath.Join(home, "Library", "Application Support", "Google", "Chrome Beta")},
			{BrowserID: "edge", BrowserName: "Microsoft Edge", Root: filepath.Join(home, "Library", "Application Support", "Microsoft Edge")},
		}, nil
	case "linux":
		return []browserProfileRoot{
			{BrowserID: "chrome", BrowserName: "Google Chrome", Root: filepath.Join(configHome, "google-chrome")},
			{BrowserID: "brave", BrowserName: "Brave", Root: filepath.Join(configHome, "BraveSoftware", "Brave-Browser")},
			{BrowserID: "edge", BrowserName: "Microsoft Edge", Root: filepath.Join(configHome, "microsoft-edge")},
		}, nil
	default:
		return nil, fmt.Errorf("browser profile detection is not implemented for %s", goos)
	}
}

type nativeManifestInstallPlan struct {
	ManifestPath string
	RegistryKey  string
}

// The caller resolves the browser selector before constructing this plan. An
// explicit output exports a manifest and deliberately does not register it.
func planNativeManifestInstall(goos, home, localAppData string, browser browserProfileRoot, output string) (nativeManifestInstallPlan, error) {
	if output != "" {
		absolute, err := filepath.Abs(output)
		return nativeManifestInstallPlan{ManifestPath: absolute}, err
	}
	filename := host.NativeHostName + ".json"
	switch goos {
	case "darwin", "linux":
		return nativeManifestInstallPlan{ManifestPath: filepath.Join(browser.Root, "NativeMessagingHosts", filename)}, nil
	case "windows":
		if strings.TrimSpace(localAppData) == "" {
			localAppData = filepath.Join(home, "AppData", "Local")
		}
		directory := filepath.Join(localAppData, "OpenBrowserUse", "NativeMessagingHosts")
		var registry string
		switch browser.BrowserID {
		case "chrome", "chrome-beta", "brave", "opera", "vivaldi":
			// Chrome channels share the documented native-host registry namespace.
			// Preserve the existing manifest location for installed Chrome users.
			registry = `HKCU\Software\Google\Chrome\NativeMessagingHosts\`
		case "edge":
			registry = `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\`
			directory = filepath.Join(directory, "edge")
		default:
			return nativeManifestInstallPlan{}, fmt.Errorf("native host registration is not implemented for %s on Windows", browser.BrowserID)
		}
		absolute, err := filepath.Abs(filepath.Join(directory, filename))
		return nativeManifestInstallPlan{ManifestPath: absolute, RegistryKey: registry + host.NativeHostName}, err
	default:
		return nativeManifestInstallPlan{}, fmt.Errorf("default manifest install path is not implemented for %s; pass --output", goos)
	}
}

func manualOnlyBrowser(id string) bool {
	switch id {
	case "edge", "brave", "opera", "vivaldi":
		return true
	}
	return false
}

func browserProfileDirs(root browserProfileRoot) ([]string, error) {
	profiles, err := chromeProfileDirs(root.Root)
	if err != nil {
		return nil, err
	}
	if root.DirectProfile {
		for _, name := range []string{"Preferences", "Secure Preferences"} {
			if info, err := os.Stat(filepath.Join(root.Root, name)); err == nil && info.Mode().IsRegular() {
				profiles = append(profiles, root.Root)
				break
			}
		}
	}
	return profiles, nil
}

func browserProfileDirectory(root browserProfileRoot, profile string) string {
	if samePath(root.Root, profile) {
		return "."
	}
	return filepath.Base(profile)
}
