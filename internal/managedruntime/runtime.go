// Package managedruntime explicitly installs one pinned browser for managed
// sessions. Inspection is offline; neither operation starts a browser or reads
// an installed browser profile. Digests prove pinned bytes, not a signature.
package managedruntime

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const RecommendedVersion = "155.0.8059.84"
const recommendedSHA256 = "507f2a031441d10c62b5e3d4e863f09ac1198a571c1419976cbd8387f639afde"
const recommendedURL = "https://storage.googleapis.com/chrome-for-testing-public/" + RecommendedVersion + "/win64/chrome-win64.zip"
const cacheMarker = ".managed-runtime.json"
const manifestName = ".installation.json"
const lockName = ".install.lock"
const compressedLimit int64 = 384 << 20
const expandedLimit uint64 = 1536 << 20
const entryLimit = 10000
const manifestLimit = 8 << 20
const cacheOwnership = "{\"version\":1,\"owner\":\"OpenBrowserUse managed browser cache\"}\n"

var ErrNotInstalled = errors.New("recommended managed browser is not installed; run managed browser install explicitly")
var ErrBusy = errors.New("managed browser cache is in use; wait for the original operation to finish")
var errUnsupported = errors.New("managed browser runtime currently requires Windows amd64")

type Installation struct {
	Version          string `json:"version"`
	Platform         string `json:"platform"`
	Executable       string `json:"executable"`
	ArchiveSHA256    string `json:"archiveSHA256"`
	ExecutableSHA256 string `json:"executableSHA256"`
	Reused           bool   `json:"reused"`
}

type fileRecord struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}
type manifest struct {
	Schema        int          `json:"schema"`
	Version       string       `json:"version"`
	Platform      string       `json:"platform"`
	ArchiveSHA256 string       `json:"archiveSHA256"`
	Directories   []string     `json:"directories"`
	Files         []fileRecord `json:"files"`
}

// source is an internal deterministic test seam, never a user-selectable URL or
// version. Public entry points always use the compiled source and HTTPS client.
type source struct {
	version, digest, url string
	client               *http.Client
}

func recommended() source {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	transport.MaxResponseHeaderBytes = 64 << 10
	return source{RecommendedVersion, recommendedSHA256, recommendedURL, &http.Client{
		Transport: transport,
		Timeout:   10 * time.Minute,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("managed runtime download redirects are not permitted")
		},
	}}
}

func supported() error {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		return errUnsupported
	}
	return nil
}

// DefaultRoot computes a location; it never creates directories or files.
func DefaultRoot() (string, error) {
	if err := supported(); err != nil {
		return "", err
	}
	root, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	root = filepath.Join(root, "OpenBrowserUse", "browser")
	if !filepath.IsAbs(root) {
		return "", errors.New("managed browser cache default is not absolute")
	}
	return root, nil
}

// Inspect verifies the complete installation while holding the existing native
// lock. It never creates a missing cache, lock, manifest or network connection.
func Inspect(ctx context.Context, root string) (Installation, error) {
	if err := supported(); err != nil {
		return Installation{}, err
	}
	return inspect(ctx, root, RecommendedVersion, recommendedSHA256)
}

func inspect(ctx context.Context, root, version, digest string) (_ Installation, err error) {
	if err := checkContext(ctx); err != nil {
		return Installation{}, err
	}
	if err := validateRoot(root); err != nil {
		return Installation{}, err
	}
	if err := ownership(root, false); err != nil {
		return Installation{}, err
	}
	lock, err := platformLock(root, false)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Installation{}, errors.New("managed browser cache lock is missing; installation is incomplete")
		}
		return Installation{}, err
	}
	defer func() { err = errors.Join(err, lock.Close()) }()
	if err := cacheLayout(root, version); err != nil {
		return Installation{}, err
	}
	return inspectDirectory(ctx, filepath.Join(root, version+"-win64"), version, digest)
}

func Install(ctx context.Context, root string) (Installation, error) {
	if err := supported(); err != nil {
		return Installation{}, err
	}
	s := recommended()
	defer s.client.CloseIdleConnections()
	return install(ctx, root, s)
}

func install(ctx context.Context, root string, s source) (_ Installation, err error) {
	if err := checkContext(ctx); err != nil {
		return Installation{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	if err := checkContext(ctx); err != nil {
		return Installation{}, err
	}
	if err := validateRoot(root); err != nil {
		return Installation{}, err
	}
	if err := ownership(root, true); err != nil {
		return Installation{}, err
	}
	lock, err := platformLock(root, true)
	if err != nil {
		return Installation{}, err
	}
	defer func() { err = errors.Join(err, lock.Close()) }()
	if err := cacheLayout(root, s.version); err != nil {
		return Installation{}, err
	}
	destination := filepath.Join(root, s.version+"-win64")
	existing, err := inspectDirectory(ctx, destination, s.version, s.digest)
	if err == nil {
		return existing, nil
	}
	if !errors.Is(err, ErrNotInstalled) {
		return Installation{}, err // Never overwrite a damaged installation.
	}
	if err := checkContext(ctx); err != nil {
		return Installation{}, err
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return Installation{}, err
	}
	stage := filepath.Join(root, ".stage-"+hex.EncodeToString(random[:]))
	if err := os.Mkdir(stage, 0700); err != nil {
		return Installation{}, err
	}
	identity, err := capturedInfo(stage)
	if err != nil {
		return Installation{}, err
	}
	published := false
	defer func() {
		if !published {
			err = errors.Join(err, removeStage(root, stage, identity))
		}
	}()
	archive := filepath.Join(stage, ".download.zip")
	if err := download(ctx, archive, s); err != nil {
		return Installation{}, err
	}
	m, err := extract(ctx, archive, stage, s.version, s.digest)
	if err != nil {
		return Installation{}, err
	}
	if err := os.Remove(archive); err != nil {
		return Installation{}, err
	}
	data, err := json.Marshal(m)
	if err != nil {
		return Installation{}, err
	}
	if err := writeNew(filepath.Join(stage, manifestName), data); err != nil {
		return Installation{}, err
	}
	if _, err := inspectDirectory(ctx, stage, s.version, s.digest); err != nil {
		return Installation{}, err
	}
	if err := checkContext(ctx); err != nil {
		return Installation{}, err
	}
	if err := platformValidatePath(destination); err != nil {
		return Installation{}, err
	}
	// Same-volume directory rename is the only publication point. The original
	// lock excludes our other installers; Rename never replaces a populated dir.
	if err := os.Rename(stage, destination); err != nil {
		return Installation{}, fmt.Errorf("publish managed browser: %w", err)
	}
	published = true
	value, err := inspectDirectory(ctx, destination, s.version, s.digest)
	if err != nil {
		return Installation{}, err // Preserve the published tree on late failure.
	}
	value.Reused = false
	return value, nil
}

func validateRoot(root string) error {
	if !filepath.IsAbs(root) || filepath.Clean(root) != root || filepath.Dir(root) == root {
		return errors.New("managed browser cache must be a canonical absolute dedicated directory")
	}
	return platformValidatePath(root)
}

func ownership(root string, create bool) error {
	if err := platformValidatePath(root); err != nil {
		return err
	}
	info, err := os.Lstat(root)
	if errors.Is(err, os.ErrNotExist) {
		if !create {
			return ErrNotInstalled
		}
		if err := os.MkdirAll(root, 0700); err != nil {
			return err
		}
	} else if err != nil {
		return err
	} else if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("managed browser cache is not an ordinary directory")
	}
	marker := filepath.Join(root, cacheMarker)
	data, err := readSmall(marker, 4096)
	if err == nil {
		if string(data) != cacheOwnership {
			return errors.New("managed browser cache ownership does not match")
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	if len(entries) != 0 {
		return errors.New("refusing unknown nonempty managed browser cache")
	}
	if !create {
		return ErrNotInstalled
	}
	if err := platformProtectDirectory(root); err != nil {
		return err
	}
	if err := writeNew(marker, []byte(cacheOwnership)); err != nil {
		if errors.Is(err, os.ErrExist) {
			data, readErr := readSmall(marker, 4096)
			if readErr == nil && string(data) == cacheOwnership {
				return nil
			}
		}
		return err
	}
	return nil
}

func cacheLayout(root, version string) error {
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := platformValidatePath(filepath.Join(root, entry.Name())); err != nil {
			return err
		}
		switch entry.Name() {
		case cacheMarker, lockName:
			if !entry.Type().IsRegular() {
				return errors.New("managed browser cache metadata is not a regular file")
			}
		case version + "-win64":
			if !entry.IsDir() {
				return errors.New("managed browser version path is not a directory")
			}
		default:
			return errors.New("managed browser cache has unknown or unfinished entries; nothing was removed")
		}
	}
	return nil
}

func inspectDirectory(ctx context.Context, directory, version, digest string) (Installation, error) {
	if err := platformValidatePath(directory); err != nil {
		return Installation{}, err
	}
	if _, err := os.Lstat(directory); errors.Is(err, os.ErrNotExist) {
		return Installation{}, ErrNotInstalled
	} else if err != nil {
		return Installation{}, err
	}
	data, err := readSmall(filepath.Join(directory, manifestName), manifestLimit)
	if err != nil {
		return Installation{}, fmt.Errorf("managed browser installation manifest is unavailable: %w", err)
	}
	var m manifest
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&m); err != nil {
		return Installation{}, errors.New("managed browser installation manifest is invalid")
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF || m.Schema != 1 || m.Version != version || m.Platform != "win64" || m.ArchiveSHA256 != digest || len(m.Files) < 1 || len(m.Files)+len(m.Directories) > entryLimit*2 {
		return Installation{}, errors.New("managed browser installation identity or limits do not match")
	}
	expected := map[string]fileRecord{}
	dirs := map[string]bool{}
	seen := map[string]string{}
	var total uint64
	for _, name := range m.Directories {
		if err := addName(seen, name); err != nil {
			return Installation{}, err
		}
		dirs[name] = true
	}
	for _, file := range m.Files {
		if err := addName(seen, file.Path); err != nil {
			return Installation{}, err
		}
		decoded, err := hex.DecodeString(file.SHA256)
		if err != nil || len(decoded) != sha256.Size || file.Size < 0 || uint64(file.Size) > expandedLimit-total {
			return Installation{}, errors.New("managed browser file manifest is invalid")
		}
		total += uint64(file.Size)
		expected[file.Path] = file
	}
	if _, ok := expected["chrome-win64/chrome.exe"]; !ok || !dirs["chrome-win64"] {
		return Installation{}, errors.New("managed browser executable is missing from manifest")
	}
	filesSeen, dirsSeen := 0, 0
	err = filepath.WalkDir(directory, func(file string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := checkContext(ctx); err != nil {
			return err
		}
		if err := platformValidatePath(file); err != nil {
			return err
		}
		if file == directory {
			return nil
		}
		relative, _ := filepath.Rel(directory, file)
		relative = filepath.ToSlash(relative)
		if entry.IsDir() {
			if !dirs[relative] {
				return errors.New("managed browser contains an unknown directory")
			}
			dirsSeen++
			return nil
		}
		if !entry.Type().IsRegular() {
			return errors.New("managed browser contains a link or nonregular file")
		}
		if relative == manifestName {
			return nil
		}
		want, ok := expected[relative]
		if !ok {
			return errors.New("managed browser contains an unknown file")
		}
		got, err := hashFile(ctx, file, want.Size)
		if err != nil {
			return err
		}
		if got != want.SHA256 {
			return fmt.Errorf("managed browser file integrity failed: %s", relative)
		}
		filesSeen++
		return nil
	})
	if err != nil {
		return Installation{}, err
	}
	if filesSeen != len(expected) || dirsSeen != len(dirs) {
		return Installation{}, errors.New("managed browser installation is incomplete")
	}
	return Installation{version, "win64", filepath.Join(directory, "chrome-win64", "chrome.exe"), digest, expected["chrome-win64/chrome.exe"].SHA256, true}, nil
}

func download(ctx context.Context, destination string, s source) (err error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept-Encoding", "identity")
	response, err := s.client.Do(request)
	if err != nil {
		return fmt.Errorf("managed browser download failed: %w", err)
	}
	defer func() { err = errors.Join(err, response.Body.Close()) }()
	if response.StatusCode != http.StatusOK || response.ContentLength > compressedLimit || response.Uncompressed || (response.Header.Get("Content-Encoding") != "" && response.Header.Get("Content-Encoding") != "identity") {
		return errors.New("managed browser download status, encoding or size is invalid")
	}
	file, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, file.Close()) }()
	h := sha256.New()
	n, err := io.CopyBuffer(io.MultiWriter(file, h), io.LimitReader(&contextReader{ctx, response.Body}, compressedLimit+1), make([]byte, 128<<10))
	if err != nil {
		return err
	}
	if n > compressedLimit || (response.ContentLength >= 0 && n != response.ContentLength) || hex.EncodeToString(h.Sum(nil)) != s.digest {
		return errors.New("managed browser archive size or pinned SHA-256 does not match")
	}
	return file.Sync()
}

func writeNew(name string, data []byte) (err error) {
	file, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, file.Close()) }()
	if _, err := file.Write(data); err != nil {
		return err
	}
	return file.Sync()
}

// Windows Lstat may defer obtaining the volume/file ID until SameFile is first
// called. Capture it from an already open handle now, before a later rename can
// replace this pathname. File.Stat carries that original handle's file ID.
func capturedInfo(name string) (info os.FileInfo, err error) {
	file, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, file.Close()) }()
	return file.Stat()
}

func readSmall(name string, limit int64) ([]byte, error) {
	if err := platformValidatePath(name); err != nil {
		return nil, err
	}
	before, err := capturedInfo(name)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || before.Size() > limit {
		return nil, errors.New("managed browser metadata is nonregular or too large")
	}
	file, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(before, opened) {
		return nil, errors.New("managed browser metadata changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) != before.Size() {
		return nil, errors.New("managed browser metadata size changed while reading")
	}
	return data, nil
}

func hashFile(ctx context.Context, name string, size int64) (string, error) {
	before, err := capturedInfo(name)
	if err != nil {
		return "", err
	}
	if !before.Mode().IsRegular() || before.Size() != size {
		return "", fmt.Errorf("managed browser file size or type changed: %s", filepath.Base(name))
	}
	file, err := os.Open(name)
	if err != nil {
		return "", err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(before, opened) {
		return "", errors.New("managed browser file identity changed while opening")
	}
	h := sha256.New()
	n, err := io.CopyBuffer(h, io.LimitReader(&contextReader{ctx, file}, size+1), make([]byte, 128<<10))
	if err != nil {
		return "", err
	}
	after, err := capturedInfo(name)
	if err != nil || n != size || !os.SameFile(before, after) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		return "", errors.New("managed browser file changed while hashing")
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func removeStage(root, stage string, original os.FileInfo) error {
	if filepath.Dir(stage) != root || !strings.HasPrefix(filepath.Base(stage), ".stage-") {
		return errors.New("refusing runtime cleanup outside original stage")
	}
	if err := platformValidatePath(stage); err != nil {
		return err
	}
	current, err := capturedInfo(stage)
	if err != nil || !os.SameFile(original, current) {
		return errors.New("original managed runtime stage identity changed; retained")
	}
	if err := filepath.WalkDir(stage, func(name string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := platformValidatePath(name); err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 || (!entry.IsDir() && !entry.Type().IsRegular()) {
			return errors.New("original stage contains an unexpected link; retained")
		}
		return nil
	}); err != nil {
		return err
	}
	return os.RemoveAll(stage)
}

func checkContext(ctx context.Context) error {
	if ctx == nil {
		return errors.New("managed browser context is required")
	}
	return ctx.Err()
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := checkContext(r.ctx); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

func sortedKeys(values map[string]bool) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
