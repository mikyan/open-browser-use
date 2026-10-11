package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func nativeHostRegistration(key string) (string, error) {
	const prefix = `HKCU\`
	if !strings.HasPrefix(key, prefix) {
		return "", fmt.Errorf("unsupported registry hive: %s", key)
	}
	var selected string
	for _, view := range []uint32{registry.WOW64_32KEY, registry.WOW64_64KEY} {
		handle, err := registry.OpenKey(registry.CURRENT_USER, strings.TrimPrefix(key, prefix), registry.QUERY_VALUE|view)
		if errors.Is(err, registry.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		value, kind, err := handle.GetStringValue("")
		handle.Close()
		if err != nil || kind != registry.SZ || !filepath.IsAbs(value) {
			return "", fmt.Errorf("invalid native host registration value in registry view %d", view)
		}
		if selected != "" && !samePath(selected, value) {
			return "", errors.New("32-bit and 64-bit native host registrations point to different manifests")
		}
		selected = value
	}
	return selected, nil
}

func lockNativeInstallation(path string) (func(), error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	overlapped := &windows.Overlapped{}
	if err := windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, overlapped); err != nil {
		file.Close()
		return nil, err
	}
	return func() { windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, overlapped); file.Close() }, nil
}

func replaceNativeManifest(source, target string) error {
	from, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
