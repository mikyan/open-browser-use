package managedbrowser

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Config describes one explicitly isolated browser. It never selects an
// installed browser profile or falls back to global host discovery.
type Config struct {
	Root, Name, BrowserPath, ExtensionDir, HostPath, ExtensionPublicKey string
	StartupTimeout                                                      time.Duration
	// RestoreLastSession requests native restore in this dedicated profile.
	// It does not reuse the old run, page handles or task permissions.
	RestoreLastSession bool
}

// SetupConfig opens only the dedicated profile for explicit human use. There
// is no task extension, host, input API or initial website URL in this mode.
type SetupConfig struct {
	Root, Name, BrowserPath string
	StartupTimeout          time.Duration
}

var managedName = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,47}$`)
var stagedNativeName = regexp.MustCompile(`^com\.openbrowseruse\.managed\.n[0-9a-f]{32}$`)

func validateConfig(c Config) (Config, error) {
	return validateLaunchConfig(c, false)
}

func validateLaunchConfig(c Config, setup bool) (Config, error) {
	if !managedName.MatchString(c.Name) || reservedName(c.Name) {
		return c, errors.New("managed name must be 1–48 lowercase letters, digits, underscores or hyphens, starting with a letter, and not a Windows device name")
	}
	paths := map[string]*string{"root": &c.Root, "browser": &c.BrowserPath}
	if !setup {
		paths["extension"], paths["host"] = &c.ExtensionDir, &c.HostPath
	}
	for label, value := range paths {
		if strings.TrimSpace(*value) == "" {
			return c, fmt.Errorf("managed %s path is required", label)
		}
		absolute, err := filepath.Abs(*value)
		if err != nil {
			return c, err
		}
		if err := platformValidatePath(absolute); err != nil {
			return c, fmt.Errorf("managed %s path: %w", label, err)
		}
		*value = filepath.Clean(absolute)
	}
	executables := []string{c.BrowserPath}
	if !setup {
		executables = append(executables, c.HostPath)
	}
	for _, file := range executables {
		info, err := os.Stat(file)
		if err != nil {
			return c, err
		}
		if !info.Mode().IsRegular() {
			return c, fmt.Errorf("managed executable is not a regular file: %s", file)
		}
	}
	if c.StartupTimeout == 0 {
		c.StartupTimeout = 45 * time.Second
	}
	if c.StartupTimeout < time.Second || c.StartupTimeout > 2*time.Minute {
		return c, errors.New("managed startup timeout must be between 1s and 2m")
	}
	return c, nil
}

func reservedName(name string) bool {
	upper := strings.ToUpper(name)
	if upper == "CON" || upper == "PRN" || upper == "AUX" || upper == "NUL" {
		return true
	}
	return len(upper) == 4 && (strings.HasPrefix(upper, "COM") || strings.HasPrefix(upper, "LPT")) && upper[3] >= '1' && upper[3] <= '9'
}

func randomID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(value[:]), nil
}

// A marker is an ownership record, not authentication against another process
// running as the same OS user. Unknown nonempty directories are never adopted.
// Validate only this directory and its marker. Historical runs are not inputs to
// a new run; callers must validate any descendant tree they actually reuse.
func ownDirectory(directory, marker, name string) error {
	if err := platformValidatePath(directory); err != nil {
		return err
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	file := filepath.Join(directory, marker)
	want, _ := json.Marshal(struct {
		Version int    `json:"version"`
		Name    string `json:"name"`
	}{1, name})
	got, err := readSmallFile(file, 4096)
	if err == nil {
		if string(got) != string(want) {
			return fmt.Errorf("managed ownership record does not match: %s", file)
		}
		return platformProtectDirectory(directory)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	if len(entries) != 0 {
		return fmt.Errorf("refusing unknown nonempty managed directory: %s", directory)
	}
	if err := platformProtectDirectory(directory); err != nil {
		return err
	}
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, writeErr := f.Write(want)
	return errors.Join(writeErr, f.Close())
}

func validateTree(root string) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("managed trees cannot contain links: %s", path)
		}
		if err := platformValidatePath(path); err != nil {
			return err
		}
		if !entry.IsDir() {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return fmt.Errorf("managed tree contains a nonregular file: %s", path)
			}
		}
		return nil
	})
}

func copyRegular(ctx context.Context, source, target string) error {
	if err := contextError(ctx); err != nil {
		return err
	}
	if err := platformValidatePath(source); err != nil {
		return err
	}
	f, err := os.Open(source)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("not a regular file: %s", source)
	}
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	// Check the original setup budget between bounded disk reads. A growing
	// source cannot make staging continue past its initially observed length.
	_, copyErr := io.CopyN(out, &contextReader{ctx: ctx, reader: f}, info.Size())
	return errors.Join(copyErr, out.Close())
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := contextError(r.ctx); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

func stageExtension(ctx context.Context, source, target, key, nativeName string) (string, error) {
	if err := contextError(ctx); err != nil {
		return "", err
	}
	if !stagedNativeName.MatchString(nativeName) {
		return "", errors.New("managed extension requires a run-specific native host name")
	}
	workerScript, err := managedWorkerScript(strings.TrimPrefix(nativeName, "com.openbrowseruse.managed.n"))
	if err != nil {
		return "", err
	}
	info, err := os.Stat(source)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("managed extension directory is not a directory")
	}
	if err := validateTree(source); err != nil {
		return "", err
	}
	if _, err := os.Lstat(filepath.Join(source, workerScript)); err == nil {
		return "", errors.New("managed worker entry conflicts with a source file")
	} else if !os.IsNotExist(err) {
		return "", err
	}
	const workerEntry = "import \"./background.js\";\n"
	var files int
	var bytes int64
	err = filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := contextError(ctx); err != nil {
			return err
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		out := filepath.Join(target, rel)
		if entry.IsDir() {
			return os.MkdirAll(out, 0o700)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		files++
		bytes += info.Size()
		if files+1 > 8192 || bytes+int64(len(workerEntry)) > 512<<20 {
			return errors.New("managed extension exceeds staging limits")
		}
		return copyRegular(ctx, path, out)
	})
	if err != nil {
		return "", err
	}
	manifestPath := filepath.Join(target, "manifest.json")
	payload, err := os.ReadFile(manifestPath)
	if err != nil {
		return "", err
	}
	var manifest map[string]any
	if len(payload) > 1<<20 || json.Unmarshal(payload, &manifest) != nil || manifest["manifest_version"] != float64(3) {
		return "", errors.New("managed extension requires a valid Manifest V3 manifest")
	}
	version, ok := manifest["version"].(string)
	if !validExtensionVersion(version) {
		return "", errors.New("managed extension requires a valid source version")
	}
	displayVersion := version
	if display, exists := manifest["version_name"]; exists {
		name, ok := display.(string)
		if !ok {
			return "", errors.New("managed extension version_name must be a string")
		}
		if name != "" {
			displayVersion = name
		}
	}
	background, ok := manifest["background"].(map[string]any)
	if !ok || background["service_worker"] != "background.js" || background["type"] != "module" {
		return "", errors.New("managed extension requires the Open Browser Use module service worker")
	}
	for _, required := range []string{"background.js", "managed-config.js", "managed-native-host.js"} {
		if info, err := os.Stat(filepath.Join(target, required)); err != nil || !info.Mode().IsRegular() {
			return "", fmt.Errorf("built extension is missing %s", required)
		}
	}
	if key == "" {
		key, _ = manifest["key"].(string)
	}
	id, err := extensionID(key)
	if err != nil {
		return "", err
	}
	manifest["key"] = key
	// Chromium reuses registered service-worker modules when the manifest
	// version is unchanged, even when --load-extension names a new directory.
	// Give each managed run a cache generation while retaining the product's
	// display version. Command-line extensions permit version decreases.
	// This truncated digest is not authority: the full native host/run binding
	// still authenticates the worker and all task permissions.
	digest := sha256.Sum256([]byte(nativeName))
	generation := binary.BigEndian.Uint64(digest[:8])
	if generation == 0 {
		generation = 1
	}
	manifest["version"] = fmt.Sprintf("%d.%d.%d.%d", uint16(generation>>48), uint16(generation>>32), uint16(generation>>16), uint16(generation))
	manifest["version_name"] = displayVersion
	// A changed version reaches Chromium's registration path; a changed script
	// URL prevents its same-script registration fast path from reusing the old
	// module graph. The source worker and its static imports remain unchanged.
	background["service_worker"] = workerScript
	config, _ := json.Marshal(struct {
		Version        int    `json:"version"`
		NativeHostName string `json:"nativeHostName"`
	}{1, nativeName})
	if err := os.WriteFile(filepath.Join(target, "managed-config.js"), append(append([]byte("export default "), config...), ';', '\n'), 0o600); err != nil {
		return "", err
	}
	if err := contextError(ctx); err != nil {
		return "", err
	}
	entry, err := os.OpenFile(filepath.Join(target, workerScript), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", fmt.Errorf("create managed worker entry: %w", err)
	}
	_, writeErr := io.WriteString(entry, workerEntry)
	if err := errors.Join(writeErr, entry.Close()); err != nil {
		return "", err
	}
	payload, err = json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(manifestPath, append(payload, '\n'), 0o600); err != nil {
		return "", err
	}
	return id, nil
}

func managedWorkerScript(runID string) (string, error) {
	if !stagedNativeName.MatchString("com.openbrowseruse.managed.n" + runID) {
		return "", errors.New("managed worker entry requires a complete run ID")
	}
	return "managed-worker-" + runID + ".js", nil
}

func validExtensionVersion(version string) bool {
	parts := strings.Split(version, ".")
	if len(parts) > 4 {
		return false
	}
	nonzero := false
	for _, part := range parts {
		value, err := strconv.ParseUint(part, 10, 16)
		if err != nil || strconv.FormatUint(value, 10) != part {
			return false
		}
		nonzero = nonzero || value != 0
	}
	return nonzero
}

func extensionID(key string) (string, error) {
	decoded, err := base64.StdEncoding.DecodeString(key)
	if err != nil || len(decoded) == 0 || len(decoded) > 16384 {
		return "", errors.New("managed extension requires a valid base64 public key")
	}
	digest := sha256.Sum256(decoded)
	var result [32]byte
	for i, value := range digest[:16] {
		result[i*2], result[i*2+1] = 'a'+value>>4, 'a'+value&15
	}
	return string(result[:]), nil
}

func privateEnvironment(root string) ([]string, error) {
	values := map[string]string{"TEMP": filepath.Join(root, "temp"), "TMP": filepath.Join(root, "temp"), "LOCALAPPDATA": filepath.Join(root, "local"), "APPDATA": filepath.Join(root, "roaming"), "USERPROFILE": filepath.Join(root, "user")}
	for _, directory := range values {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return nil, err
		}
	}
	var env []string
	for _, value := range os.Environ() {
		name, _, found := strings.Cut(value, "=")
		if !found {
			continue
		}
		upper := strings.ToUpper(name)
		if upper == "HOME" {
			continue
		}
		if _, overridden := values[upper]; !overridden {
			env = append(env, value)
		}
	}
	for name, value := range values {
		env = append(env, name+"="+value)
	}
	return env, nil
}
