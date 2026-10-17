package managedruntime

import (
	"archive/zip"
	"bytes"
	"os"
	"reflect"
	"testing"
)

func zipEntry(name string, mode os.FileMode, size uint64) *zip.File {
	header := zip.FileHeader{Name: name, UncompressedSize64: size}
	header.SetMode(mode)
	return &zip.File{FileHeader: header}
}

func TestArchivePlanRejectsUnsafePathsAndEntries(t *testing.T) {
	for _, name := range []string{
		"../chrome.exe", "/chrome-win64/chrome.exe", `C:/chrome-win64/chrome.exe`,
		`chrome-win64\other.dll`, "chrome-win64/../escape", "chrome-win64/./x",
		"chrome-win64//x", "chrome-win64/file:stream", "chrome-win64/file.",
		"chrome-win64/file ", "chrome-win64/NUL.txt", "chrome-win64/COM¹",
		"chrome-win64/LPT9", "chrome-win64/CONIN$", "chrome-win64/a\x00b",
		"chrome-win64/a\nb", "other/file", "Chrome-win64/file",
	} {
		t.Run(name, func(t *testing.T) {
			_, err := planArchive([]*zip.File{zipEntry("chrome-win64/chrome.exe", 0600, 1), zipEntry(name, 0600, 1)})
			if err == nil {
				t.Fatal("unsafe archive accepted")
			}
		})
	}
	for _, tc := range []struct {
		name  string
		files []*zip.File
	}{
		{"duplicate", []*zip.File{zipEntry("chrome-win64/chrome.exe", 0600, 1)}},
		{"case collision", []*zip.File{zipEntry("chrome-win64/CHROME.exe", 0600, 1)}},
		{"parent case", []*zip.File{zipEntry("chrome-win64/Locales/a", 0600, 1), zipEntry("chrome-win64/locales/b", 0600, 1)}},
		{"file parent", []*zip.File{zipEntry("chrome-win64/sub", 0600, 1), zipEntry("chrome-win64/sub/child", 0600, 1)}},
		{"link", []*zip.File{zipEntry("chrome-win64/link", os.ModeSymlink|0600, 1)}},
		{"pipe", []*zip.File{zipEntry("chrome-win64/pipe", os.ModeNamedPipe|0600, 1)}},
		{"expanded limit", []*zip.File{zipEntry("chrome-win64/large", 0600, expandedLimit)}},
		{"directory data", []*zip.File{zipEntry("chrome-win64/dir/", os.ModeDir|0700, 1)}},
		{"duplicate directory", []*zip.File{zipEntry("chrome-win64/d/", os.ModeDir|0700, 0), zipEntry("chrome-win64/d/", os.ModeDir|0700, 0)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := planArchive(append([]*zip.File{zipEntry("chrome-win64/chrome.exe", 0600, 1)}, tc.files...))
			if err == nil {
				t.Fatal("invalid entry accepted")
			}
		})
	}
	if _, err := planArchive(make([]*zip.File, entryLimit+1)); err == nil {
		t.Fatal("entry limit ignored")
	}
	if _, err := planArchive([]*zip.File{zipEntry("chrome-win64/ABOUT", 0600, 1)}); err == nil {
		t.Fatal("missing executable accepted")
	}
}

func TestArchivePlanPreservesFilesAndExplicitParents(t *testing.T) {
	plan, err := planArchive([]*zip.File{
		zipEntry("chrome-win64/locales/en-US.pak", 0600, 9), zipEntry("chrome-win64/ABOUT", 0600, 3),
		zipEntry("chrome-win64/chrome.exe", 0700, 7), zipEntry("chrome-win64/", os.ModeDir|0700, 0),
		zipEntry("chrome-win64/locales/", os.ModeDir|0700, 0),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(plan.dirs, []string{"chrome-win64", "chrome-win64/locales"}) {
		t.Fatalf("dirs: %#v", plan.dirs)
	}
	if len(plan.files) != 3 || plan.files[0].Name != "chrome-win64/ABOUT" {
		t.Fatal("files lost or unordered")
	}
}

func archiveBytes(t *testing.T) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for _, file := range []struct{ name, body string }{
		{"chrome-win64/chrome.exe", "synthetic test fixture; never execute"},
		{"chrome-win64/ABOUT", "original distribution notice"},
		{"chrome-win64/locales/en-US.pak", "fixture locale"},
	} {
		entry, err := writer.Create(file.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(file.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}
