//go:build windows

package managedruntime

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// This executes only this test binary in a child process, never chrome.exe.
func TestNativeCacheLockHelper(t *testing.T) {
	root := os.Getenv("OBU_RUNTIME_LOCK_HELPER_ROOT")
	if root == "" {
		return
	}
	lock, err := platformLock(root, false)
	if os.Getenv("OBU_RUNTIME_LOCK_HELPER_EXPECT") == "busy" {
		if !errors.Is(err, ErrBusy) {
			t.Fatalf("expected original cross-process lock: %v", err)
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestNativeCacheLockExcludesAnotherProcessAndReleases(t *testing.T) {
	root := t.TempDir()
	lock, err := platformLock(root, true)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	run := func(expected string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestNativeCacheLockHelper$", "-test.count=1")
		command.Env = append(os.Environ(), "OBU_RUNTIME_LOCK_HELPER_ROOT="+root, "OBU_RUNTIME_LOCK_HELPER_EXPECT="+expected)
		command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("native lock child: %v\n%s", err, output)
		}
	}
	run("busy")
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	run("free")
	if err := lock.Close(); err != nil {
		t.Fatal("idempotent lock close", err)
	}
}

func TestLockInspectionNeverCreatesAndRejectsUnknownLockContent(t *testing.T) {
	root := t.TempDir()
	if _, err := platformLock(root, false); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing lock: %v", err)
	}
	name := filepath.Join(root, lockName)
	if _, err := os.Stat(name); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("read-only lock inspection created a file")
	}
	if err := os.WriteFile(name, []byte("unknown lock"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := platformLock(root, true); err == nil {
		t.Fatal("unknown lock file accepted")
	}
	data, err := os.ReadFile(name)
	if err != nil || string(data) != "unknown lock" {
		t.Fatal("unknown lock overwritten")
	}
}

func TestStageCleanupRequiresOriginalDirectoryIdentity(t *testing.T) {
	root := t.TempDir()
	stage := filepath.Join(root, ".stage-original")
	if err := os.Mkdir(stage, 0700); err != nil {
		t.Fatal(err)
	}
	original, err := capturedInfo(stage)
	if err != nil {
		t.Fatal(err)
	}
	retained := filepath.Join(root, "retained-original")
	if err := os.Rename(stage, retained); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(stage, 0700); err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(stage, "foreign.txt")
	if err := os.WriteFile(foreign, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := removeStage(root, stage, original); err == nil {
		t.Fatal("replaced stage accepted")
	}
	if data, err := os.ReadFile(foreign); err != nil || string(data) != "keep" {
		t.Fatal("replacement deleted")
	}
	if err := removeStage(root, retained, original); err == nil {
		t.Fatal("unowned name accepted")
	}
	if _, err := os.Stat(retained); err != nil {
		t.Fatal("retained original deleted")
	}
	current, err := capturedInfo(stage)
	if err != nil {
		t.Fatal(err)
	}
	if err := removeStage(root, stage, current); err != nil {
		t.Fatal("exact owned stage cleanup", err)
	}
	if _, err := os.Stat(stage); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("owned stage still exists")
	}
}

func TestExistingFileCannotBeAPathAncestor(t *testing.T) {
	file := filepath.Join(t.TempDir(), "ordinary-file")
	if err := os.WriteFile(file, []byte("retain"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := platformValidatePath(filepath.Join(file, "child")); err == nil {
		t.Fatal("file ancestor accepted")
	}
}
