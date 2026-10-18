package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/ifuryst/open-browser-use/internal/managedbrowser"
)

func TestManagedStopClearsOnlyTheSettledOwnedExitWait(t *testing.T) {
	pending := managedbrowser.ErrUserCleanupPendingOwnedExit
	unknown := errors.New("native cleanup acknowledgement missing")
	for _, tc := range []struct {
		name                      string
		initial, session, settled error
		want                      []error
	}{
		{name: "normal"},
		{name: "owned exit settles pending", initial: pending},
		{name: "session failed", initial: pending, session: unknown, want: []error{pending, unknown}},
		{name: "session timed out", initial: pending, session: context.DeadlineExceeded, want: []error{pending, context.DeadlineExceeded}},
		{name: "controller not settled", initial: pending, settled: context.DeadlineExceeded, want: []error{pending, context.DeadlineExceeded}},
		{name: "different initial failure", initial: unknown, want: []error{unknown}},
		{name: "initial timeout", initial: context.DeadlineExceeded, want: []error{context.DeadlineExceeded}},
		{name: "same text is not the sentinel", initial: errors.New(pending.Error()), want: []error{nil}},
		{name: "joined unknown error", initial: errors.Join(pending, unknown), want: []error{pending, unknown}},
		{name: "wrapped pending", initial: fmt.Errorf("other cleanup: %w", pending), want: []error{pending}},
		{name: "settled failure", settled: unknown, want: []error{unknown}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var order []string
			calls := 0
			err := closeManagedRuntimeResources(func(ctx context.Context) error {
				order = append(order, "session")
				if calls != 1 {
					t.Fatal("owned Session closed before the original controller was revoked")
				}
				if _, ok := ctx.Deadline(); !ok {
					t.Fatal("Session wait lost its bound")
				}
				return tc.session
			}, func(ctx context.Context) error {
				calls++
				order = append(order, "controller")
				if _, ok := ctx.Deadline(); !ok {
					t.Fatal("controller wait lost its bound")
				}
				if calls == 1 {
					return tc.initial
				}
				return tc.settled
			})
			if strings.Join(order, ",") != "controller,session,controller" {
				t.Fatalf("original cleanup ordering changed: %v", order)
			}
			if len(tc.want) == 0 && err != nil {
				t.Fatalf("completed Stop retained an expected pending wait: %v", err)
			}
			if len(tc.want) != 0 && err == nil {
				t.Fatal("unconfirmed cleanup or a different failure was swallowed")
			}
			for _, expected := range tc.want {
				if expected != nil && !errors.Is(err, expected) {
					t.Fatalf("original failure was lost: %v", err)
				}
			}
		})
	}
}
