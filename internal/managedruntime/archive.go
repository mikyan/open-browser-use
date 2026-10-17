package managedruntime

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

func validComponent(part string) bool {
	if part == "" || part == "." || part == ".." || len(part) > 255 || !utf8.ValidString(part) || strings.TrimRight(part, " .") != part || strings.ContainsAny(part, `<>:"/\|?*`) {
		return false
	}
	for _, c := range part {
		if c < 32 || c == 127 {
			return false
		}
	}
	base, _, _ := strings.Cut(part, ".")
	base = strings.ToUpper(base)
	switch base {
	case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$":
		return false
	}
	if strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT") {
		tail := strings.TrimPrefix(strings.TrimPrefix(base, "COM"), "LPT")
		if strings.Contains("123456789¹²³", tail) && len([]rune(tail)) == 1 {
			return false
		}
	}
	return true
}

func validateArchiveName(name string) error {
	if len(name) > 4096 || (name != "chrome-win64" && !strings.HasPrefix(name, "chrome-win64/")) {
		return errors.New("archive path is outside the expected chrome-win64 directory")
	}
	for _, part := range strings.Split(name, "/") {
		if !validComponent(part) {
			return errors.New("archive contains an unsafe Windows path")
		}
	}
	return nil
}

func addName(seen map[string]string, name string) error {
	if err := validateArchiveName(name); err != nil {
		return err
	}
	key := strings.ToLower(name)
	if _, ok := seen[key]; ok {
		return errors.New("archive or manifest contains duplicate case-insensitive paths")
	}
	seen[key] = name
	return nil
}

type archivePlan struct {
	dirs  []string
	files []*zip.File
}

// Validate the complete central directory before creating an extracted path.
// Parent directories count toward the bounded manifest too; implicit parents
// may be declared once explicitly, but a file can never become a directory.
func planArchive(files []*zip.File) (archivePlan, error) {
	if len(files) == 0 || len(files) > entryLimit {
		return archivePlan{}, errors.New("managed browser archive entry limit exceeded")
	}
	names := map[string]string{}
	kinds := map[string]bool{} // true means directory
	explicit := map[string]bool{}
	dirs := map[string]bool{}
	result := archivePlan{}
	var total uint64
	register := func(name string, directory, declared bool) error {
		if err := validateArchiveName(name); err != nil {
			return err
		}
		key := strings.ToLower(name)
		if old, ok := names[key]; ok {
			if old != name || kinds[key] != directory || !directory || (declared && explicit[key]) {
				return errors.New("archive has colliding file or directory paths")
			}
		} else {
			names[key], kinds[key] = name, directory
		}
		if declared {
			explicit[key] = true
		}
		if directory {
			dirs[name] = true
		}
		if len(names) > entryLimit*2 {
			return errors.New("archive expanded path count exceeds limit")
		}
		return nil
	}
	for _, file := range files {
		name := strings.TrimSuffix(file.Name, "/")
		mode := file.Mode()
		isDir := mode.IsDir()
		if (!isDir && !mode.IsRegular()) || strings.HasSuffix(file.Name, "/") != isDir {
			return archivePlan{}, errors.New("archive contains a link or nonregular entry")
		}
		if err := register(name, isDir, true); err != nil {
			return archivePlan{}, err
		}
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if err := register(parent, true, false); err != nil {
				return archivePlan{}, err
			}
		}
		if isDir {
			if file.UncompressedSize64 != 0 {
				return archivePlan{}, errors.New("archive directory contains unexpected bytes")
			}
			continue
		}
		if file.UncompressedSize64 > expandedLimit-total {
			return archivePlan{}, errors.New("managed browser expanded size limit exceeded")
		}
		total += file.UncompressedSize64
		result.files = append(result.files, file)
	}
	if kinds["chrome-win64/chrome.exe"] || names["chrome-win64/chrome.exe"] != "chrome-win64/chrome.exe" {
		return archivePlan{}, errors.New("managed browser archive lacks chrome.exe")
	}
	result.dirs = sortedKeys(dirs)
	sort.Slice(result.files, func(i, j int) bool { return result.files[i].Name < result.files[j].Name })
	return result, nil
}

func extract(ctx context.Context, archive, stage, version, digest string) (_ manifest, err error) {
	info, err := os.Lstat(archive)
	if err != nil {
		return manifest{}, err
	}
	if !info.Mode().IsRegular() || info.Size() > compressedLimit {
		return manifest{}, errors.New("managed browser archive type or size is invalid")
	}
	reader, err := zip.OpenReader(archive)
	if err != nil {
		return manifest{}, fmt.Errorf("managed browser archive is invalid: %w", err)
	}
	defer func() { err = errors.Join(err, reader.Close()) }()
	plan, err := planArchive(reader.File)
	if err != nil {
		return manifest{}, err
	}
	m := manifest{Schema: 1, Version: version, Platform: "win64", ArchiveSHA256: digest, Directories: plan.dirs}
	for _, directory := range plan.dirs {
		if err := checkContext(ctx); err != nil {
			return manifest{}, err
		}
		name := filepath.Join(stage, filepath.FromSlash(directory))
		if err := platformValidatePath(name); err != nil {
			return manifest{}, err
		}
		if err := os.MkdirAll(name, 0700); err != nil {
			return manifest{}, err
		}
	}
	for _, file := range plan.files {
		if err := checkContext(ctx); err != nil {
			return manifest{}, err
		}
		record, err := extractFile(ctx, file, stage)
		if err != nil {
			return manifest{}, err
		}
		m.Files = append(m.Files, record)
	}
	return m, nil
}

func extractFile(ctx context.Context, entry *zip.File, stage string) (_ fileRecord, err error) {
	name := filepath.Join(stage, filepath.FromSlash(entry.Name))
	if err := platformValidatePath(name); err != nil {
		return fileRecord{}, err
	}
	reader, err := entry.Open()
	if err != nil {
		return fileRecord{}, err
	}
	defer func() { err = errors.Join(err, reader.Close()) }()
	file, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return fileRecord{}, err
	}
	defer func() { err = errors.Join(err, file.Close()) }()
	h := sha256.New()
	n, err := io.CopyBuffer(io.MultiWriter(file, h), io.LimitReader(&contextReader{ctx, reader}, int64(entry.UncompressedSize64)+1), make([]byte, 128<<10))
	if err != nil {
		return fileRecord{}, fmt.Errorf("managed browser archive file integrity failed: %w", err)
	}
	if n != int64(entry.UncompressedSize64) {
		return fileRecord{}, errors.New("managed browser archive expanded file size does not match")
	}
	if err := file.Sync(); err != nil {
		return fileRecord{}, err
	}
	return fileRecord{Path: entry.Name, Size: n, SHA256: hex.EncodeToString(h.Sum(nil))}, nil
}
