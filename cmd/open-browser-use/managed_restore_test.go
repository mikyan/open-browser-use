package main

import (
	"context"
	"strings"
	"testing"
)

func TestManagedRestoreFlagIsOptInAndRunOnly(t *testing.T) {
	for _, args := range [][]string{nil, {"--restore"}, {"--restore=false"}} {
		command := newManagedCommandWithBrowser(managedBrowserTestAccess(t))
		run, _, err := command.Find([]string{"run"})
		if err != nil {
			t.Fatal(err)
		}
		flag := run.Flags().Lookup("restore")
		if flag == nil || flag.DefValue != "false" {
			t.Fatal("restore is missing or enabled by default")
		}
		if err := run.ParseFlags(args); err != nil {
			t.Fatal(err)
		}
		value, err := run.Flags().GetBool("restore")
		if err != nil || value != (len(args) == 1 && args[0] == "--restore") {
			t.Fatalf("restore request not parsed exactly: %v => %v %v", args, value, err)
		}
		for _, operation := range []string{"setup", "recover", "status", "stop", "view"} {
			child, _, err := command.Find([]string{operation})
			if err != nil {
				t.Fatal(err)
			}
			if child.Flags().Lookup("restore") != nil || child.InheritedFlags().Lookup("restore") != nil {
				t.Fatalf("%s accepts browser restore", operation)
			}
			if err := child.ParseFlags([]string{"--restore"}); err == nil {
				t.Fatalf("%s silently accepted a run-only restore request", operation)
			}
		}
	}
}

func TestManagedRestoreHelpDescribesIntentAndFreshOwnership(t *testing.T) {
	out, err := executeManagedBrowserTest(context.Background(), managedBrowserTestAccess(t), "run", "--help")
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"--restore", "request Chromium's native session restore", "same dedicated profile", "new run", "new handles", "explicit page claims", "without guaranteeing restored pages or memory"} {
		if !strings.Contains(out, text) {
			t.Fatalf("restore help omits %q: %s", text, out)
		}
	}
}
