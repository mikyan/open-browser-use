//go:build windows

package managedruntime

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func writeDictionaryFixture(t *testing.T, name string, size int64) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
		t.Fatal(err)
	}
	data := make([]byte, 32)
	copy(data, "BDic")
	if err := os.WriteFile(name, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(name, size); err != nil {
		t.Fatal(err)
	}
}

func TestDictionaryRuntimeCacheAllowsOfflineRepeatedUseWithoutChangingManifest(t *testing.T) {
	s, requests := testSource(t, nil)
	root := filepath.Join(t.TempDir(), "cache")
	installed, err := install(context.Background(), root, s)
	if err != nil {
		t.Fatal(err)
	}
	versionDir := filepath.Dir(filepath.Dir(installed.Executable))
	manifestPath := filepath.Join(versionDir, manifestName)
	original, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	dictionary := filepath.Join(versionDir, filepath.FromSlash(dictionaryDirectory), "en-US-10-2.bdic")
	writeDictionaryFixture(t, dictionary, 451982)
	s.url = "http://127.0.0.1:1/must-not-download"
	for i := 0; i < 2; i++ {
		checked, err := inspect(context.Background(), root, s.version, s.digest)
		if err != nil || !checked.Reused || checked.Executable != installed.Executable {
			t.Fatalf("offline reuse: %#v %v", checked, err)
		}
		reused, err := install(context.Background(), root, s)
		if err != nil || !reused.Reused {
			t.Fatalf("explicit install reuse: %#v %v", reused, err)
		}
	}
	if requests.Load() != 1 {
		t.Fatal("runtime data triggered a new download")
	}
	after, err := os.ReadFile(manifestPath)
	if err != nil || !bytes.Equal(original, after) {
		t.Fatal("dictionary was adopted into pinned manifest")
	}
	if info, err := os.Stat(dictionary); err != nil || info.Size() != 451982 {
		t.Fatal("runtime data changed or removed")
	}
	if err := os.WriteFile(installed.Executable, []byte("modified"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := inspect(context.Background(), root, s.version, s.digest); err == nil {
		t.Fatal("dictionary exception bypassed original file integrity")
	}
}

func TestDictionaryRuntimeCacheRejectsEverythingOutsideItsNarrowBounds(t *testing.T) {
	for _, kind := range []string{"exe", "dll", "text", "unversioned", "nested", "wrong directory case", "bad header", "too short", "too large", "too many", "total bytes", "hard link"} {
		t.Run(kind, func(t *testing.T) {
			s, requests := testSource(t, nil)
			root := filepath.Join(t.TempDir(), "cache")
			installed, err := install(context.Background(), root, s)
			if err != nil {
				t.Fatal(err)
			}
			versionDir := filepath.Dir(filepath.Dir(installed.Executable))
			dir := filepath.Join(versionDir, filepath.FromSlash(dictionaryDirectory))
			name := filepath.Join(dir, "en-US-10-2.bdic")
			switch kind {
			case "exe", "dll", "text":
				ext := map[string]string{"exe": "exe", "dll": "dll", "text": "txt"}[kind]
				name = filepath.Join(dir, "en-US-10-2."+ext)
				writeDictionaryFixture(t, name, 32)
			case "unversioned":
				name = filepath.Join(dir, "en-US.bdic")
				writeDictionaryFixture(t, name, 32)
			case "nested":
				name = filepath.Join(dir, "nested", "en-US-10-2.bdic")
				writeDictionaryFixture(t, name, 32)
			case "wrong directory case":
				name = filepath.Join(versionDir, "chrome-win64", "dictionaries", "en-US-10-2.bdic")
				writeDictionaryFixture(t, name, 32)
			case "bad header":
				writeDictionaryFixture(t, name, 32)
				if err := os.WriteFile(name, bytes.Repeat([]byte("MZ"), 16), 0600); err != nil {
					t.Fatal(err)
				}
			case "too short":
				writeDictionaryFixture(t, name, 4)
			case "too large":
				writeDictionaryFixture(t, name, dictionarySizeLimit+1)
			case "too many":
				for i := 0; i <= dictionaryFileLimit; i++ {
					writeDictionaryFixture(t, filepath.Join(dir, fmt.Sprintf("en-US-10-%d.bdic", i)), 32)
				}
			case "total bytes":
				for i := 0; i < 5; i++ {
					writeDictionaryFixture(t, filepath.Join(dir, fmt.Sprintf("en-US-10-%d.bdic", i)), dictionarySizeLimit)
				}
			case "hard link":
				outside := filepath.Join(t.TempDir(), "original.bdic")
				writeDictionaryFixture(t, outside, 32)
				if err := os.MkdirAll(dir, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.Link(outside, name); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := inspect(context.Background(), root, s.version, s.digest); err == nil {
				t.Fatal("unexpected runtime data accepted")
			}
			if _, err := install(context.Background(), root, s); err == nil {
				t.Fatal("unknown data overwritten or reused")
			}
			if requests.Load() != 1 {
				t.Fatal("unknown runtime data triggered download")
			}
			if _, err := os.Stat(name); err != nil {
				t.Fatal("unknown runtime data deleted", err)
			}
		})
	}
}

func TestDictionaryAlreadyInArchiveAlwaysRequiresOriginalHash(t *testing.T) {
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	original := make([]byte, 32)
	copy(original, "BDic")
	for _, file := range []struct {
		name string
		data []byte
	}{
		{"chrome-win64/chrome.exe", []byte("fixture; never execute")},
		{dictionaryDirectory + "/en-US-10-2.bdic", original},
	} {
		entry, err := writer.Create(file.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(file.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	data := output.Bytes()
	digest := sha256.Sum256(data)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(data) }))
	defer server.Close()
	s := source{RecommendedVersion, hex.EncodeToString(digest[:]), server.URL, server.Client()}
	root := filepath.Join(t.TempDir(), "cache")
	installed, err := install(context.Background(), root, s)
	if err != nil {
		t.Fatal(err)
	}
	name := filepath.Join(filepath.Dir(installed.Executable), "Dictionaries", "en-US-10-2.bdic")
	original[31] = 1 // Keep a valid header and exact size; only original hash changed.
	if err := os.WriteFile(name, original, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := inspect(context.Background(), root, s.version, s.digest); err == nil {
		t.Fatal("runtime exception replaced pinned file hash")
	}
	if _, err := install(context.Background(), root, s); err == nil {
		t.Fatal("pinned dictionary corruption was reused")
	}
}
