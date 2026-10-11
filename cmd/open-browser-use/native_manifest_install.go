package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/ifuryst/open-browser-use/internal/host"
)

// Read the same key that pinUnpackedExtensionKey will use without replacing an
// installed extension or rewriting the supplied ZIP before native preflight.
func keyedExtensionIDFromZIP(path string) (string, error) {
	reader, err := zip.OpenReader(path)
	if err != nil {
		return "", err
	}
	defer reader.Close()
	var manifest *zip.File
	for _, file := range reader.File {
		if runtime.GOOS == "windows" {
			for _, part := range strings.Split(strings.ReplaceAll(file.Name, `\`, "/"), "/") {
				if strings.Contains(part, ":") || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") {
					return "", errors.New("extension ZIP contains a path with ambiguous Windows normalization")
				}
			}
		}
		if samePath(filepath.Join(filepath.Dir(path), file.Name), filepath.Join(filepath.Dir(path), "manifest.json")) {
			if file.Name != "manifest.json" {
				return "", errors.New("extension ZIP contains an aliased root manifest.json")
			}
			if manifest != nil {
				return "", errors.New("extension ZIP contains duplicate manifest.json")
			}
			manifest = file
		}
	}
	if manifest == nil {
		return "", errors.New("extension ZIP has no root manifest.json")
	}
	file, err := manifest.Open()
	if err != nil {
		return "", err
	}
	defer file.Close()
	payload, err := io.ReadAll(io.LimitReader(file, (1<<20)+1))
	if err != nil || len(payload) > 1<<20 {
		return "", errors.New("cannot read bounded extension ZIP manifest")
	}
	var fields map[string]any
	if err := json.Unmarshal(payload, &fields); err != nil {
		return "", err
	}
	key, _ := fields["key"].(string)
	if strings.TrimSpace(key) == "" {
		key = betaExtensionPublicKey
	}
	return extensionIDFromPublicKey(key)
}

// Installation is serialized around the shared stable executable as well as
// the manifest. The OS releases this lock when an interrupted installer exits.
type nativeManifestInstallation struct {
	plan           nativeManifestInstallPlan
	target, stable string
	export         bool
	unlock         func()
}

var readNativeHostRegistration = nativeHostRegistration

func prepareNativeManifestInstallation(extensionID, binaryPath, outputPath, selector string) (*nativeManifestInstallation, error) {
	plan, err := nativeManifestPlanForBrowser(selector, outputPath)
	if err != nil {
		return nil, err
	}
	target, err := resolveNativeHostTarget(binaryPath)
	if err != nil {
		return nil, err
	}
	stable, err := stableNativeHostPath()
	if err != nil {
		return nil, err
	}
	i := &nativeManifestInstallation{plan: plan, target: target, stable: stable, export: outputPath != ""}
	// Reject conflicts before making directories, replacing the executable, or
	// unpacking a ZIP. Recheck under the lock to close concurrent setup races.
	if _, _, err := i.manifest(extensionID); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(stable), 0o700); err != nil {
		return nil, err
	}
	i.unlock, err = lockNativeInstallation(stable + ".install.lock")
	if err != nil {
		return nil, fmt.Errorf("native host installation is busy or cannot be locked: %w", err)
	}
	if _, _, err := i.manifest(extensionID); err != nil {
		i.unlock()
		return nil, err
	}
	return i, nil
}

func (i *nativeManifestInstallation) manifest(extensionID string) (string, map[string]any, error) {
	manifest, err := nativeManifest(extensionID, i.stable)
	if err != nil {
		return "", nil, err
	}
	path := i.plan.ManifestPath
	if i.export {
		return path, manifest, nil
	}
	paths := []string{path}
	if i.plan.RegistryKey != "" {
		registered, err := readNativeHostRegistration(i.plan.RegistryKey)
		if err != nil {
			return "", nil, fmt.Errorf("native host registration conflict: %w", err)
		}
		if registered != "" {
			if !filepath.IsAbs(registered) {
				return "", nil, errors.New("native host registration has a non-absolute manifest path")
			}
			path = registered
			if !samePath(registered, i.plan.ManifestPath) {
				paths = append(paths, registered)
			}
			if _, err := os.Stat(registered); err != nil {
				return "", nil, fmt.Errorf("registered native host manifest: %w", err)
			}
		}
	}
	origins := map[string]bool{}
	for _, origin := range manifest["allowed_origins"].([]string) {
		origins[origin] = true
	}
	for _, existingPath := range paths {
		existing, err := ownedNativeManifestOrigins(existingPath, i.stable)
		if err != nil {
			return "", nil, err
		}
		for _, origin := range existing {
			origins[origin] = true
		}
	}
	if len(origins) > 128 {
		return "", nil, errors.New("native host manifest exceeds 128 allowed origins")
	}
	merged := make([]string, 0, len(origins))
	for origin := range origins {
		merged = append(merged, origin)
	}
	sort.Strings(merged)
	manifest["allowed_origins"] = merged
	return path, manifest, nil
}

func ownedNativeManifestOrigins(path, stable string) ([]string, error) {
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	conflict := func() ([]string, error) {
		return nil, fmt.Errorf("native host manifest conflict at %q: expected an owned stdio manifest with the same stable host path and valid extension origins", path)
	}
	payload, err := io.ReadAll(io.LimitReader(file, 65537))
	if err != nil || len(payload) > 65536 {
		return conflict()
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	// Decode fields explicitly to reject duplicate keys as well as unknown ones.
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return conflict()
	}
	fields := map[string]json.RawMessage{}
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return conflict()
		}
		name, ok := key.(string)
		if !ok || fields[name] != nil {
			return conflict()
		}
		switch name {
		case "name", "type", "path", "description", "allowed_origins":
		default:
			return conflict()
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return conflict()
		}
		fields[name] = value
	}
	if _, err := decoder.Token(); err != nil {
		return conflict()
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF || decoder.InputOffset() > 65536 {
		return conflict()
	}
	var name, kind, executable, description string
	var origins []string
	if json.Unmarshal(fields["name"], &name) != nil || json.Unmarshal(fields["type"], &kind) != nil ||
		json.Unmarshal(fields["path"], &executable) != nil || json.Unmarshal(fields["description"], &description) != nil ||
		json.Unmarshal(fields["allowed_origins"], &origins) != nil || name != host.NativeHostName || kind != "stdio" ||
		!filepath.IsAbs(executable) || !samePath(executable, stable) || len(origins) == 0 || len(origins) > 128 {
		return conflict()
	}
	for _, origin := range origins {
		id := strings.TrimSuffix(strings.TrimPrefix(origin, "chrome-extension://"), "/")
		if !validNativeExtensionID(id) || origin != "chrome-extension://"+id+"/" {
			return conflict()
		}
	}
	return origins, nil
}

func validNativeExtensionID(id string) bool {
	if len(id) != 32 {
		return false
	}
	for _, character := range id {
		if character < 'a' || character > 'p' {
			return false
		}
	}
	return true
}

func (i *nativeManifestInstallation) install(extensionID string) (string, error) {
	path, manifest, err := i.manifest(extensionID)
	if err != nil {
		return "", err
	}
	payload, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return "", err
	}
	if err := installStableNativeHostLink(i.target, i.stable); err != nil {
		return "", err
	}
	if err := writeNativeManifest(path, append(payload, '\n')); err != nil {
		return "", err
	}
	if i.plan.RegistryKey != "" {
		if err := registerNativeHostManifest(i.plan.RegistryKey, path); err != nil {
			return "", fmt.Errorf("failed to register native messaging host %q: %w", i.plan.RegistryKey, err)
		}
	}
	return path, nil
}

func writeNativeManifest(path string, payload []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".native-manifest-*")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if _, err := file.Write(payload); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return replaceNativeManifest(temporary, path)
}
