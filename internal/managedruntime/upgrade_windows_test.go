//go:build windows

package managedruntime

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

// Synthetic installed file inventory, never a browser. Only the outer archive
// identity is set to the historical pin to exercise migration's local manifest
// contract. TestPinnedOfficialArchiveStructure separately checks original ZIPs.
func retainedFixture(t *testing.T, root string) string {
	t.Helper()
	s, _ := testSource(t, nil)
	s.version = retainedVersion
	installed, err := install(context.Background(), root, s)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(filepath.Dir(installed.Executable))
	setFixtureArchiveIdentity(t, dir, retainedSHA256)
	return dir
}

func setFixtureArchiveIdentity(t *testing.T, directory, digest string) {
	t.Helper()
	name := filepath.Join(directory, manifestName)
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	var m manifest
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	m.ArchiveSHA256 = digest
	data, err = json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func retainedSnapshot(t *testing.T, root string) map[string]struct {
	Hash           [32]byte
	Size, Modified int64
} {
	t.Helper()
	result := map[string]struct {
		Hash           [32]byte
		Size, Modified int64
	}{}
	err := filepath.WalkDir(root, func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		data, err := os.ReadFile(name)
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(root, name)
		result[relative] = struct {
			Hash           [32]byte
			Size, Modified int64
		}{sha256.Sum256(data), info.Size(), info.ModTime().UnixNano()}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestRecommendedUpgradePreservesHistoricalInstallationAndSelectsNewOffline(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cache")
	old := retainedFixture(t, root)
	writeDictionaryFixture(t, filepath.Join(old, filepath.FromSlash(dictionaryDirectory), "en-US-10-2.bdic"), 32)
	before := retainedSnapshot(t, old)
	if _, err := Inspect(context.Background(), root); !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("old install was selected or blocked explicit upgrade: %v", err)
	}
	s, requests := testSource(t, nil)
	installed, err := install(context.Background(), root, s)
	if err != nil {
		t.Fatal(err)
	}
	if installed.Reused || installed.Version != RecommendedVersion || installed.Executable != filepath.Join(root, RecommendedVersion+"-win64", "chrome-win64", "chrome.exe") || requests.Load() != 1 {
		t.Fatalf("new recommended version not independently installed: %+v", installed)
	}
	newDir := filepath.Dir(filepath.Dir(installed.Executable))
	setFixtureArchiveIdentity(t, newDir, recommendedSHA256)
	inspected, err := Inspect(context.Background(), root)
	if err != nil || inspected.Version != RecommendedVersion || inspected.Executable != installed.Executable || !inspected.Reused {
		t.Fatalf("offline Inspect selected old version: %+v %v", inspected, err)
	}
	s.digest, s.url = recommendedSHA256, "http://127.0.0.1:1/must-not-download"
	reused, err := install(context.Background(), root, s)
	if err != nil || reused != inspected || requests.Load() != 1 {
		t.Fatalf("verified current version was not reused offline: %+v %v", reused, err)
	}
	if !reflect.DeepEqual(before, retainedSnapshot(t, old)) {
		t.Fatal("upgrade changed original historical files or dictionary")
	}
}

func TestRecommendedUpgradeRejectsUnknownOrChangedHistoricalContents(t *testing.T) {
	for _, kind := range []string{"unknown version", "unknown file", "wrong archive", "missing file", "changed original"} {
		t.Run(kind, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "cache")
			old := retainedFixture(t, root)
			switch kind {
			case "unknown version":
				if err := os.Rename(old, filepath.Join(root, "155.0.8059.85-win64")); err != nil {
					t.Fatal(err)
				}
			case "unknown file":
				if err := os.WriteFile(filepath.Join(old, "unexpected"), []byte("preserve"), 0600); err != nil {
					t.Fatal(err)
				}
			case "wrong archive":
				setFixtureArchiveIdentity(t, old, recommendedSHA256)
			case "missing file":
				if err := os.Remove(filepath.Join(old, "chrome-win64", "chrome.exe")); err != nil {
					t.Fatal(err)
				}
			case "changed original":
				if err := os.WriteFile(filepath.Join(old, "chrome-win64", "chrome.exe"), []byte("changed"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			before := retainedSnapshot(t, root)
			s, requests := testSource(t, nil)
			if _, err := install(context.Background(), root, s); err == nil {
				t.Fatal("unverified historical tree admitted")
			}
			if _, err := Inspect(context.Background(), root); err == nil || errors.Is(err, ErrNotInstalled) {
				t.Fatalf("unknown historical state treated as absent: %v", err)
			}
			if requests.Load() != 0 || !reflect.DeepEqual(before, retainedSnapshot(t, root)) {
				t.Fatal("invalid historical tree triggered download or changed files")
			}
		})
	}
}

func TestRecommendedUpgradeRejectsHistoricalJunctionWithoutTouchingTarget(t *testing.T) {
	for _, inner := range []bool{false, true} {
		t.Run(map[bool]string{false: "version root", true: "original subdirectory"}[inner], func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "cache")
			old := retainedFixture(t, root)
			link := old
			if inner {
				link = filepath.Join(old, "chrome-win64")
			}
			target := filepath.Join(t.TempDir(), "retained-original")
			if err := os.Rename(link, target); err != nil {
				t.Fatal(err)
			}
			before := retainedSnapshot(t, target)
			createRuntimeUpgradeJunction(t, link, target)
			s, requests := testSource(t, nil)
			if _, err := install(context.Background(), root, s); err == nil {
				t.Fatal("linked historical installation admitted")
			}
			if _, err := Inspect(context.Background(), root); err == nil || errors.Is(err, ErrNotInstalled) {
				t.Fatalf("linked historical installation treated as absent: %v", err)
			}
			if requests.Load() != 0 || !reflect.DeepEqual(before, retainedSnapshot(t, target)) {
				t.Fatal("linked target changed or download started")
			}
			pointer, err := windows.UTF16PtrFromString(link)
			if err != nil {
				t.Fatal(err)
			}
			attributes, err := windows.GetFileAttributes(pointer)
			if err != nil || attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT == 0 {
				t.Fatalf("original junction disappeared: %v", err)
			}
		})
	}
}

// A real local directory junction needs no symlink privilege and launches no
// shell/browser. Only test-owned directories are referenced.
func createRuntimeUpgradeJunction(t *testing.T, link, target string) {
	t.Helper()
	if err := os.Mkdir(link, 0700); err != nil {
		t.Fatal(err)
	}
	name, err := windows.UTF16PtrFromString(link)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	substitute := utf16.Encode([]rune(`\??\` + target))
	printName := utf16.Encode([]rune(target))
	data := make([]byte, 16+(len(substitute)+len(printName)+2)*2)
	binary.LittleEndian.PutUint32(data, windows.IO_REPARSE_TAG_MOUNT_POINT)
	binary.LittleEndian.PutUint16(data[4:], uint16(len(data)-8))
	binary.LittleEndian.PutUint16(data[10:], uint16(len(substitute)*2))
	binary.LittleEndian.PutUint16(data[12:], uint16((len(substitute)+1)*2))
	binary.LittleEndian.PutUint16(data[14:], uint16(len(printName)*2))
	for index, value := range append(append(substitute, 0), append(printName, 0)...) {
		binary.LittleEndian.PutUint16(data[16+index*2:], value)
	}
	var returned uint32
	if err := windows.DeviceIoControl(handle, windows.FSCTL_SET_REPARSE_POINT, &data[0], uint32(len(data)), nil, 0, &returned, nil); err != nil {
		t.Fatal(err)
	}
}
