//go:build windows

package managedruntime

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testSource(t *testing.T, handler http.HandlerFunc) (source, *atomic.Int32) {
	t.Helper()
	data := archiveBytes(t)
	digest := sha256.Sum256(data)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if handler != nil {
			handler(w, r)
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(server.Close)
	return source{RecommendedVersion, hex.EncodeToString(digest[:]), server.URL, server.Client()}, &requests
}

func TestInstallPublishesCompleteTreeAndReusesOffline(t *testing.T) {
	s, requests := testSource(t, nil)
	root := filepath.Join(t.TempDir(), "cache")
	first, err := install(context.Background(), root, s)
	if err != nil {
		t.Fatal(err)
	}
	if first.Reused || first.Version != RecommendedVersion || first.Platform != "win64" || first.ArchiveSHA256 != s.digest {
		t.Fatalf("bad installation: %#v", first)
	}
	exe, err := os.ReadFile(first.Executable)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(exe)
	if first.ExecutableSHA256 != hex.EncodeToString(digest[:]) {
		t.Fatal("executable hash not bound")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(first.Executable), "ABOUT")); err != nil {
		t.Fatal("original notice lost", err)
	}
	s.url = "http://127.0.0.1:1/must-not-request"
	second, err := install(context.Background(), root, s)
	if err != nil {
		t.Fatal(err)
	}
	inspected, err := inspect(context.Background(), root, s.version, s.digest)
	if err != nil {
		t.Fatal(err)
	}
	if !second.Reused || !inspected.Reused || second != inspected || requests.Load() != 1 {
		t.Fatal("existing install did not reuse entirely offline")
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 3 {
		t.Fatalf("stage/archive leaked: %v", entries)
	}
}

func TestInspectionMissingCacheHasNoSideEffects(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	if _, err := Inspect(context.Background(), root); !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("expected missing: %v", err)
	}
	if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("Inspect created cache")
	}
	base := t.TempDir()
	t.Setenv("LOCALAPPDATA", base)
	want := filepath.Join(base, "OpenBrowserUse", "browser")
	got, err := DefaultRoot()
	if err != nil || got != want {
		t.Fatalf("DefaultRoot: %s %v", got, err)
	}
	if _, err := os.Stat(want); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("DefaultRoot created cache")
	}
}

func TestCorruptionAndUnknownFilesAreRetained(t *testing.T) {
	for _, kind := range []string{"changed file", "missing file", "unknown file", "unknown directory", "unknown root", "unfinished stage", "manifest identity", "manifest extra field"} {
		t.Run(kind, func(t *testing.T) {
			s, requests := testSource(t, nil)
			root := filepath.Join(t.TempDir(), "cache")
			installed, err := install(context.Background(), root, s)
			if err != nil {
				t.Fatal(err)
			}
			versionDir := filepath.Dir(filepath.Dir(installed.Executable))
			var retained string
			switch kind {
			case "changed file":
				retained = installed.Executable
				err = os.WriteFile(retained, bytes.Repeat([]byte("X"), len("synthetic test fixture; never execute")), 0600)
			case "missing file":
				err = os.Remove(installed.Executable)
			case "unknown file":
				retained = filepath.Join(versionDir, "unknown")
				err = os.WriteFile(retained, []byte("untouched"), 0600)
			case "unknown directory":
				retained = filepath.Join(versionDir, "unknown")
				err = os.Mkdir(retained, 0700)
			case "unknown root":
				retained = filepath.Join(root, "unknown")
				err = os.WriteFile(retained, []byte("untouched"), 0600)
			case "unfinished stage":
				retained = filepath.Join(root, ".stage-prior-run")
				err = os.Mkdir(retained, 0700)
			case "manifest identity", "manifest extra field":
				retained = filepath.Join(versionDir, manifestName)
				data, e := os.ReadFile(retained)
				if e != nil {
					t.Fatal(e)
				}
				if kind == "manifest identity" {
					data = bytes.Replace(data, []byte(s.digest), []byte(strings.Repeat("0", 64)), 1)
				} else {
					data = append([]byte(`{"unknown":1,`), data[1:]...)
				}
				err = os.WriteFile(retained, data, 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := inspect(context.Background(), root, s.version, s.digest); err == nil {
				t.Fatal("Inspect accepted corruption")
			}
			if _, err := install(context.Background(), root, s); err == nil {
				t.Fatal("Install replaced corruption")
			}
			if requests.Load() != 1 {
				t.Fatal("corruption triggered network")
			}
			if retained != "" {
				if _, err := os.Stat(retained); err != nil {
					t.Fatal("unknown/corrupt resource deleted", err)
				}
			}
		})
	}
}

func TestFailedDownloadsRemoveOnlyTheirNewStage(t *testing.T) {
	for _, kind := range []string{"wrong hash", "truncated", "oversize header", "encoding", "status", "invalid zip"} {
		t.Run(kind, func(t *testing.T) {
			data := archiveBytes(t)
			s, _ := testSource(t, func(w http.ResponseWriter, r *http.Request) {
				switch kind {
				case "wrong hash":
					_, _ = w.Write([]byte("wrong pinned bytes"))
				case "truncated":
					w.Header().Set("Content-Length", fmt.Sprint(len(data)+100))
					_, _ = w.Write(data)
				case "oversize header":
					w.Header().Set("Content-Length", fmt.Sprint(compressedLimit+1))
					w.WriteHeader(200)
				case "encoding":
					w.Header().Set("Content-Encoding", "gzip")
					_, _ = w.Write(data)
				case "status":
					w.WriteHeader(403)
				case "invalid zip":
					_, _ = w.Write([]byte("pinned but not a ZIP"))
				}
			})
			if kind == "invalid zip" {
				d := sha256.Sum256([]byte("pinned but not a ZIP"))
				s.digest = hex.EncodeToString(d[:])
			}
			root := filepath.Join(t.TempDir(), "cache")
			if _, err := install(context.Background(), root, s); err == nil {
				t.Fatal("bad download accepted")
			}
			assertOnlyMetadata(t, root)
		})
	}
}

func assertOnlyMetadata(t *testing.T, root string) {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() != cacheMarker && entry.Name() != lockName {
			t.Fatalf("failed installation left %q", entry.Name())
		}
	}
}

func TestCancellationAndDeadlineReleaseOriginalLock(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		t.Run(fmt.Sprint(deadline), func(t *testing.T) {
			started := make(chan struct{})
			s, _ := testSource(t, func(w http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done() })
			root := filepath.Join(t.TempDir(), "cache")
			var ctx context.Context
			var cancel context.CancelFunc
			if deadline {
				ctx, cancel = context.WithTimeout(context.Background(), 100*time.Millisecond)
			} else {
				ctx, cancel = context.WithCancel(context.Background())
			}
			defer cancel()
			done := make(chan error, 1)
			go func() { _, err := install(ctx, root, s); done <- err }()
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("request never started")
			}
			if !deadline {
				cancel()
			}
			select {
			case err := <-done:
				if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("cancellation lost: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("cancelled installation still running")
			}
			assertOnlyMetadata(t, root)
			lock, err := platformLock(root, false)
			if err != nil {
				t.Fatal("lock leaked", err)
			}
			if err := lock.Close(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestConcurrentInstallAndInspectFailBusyWithoutReplacingOwner(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	data := archiveBytes(t)
	s, requests := testSource(t, func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		select {
		case <-release:
			_, _ = w.Write(data)
		case <-r.Context().Done():
		}
	})
	root := filepath.Join(t.TempDir(), "cache")
	done := make(chan error, 1)
	go func() { _, err := install(context.Background(), root, s); done <- err }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("first install never started")
	}
	defer close(release)
	if _, err := install(context.Background(), root, s); !errors.Is(err, ErrBusy) {
		t.Fatalf("concurrent installer: %v", err)
	}
	if _, err := inspect(context.Background(), root, s.version, s.digest); !errors.Is(err, ErrBusy) {
		t.Fatalf("concurrent inspection: %v", err)
	}
	// Resolve the original operation before the test cleanup closes its server.
	release <- struct{}{}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("original installer did not finish")
	}
	if requests.Load() != 1 {
		t.Fatal("concurrent request escaped native lock")
	}
}

func TestRootOwnershipAndPathValidation(t *testing.T) {
	for _, name := range []string{"relative", `C:\`, `\\server\share\cache`, `\\?\C:\cache`, `C:\cache\..\other`, `C:\cache.`, `C:\cache `, `C:\cache:stream`, `C:\NUL\cache`, `C:\COM1.txt\cache`, `C:\a/b`} {
		if err := validateRoot(name); err == nil {
			t.Fatalf("unsafe root accepted: %q", name)
		}
	}
	root := t.TempDir()
	unknown := filepath.Join(root, "personal.txt")
	if err := os.WriteFile(unknown, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	s, requests := testSource(t, nil)
	if _, err := install(context.Background(), root, s); err == nil {
		t.Fatal("unknown folder claimed")
	}
	if data, err := os.ReadFile(unknown); err != nil || string(data) != "keep" {
		t.Fatal("unknown file changed")
	}
	if requests.Load() != 0 {
		t.Fatal("unknown cache triggered network")
	}
	if _, err := install(nil, filepath.Join(t.TempDir(), "nil"), s); err == nil {
		t.Fatal("nil context accepted")
	}
}

func TestExtractChecksOriginalCRCAndDeclaredSize(t *testing.T) {
	var data bytes.Buffer
	zw := zip.NewWriter(&data)
	entry, err := zw.CreateHeader(&zip.FileHeader{Name: "chrome-win64/chrome.exe", Method: zip.Store})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = entry.Write([]byte("unique-original-body"))
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	corrupt := append([]byte(nil), data.Bytes()...)
	at := bytes.Index(corrupt, []byte("unique-original-body"))
	if at < 0 {
		t.Fatal("body not found")
	}
	corrupt[at] = 'X'
	stage := t.TempDir()
	archive := filepath.Join(stage, "test.zip")
	if err := os.WriteFile(archive, corrupt, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := extract(context.Background(), archive, stage, RecommendedVersion, recommendedSHA256); !errors.Is(err, zip.ErrChecksum) {
		t.Fatalf("CRC mismatch not rejected: %v", err)
	}
}

func TestPinnedOfficialArchiveStructure(t *testing.T) {
	name := os.Getenv("OBU_TEST_RUNTIME_ARCHIVE")
	if name == "" {
		t.Skip("optional original archive integrity/structure check; never executes a browser")
	}
	file, err := os.Open(name)
	if err != nil {
		t.Fatal(err)
	}
	h := sha256.New()
	_, copyErr := io.Copy(h, file)
	closeErr := file.Close()
	if err := errors.Join(copyErr, closeErr); err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(h.Sum(nil)) != recommendedSHA256 {
		t.Fatal("not the pinned original archive")
	}
	reader, err := zip.OpenReader(name)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	plan, err := planArchive(reader.File)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.files) != 305 {
		t.Fatalf("original entry count changed: %d", len(plan.files))
	}
	var bytes uint64
	for _, file := range plan.files {
		bytes += file.UncompressedSize64
	}
	if bytes != 460072969 {
		t.Fatalf("original expanded bytes changed: %d", bytes)
	}
	t.Logf("pinned original ZIP: %d files, %d dirs, %d expanded bytes; no execution", len(plan.files), len(plan.dirs), bytes)
}

func TestManifestBindsEveryFile(t *testing.T) {
	s, _ := testSource(t, nil)
	root := filepath.Join(t.TempDir(), "cache")
	installed, err := install(context.Background(), root, s)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(filepath.Dir(installed.Executable)), manifestName))
	if err != nil {
		t.Fatal(err)
	}
	var m manifest
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	if len(m.Files) != 3 || len(m.Directories) != 2 {
		t.Fatalf("incomplete manifest: %#v", m)
	}
	for _, f := range m.Files {
		if len(f.SHA256) != 64 || f.Size <= 0 {
			t.Fatal("unbound file")
		}
	}
}
