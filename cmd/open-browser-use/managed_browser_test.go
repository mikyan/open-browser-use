package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/managedruntime"
	"github.com/spf13/cobra"
)

func managedBrowserTestAccess(t *testing.T) managedBrowserAccess {
	t.Helper()
	unexpected := func(name string) { t.Helper(); t.Errorf("unexpected %s", name) }
	return managedBrowserAccess{
		defaultRoot: func() (string, error) { unexpected("default cache lookup"); return "", errors.New("unexpected") },
		inspect: func(context.Context, string) (managedruntime.Installation, error) {
			unexpected("cache inspection")
			return managedruntime.Installation{}, errors.New("unexpected")
		},
		install: func(context.Context, string) (managedruntime.Installation, error) {
			unexpected("browser installation")
			return managedruntime.Installation{}, errors.New("unexpected")
		},
		executable: func() (string, error) { unexpected("host executable lookup"); return "", errors.New("unexpected") },
	}
}

func executeManagedBrowserTest(ctx context.Context, access managedBrowserAccess, args ...string) (string, error) {
	command := newManagedCommandWithBrowser(access)
	var out bytes.Buffer
	command.SetOut(&out)
	command.SetErr(io.Discard)
	command.SilenceErrors, command.SilenceUsage = true, true
	command.SetArgs(args)
	err := command.ExecuteContext(ctx)
	return out.String(), err
}

func TestManagedBrowserExplicitSelectionNeverReadsCache(t *testing.T) {
	access := managedBrowserTestAccess(t)
	for _, cache := range []string{"", "relative-invalid-cache", filepath.Join(t.TempDir(), "unowned")} {
		selected, err := access.browserPath(context.Background(), "explicit-chromium", cache)
		if err != nil || selected != "explicit-chromium" {
			t.Fatalf("explicit selection changed or fell back: %q %v", selected, err)
		}
	}
}

func TestManagedBrowserDefaultSelectionIsOfflineAndFailClosed(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cache")
	for _, cause := range []error{nil, managedruntime.ErrNotInstalled, errors.New("installed file hash mismatch"), os.ErrPermission} {
		access := managedBrowserTestAccess(t)
		access.defaultRoot = func() (string, error) { return root, nil }
		calls := 0
		access.inspect = func(_ context.Context, actual string) (managedruntime.Installation, error) {
			calls++
			if actual != root {
				t.Fatalf("inspected another cache: %q", actual)
			}
			return managedruntime.Installation{Executable: filepath.Join(root, "verified", "chrome.exe")}, cause
		}
		selected, err := access.browserPath(context.Background(), "", "")
		if calls != 1 {
			t.Fatalf("inspection count %d", calls)
		}
		if cause == nil {
			if err != nil || selected != filepath.Join(root, "verified", "chrome.exe") {
				t.Fatalf("verified cache not selected: %q %v", selected, err)
			}
		} else {
			if !errors.Is(err, cause) || selected != "" {
				t.Fatalf("cache error fell back or was lost: %q %v", selected, err)
			}
			if errors.Is(cause, managedruntime.ErrNotInstalled) && (!strings.Contains(err.Error(), "managed browser install") || !strings.Contains(err.Error(), "--browser-path")) {
				t.Fatalf("missing install guidance: %v", err)
			}
		}
	}
	if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("offline selection created the cache")
	}
}

func TestManagedExtensionSelectionUsesOnlyExecutableNeighbour(t *testing.T) {
	root := t.TempDir()
	executable := filepath.Join(root, "package", "open-browser-use.exe")
	adjacent := filepath.Join(filepath.Dir(executable), "extension")
	if path, err := managedExtensionPath("explicit-extension", executable); err != nil || path != "explicit-extension" {
		t.Fatalf("explicit extension replaced: %s %v", path, err)
	}
	if err := os.MkdirAll(filepath.Join(root, "extension"), 0700); err != nil {
		t.Fatal(err)
	}
	if path, err := managedExtensionPath("", executable); err == nil || path != "" || !strings.Contains(err.Error(), "--extension-dir") {
		t.Fatalf("searched another directory or omitted guidance: %q %v", path, err)
	}
	if err := os.MkdirAll(adjacent, 0700); err != nil {
		t.Fatal(err)
	}
	if path, err := managedExtensionPath("", executable); err != nil || path != adjacent {
		t.Fatalf("wrong adjacent extension: %q %v", path, err)
	}
	file := filepath.Join(root, "file-neighbour", "extension")
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("not a directory"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := managedExtensionPath("", filepath.Join(filepath.Dir(file), "open-browser-use.exe")); err == nil {
		t.Fatal("adjacent ordinary file accepted as extension")
	}
}

func TestManagedBrowserCommandsSeparateOfflineStatusFromExplicitInstall(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cache")
	expected := managedruntime.Installation{Version: managedruntime.RecommendedVersion, Platform: "win64", Executable: filepath.Join(root, "chrome.exe"), ArchiveSHA256: strings.Repeat("a", 64), ExecutableSHA256: strings.Repeat("b", 64), Reused: true}
	for _, operation := range []string{"status", "install"} {
		t.Run(operation, func(t *testing.T) {
			access := managedBrowserTestAccess(t)
			calls := 0
			action := func(ctx context.Context, actual string) (managedruntime.Installation, error) {
				calls++
				if actual != root {
					t.Fatalf("wrong owned cache: %q", actual)
				}
				if operation == "install" {
					deadline, ok := ctx.Deadline()
					if !ok || time.Until(deadline) <= 0 || time.Until(deadline) > managedBrowserInstallTimeout {
						t.Fatal("install has no bounded original deadline")
					}
				}
				return expected, nil
			}
			if operation == "status" {
				access.inspect = action
			} else {
				access.install = action
			}
			out, err := executeManagedBrowserTest(context.Background(), access, "browser", operation, "--browser-cache", root)
			if err != nil || calls != 1 {
				t.Fatalf("command failed: calls=%d err=%v", calls, err)
			}
			var got managedruntime.Installation
			if json.Unmarshal([]byte(out), &got) != nil || got != expected {
				t.Fatalf("original installation result not preserved: %s", out)
			}
		})
	}
	if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("CLI created cache outside the runtime operation")
	}
}

func TestManagedBrowserInstallBudgetAndCancellation(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cache")
	for _, timeout := range []string{"0", "-1s", "10m1s"} {
		out, err := executeManagedBrowserTest(context.Background(), managedBrowserTestAccess(t), "browser", "install", "--browser-cache", root, "--timeout", timeout)
		if err == nil || !strings.Contains(err.Error(), "--timeout") || out != "" {
			t.Fatalf("invalid budget admitted: %s %v", out, err)
		}
	}
	access := managedBrowserTestAccess(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	access.install = func(original context.Context, _ string) (managedruntime.Installation, error) {
		cancel()
		<-original.Done()
		return managedruntime.Installation{}, original.Err()
	}
	out, err := executeManagedBrowserTest(ctx, access, "browser", "install", "--browser-cache", root)
	if !errors.Is(err, context.Canceled) || out != "" {
		t.Fatalf("cancelled installation reported success: %s %v", out, err)
	}
}

func TestManagedLaunchResolvesLocalInputsBeforeSupervisor(t *testing.T) {
	for _, operation := range []string{"run", "setup"} {
		t.Run(operation, func(t *testing.T) {
			access := managedBrowserTestAccess(t)
			root := filepath.Join(t.TempDir(), "cache")
			access.inspect = func(ctx context.Context, _ string) (managedruntime.Installation, error) {
				if _, ok := ctx.Deadline(); !ok {
					t.Fatal("cache validation escaped the startup deadline")
				}
				return managedruntime.Installation{}, managedruntime.ErrNotInstalled
			}
			// An invalid supervisor root must never be reached: no browser/cache
			// side effect is allowed before all local launch inputs are resolved.
			out, err := executeManagedBrowserTest(context.Background(), access, operation, "--root", "relative-root", "--browser-cache", root)
			if !errors.Is(err, managedruntime.ErrNotInstalled) || out != "" {
				t.Fatalf("missing cache did not stop before supervisor setup: %s %v", out, err)
			}
		})
	}
	access := managedBrowserTestAccess(t)
	access.executable = func() (string, error) { return filepath.Join(t.TempDir(), "open-browser-use.exe"), nil }
	out, err := executeManagedBrowserTest(context.Background(), access, "run", "--root", "relative-root", "--browser-path", "explicit-browser", "--browser-cache", "invalid-unused-cache")
	if err == nil || !strings.Contains(err.Error(), "--extension-dir") || out != "" {
		t.Fatalf("missing adjacent extension reached supervisor setup: %s %v", out, err)
	}
}

func TestManagedLaunchExplicitFlagsBypassCacheAndAdjacentLookup(t *testing.T) {
	_, expected := managedControlAddress("relative-root", "default")
	if expected == nil {
		t.Fatal("test requires an invalid supervisor root")
	}
	for _, operation := range []string{"run", "setup"} {
		t.Run(operation, func(t *testing.T) {
			access := managedBrowserTestAccess(t)
			args := []string{operation, "--root", "relative-root", "--browser-path", "explicit-browser", "--browser-cache", "invalid-unused-cache"}
			if operation == "run" {
				access.executable = func() (string, error) { return filepath.Join(t.TempDir(), "open-browser-use.exe"), nil }
				args = append(args, "--extension-dir", "explicit-extension")
			}
			out, err := executeManagedBrowserTest(context.Background(), access, args...)
			if err == nil || err.Error() != expected.Error() || out != "" {
				t.Fatalf("explicit flags consulted fallback inputs or started supervision: %s %v", out, err)
			}
		})
	}
}

func TestManagedBrowserFlagsHaveNoImplicitDownloadOrVersionOverride(t *testing.T) {
	command := newManagedCommandWithBrowser(managedBrowserTestAccess(t))
	for _, name := range []string{"run", "setup"} {
		child, _, err := command.Find([]string{name})
		if err != nil {
			t.Fatal(err)
		}
		for _, flagName := range []string{"browser-path", "extension-dir"} {
			flag := child.Flags().Lookup(flagName)
			if flag != nil && len(flag.Annotations[cobra.BashCompOneRequiredFlag]) != 0 {
				t.Fatalf("%s still requires %s", name, flagName)
			}
		}
		if child.Flags().Lookup("browser-cache") == nil {
			t.Fatalf("%s has no explicit cache selector", name)
		}
	}
	for _, flag := range []string{"--url", "--version"} {
		_, err := executeManagedBrowserTest(context.Background(), managedBrowserTestAccess(t), "browser", "install", flag, "untrusted")
		if err == nil || !strings.Contains(err.Error(), "unknown flag") {
			t.Fatalf("runtime source override accepted: %v", err)
		}
	}
	if strings.Contains(command.Long, "Navigation ends takeover") {
		t.Fatal("obsolete takeover boundary remains in CLI help")
	}
}
