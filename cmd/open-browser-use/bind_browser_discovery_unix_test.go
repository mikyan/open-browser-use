//go:build !windows

package main

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestBindBrowserPortFIFOIsRejectedWithoutOpening(t *testing.T) {
	root := t.TempDir()
	if err := unix.Mkfifo(filepath.Join(root, "DevToolsActivePort"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := discoverBindBrowser(ctx, root); err == nil || ctx.Err() != nil {
		t.Fatalf("FIFO was opened or consumed its deadline: %v, %v", err, ctx.Err())
	}
	if len(bindPortFileReader) != 0 {
		t.Fatal("FIFO left an outstanding reader")
	}
}
