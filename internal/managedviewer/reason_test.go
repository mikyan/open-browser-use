package managedviewer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

type humanReasonError string

func (humanReasonError) Error() string {
	return "private-key=do-not-leak\n at secret native stack and target"
}
func (e humanReasonError) UserErrorCode() string { return string(e) }

func assertHumanReasonReply(t *testing.T, m map[string]json.RawMessage, reason string) {
	t.Helper()
	var detail map[string]string
	if json.Unmarshal(m["error"], &detail) != nil || detail["code"] != "OPERATION_UNCONFIRMED" || detail["message"] != "未能确认操作结果。请刷新状态，勿自动重试操作。" || detail["reasonCode"] != reason {
		t.Fatalf("unexpected public failure: %s", jsonBytes(m))
	}
	if reason == "" {
		if _, ok := detail["reasonCode"]; ok {
			t.Fatal("unknown reason was emitted")
		}
	} else if len(detail) != 3 {
		t.Fatal("unexpected public diagnostics")
	}
	for _, secret := range []string{"private-key", "secret native", "at secret", "wrapped"} {
		if strings.Contains(string(jsonBytes(m)), secret) {
			t.Fatal("native error leaked")
		}
	}
}

func TestHumanFailureReasonAllowlistPreservesCleanup(t *testing.T) {
	for _, prefix := range []string{"OBU_HUMAN_", "OBU_MANAGED_USER_HUMAN_"} {
		for _, suffix := range []string{"GEOMETRY", "INVALID", "BUSY", "UNAVAILABLE"} {
			reason := prefix + suffix
			t.Run(reason, func(t *testing.T) {
				b := humanTestBackend()
				base := b.command
				b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
					if humanTestOperation(data) == "humanInput" {
						return nil, fmt.Errorf("wrapped private details: %w", humanReasonError(reason))
					}
					return base(ctx, data)
				}
				s := startTest(t, b, nil)
				c := humanTestBegin(t, b, s)
				send(t, c, humanTestInput(2, 1))
				humanTestCall(t, b, "humanInput")
				assertHumanReasonReply(t, humanTestReply(t, c, 2), reason)
				humanTestCall(t, b, "select") // The original failure still starts cleanup.
				send(t, c, humanTestInput(3, 2))
				humanTestError(t, c, 3, "HUMAN_STALE")
			})
		}
	}
}

func TestHumanFailureReasonUnknownDoesNotExposeException(t *testing.T) {
	for _, failure := range []error{
		humanReasonError("OBU_HUMAN_GEOMETRY_PRIVATE_SUFFIX"),
		humanReasonError("OBU_HUMAN_CLEANUP_INCOMPLETE"),
		humanReasonError("OBU_OTHER_GEOMETRY"),
		errors.New("OBU_HUMAN_GEOMETRY: private-key=do-not-leak\n at secret native stack"),
	} {
		b := humanTestBackend()
		base := b.command
		b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
			if humanTestOperation(data) == "humanInput" {
				return nil, failure
			}
			return base(ctx, data)
		}
		s := startTest(t, b, nil)
		c := humanTestBegin(t, b, s)
		send(t, c, humanTestInput(2, 1))
		humanTestCall(t, b, "humanInput")
		assertHumanReasonReply(t, humanTestReply(t, c, 2), "")
		humanTestCall(t, b, "select")
	}
}

func TestHumanFailureReasonOnlyBeginAndInput(t *testing.T) {
	for _, operation := range []string{"humanBegin", "status", "humanEnd", "pause", "select", "resume", "stop"} {
		got := humanFailureReason(operation, humanReasonError("OBU_HUMAN_GEOMETRY"))
		if (operation == "humanBegin") != (got == "OBU_HUMAN_GEOMETRY") {
			t.Fatalf("unexpected reason for %s: %s", operation, got)
		}
	}
	b := humanTestBackend()
	base := b.command
	b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
		if humanTestOperation(data) == "humanBegin" {
			return nil, humanReasonError("OBU_HUMAN_UNAVAILABLE")
		}
		return base(ctx, data)
	}
	s := startTest(t, b, nil)
	c := authenticate(t, s)
	send(t, c, `{"id":1,"operation":"humanBegin","tabId":1}`)
	humanTestCall(t, b, "humanBegin")
	assertHumanReasonReply(t, humanTestReply(t, c, 1), "OBU_HUMAN_UNAVAILABLE")
	humanTestCall(t, b, "select")
}
