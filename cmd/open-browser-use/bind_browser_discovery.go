package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"github.com/ifuryst/open-browser-use/internal/browserdownloads"
)

const bindPortFileLimit = 4096

// A blocked filesystem call can outlive its caller's context. Permit at most
// one discovery reader in this process, including after the caller times out.
// The worker owns and eventually closes its file; no result triggers a retry.
var bindPortFileReader = make(chan struct{}, 1)

var readBindPortFile = readBindPortFileOnce

func bindBrowserRoot(browser, explicit string, hasExplicit bool) (string, error) {
	if browser != "chrome" && browser != "edge" {
		return "", errors.New("bind-browser --auto-connect requires --browser chrome or edge (stable)")
	}
	root := explicit
	if !hasExplicit {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		roots, err := browserCatalogueWithEnvironment(runtime.GOOS, home, os.Getenv("LOCALAPPDATA"), os.Getenv("APPDATA"), os.Getenv("XDG_CONFIG_HOME"))
		if err != nil {
			return "", err
		}
		for _, candidate := range roots {
			if candidate.BrowserID == browser {
				root = candidate.Root
				break
			}
		}
	}
	if !filepath.IsAbs(root) || strings.ContainsRune(root, 0) {
		return "", errors.New("bind-browser --user-data-dir must be an absolute local browser root")
	}
	if runtime.GOOS == "windows" && strings.HasPrefix(strings.ReplaceAll(root, "/", `\`), `\\`) {
		return "", errors.New("bind-browser does not read UNC or device user-data paths")
	}
	return filepath.Clean(root), nil
}

func discoverBindBrowser(ctx context.Context, root string) (string, error) {
	if err := bindContextError(ctx); err != nil {
		return "", err
	}
	select {
	case bindPortFileReader <- struct{}{}:
	default:
		return "", errors.New("bind-browser discovery reader is still busy; no second filesystem read started")
	}
	type result struct {
		url string
		err error
	}
	ready := make(chan result, 1)
	read := readBindPortFile
	go func() {
		url, err := read(ctx, filepath.Join(root, "DevToolsActivePort"))
		<-bindPortFileReader
		ready <- result{url, err}
	}()
	select {
	case value := <-ready:
		if err := bindContextError(ctx); err != nil {
			return "", err
		}
		return value.url, value.err
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func readBindPortFileOnce(ctx context.Context, path string) (string, error) {
	if err := bindContextError(ctx); err != nil {
		return "", err
	}
	before, err := os.Lstat(path)
	if err != nil {
		return "", fmt.Errorf("bind-browser: read selected DevToolsActivePort (enable remote debugging in the selected browser): %w", err)
	}
	if !before.Mode().IsRegular() || before.Size() < 1 || before.Size() > bindPortFileLimit {
		return "", errors.New("bind-browser: DevToolsActivePort must be a regular file of 1 to 4096 bytes")
	}
	if err := bindContextError(ctx); err != nil {
		return "", err
	}
	file, err := openBindPortFile(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return "", err
	}
	if !opened.Mode().IsRegular() || !os.SameFile(before, opened) || opened.Size() != before.Size() {
		return "", errors.New("bind-browser: DevToolsActivePort changed or is not a regular file")
	}
	if err := bindContextError(ctx); err != nil {
		return "", err
	}
	data, err := io.ReadAll(io.LimitReader(file, bindPortFileLimit+1))
	if err != nil {
		return "", err
	}
	if err := bindContextError(ctx); err != nil {
		return "", err
	}
	after, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !after.Mode().IsRegular() || !os.SameFile(opened, after) || int64(len(data)) != opened.Size() || after.Size() != opened.Size() || len(data) > bindPortFileLimit {
		return "", errors.New("bind-browser: DevToolsActivePort changed during its bounded read")
	}
	return parseBindPortFile(data)
}

var bindPortFilePattern = regexp.MustCompile(`^([1-9][0-9]{0,4})\r?\n(/devtools/browser/[A-Za-z0-9._~-]{1,256})(\r?\n)?$`)

func parseBindPortFile(data []byte) (string, error) {
	if len(data) == 0 || len(data) > bindPortFileLimit {
		return "", errors.New("bind-browser: invalid DevToolsActivePort size")
	}
	match := bindPortFilePattern.FindSubmatch(data)
	if match == nil {
		return "", errors.New("bind-browser: DevToolsActivePort must contain exactly a port and /devtools/browser/<id> on two lines")
	}
	port, err := strconv.Atoi(string(match[1]))
	if err != nil || port < 1 || port > 65535 {
		return "", errors.New("bind-browser: DevToolsActivePort port is outside 1 to 65535")
	}
	url := "ws://127.0.0.1:" + string(match[1]) + string(match[2])
	if err := browserdownloads.ValidateURL(url); err != nil {
		return "", err
	}
	return url, nil
}
