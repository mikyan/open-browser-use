package managedruntime

import (
	"context"
	"errors"
	"io"
	"os"
	"path"
	"regexp"
	"strings"
)

// Chromium 155 Windows uses DIR_EXE/Dictionaries even with --user-data-dir.
// These runtime data files are not part of the pinned archive or its manifest.
// Do not broaden this to a general writable cache or claim dictionary authenticity.
const dictionaryDirectory = "chrome-win64/Dictionaries"
const dictionaryFileLimit = 64
const dictionarySizeLimit int64 = 32 << 20
const dictionaryTotalLimit int64 = 128 << 20

var dictionaryName = regexp.MustCompile(`^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*-[0-9]{1,4}-[0-9]{1,4}\.bdic$`)

type dictionaryCache struct {
	count int
	bytes int64
	seen  map[string]bool
}

func (cache *dictionaryCache) check(ctx context.Context, filename, relative string) (err error) {
	if err := checkContext(ctx); err != nil {
		return err
	}
	base := path.Base(relative)
	if path.Dir(relative) != dictionaryDirectory || len(base) > 128 || !dictionaryName.MatchString(base) {
		return errors.New("managed browser contains an unexpected dictionary cache path")
	}
	key := strings.ToLower(base)
	if cache.seen[key] || cache.count >= dictionaryFileLimit {
		return errors.New("managed browser dictionary cache count or identity is invalid")
	}
	file, err := os.Open(filename)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, file.Close()) }()
	if err := platformValidateDictionary(file); err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() < 32 || info.Size() > dictionarySizeLimit || info.Size() > dictionaryTotalLimit-cache.bytes {
		return errors.New("managed browser dictionary cache type or size limit is invalid")
	}
	var header [4]byte
	if _, err := io.ReadFull(&contextReader{ctx, file}, header[:]); err != nil {
		return err
	}
	if string(header[:]) != "BDic" {
		return errors.New("managed browser dictionary cache has no BDic header")
	}
	// A header is a narrow format filter, not a replacement for Chromium's BDict
	// parser. The original archive files above still require their exact hashes.
	after, err := capturedInfo(filename)
	if err != nil {
		return err
	}
	if !os.SameFile(info, after) || info.Size() != after.Size() || !info.ModTime().Equal(after.ModTime()) {
		return errors.New("managed browser dictionary cache changed during inspection")
	}
	if cache.seen == nil {
		cache.seen = map[string]bool{}
	}
	cache.seen[key] = true
	cache.count++
	cache.bytes += info.Size()
	return nil
}
