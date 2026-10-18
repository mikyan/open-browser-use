package managedbrowser

import (
	"encoding/json"
	"testing"
)

// Context IDs alone must not override a supplied unique ID, and an unrelated
// context's destruction must not retire the original worker execution.
func TestManagedUserOriginalExecutionEndIsExact(t *testing.T) {
	for _, tc := range []struct {
		name, session, method, params string
		ended, invalid                bool
	}{
		{"exact unique context", "worker-session", "Runtime.executionContextDestroyed", `{"executionContextId":7,"executionContextUniqueId":"original-context"}`, true, false},
		{"original numeric context", "worker-session", "Runtime.executionContextDestroyed", `{"executionContextId":7}`, true, false},
		{"other numeric context", "worker-session", "Runtime.executionContextDestroyed", `{"executionContextId":8}`, false, false},
		{"reused numeric id", "worker-session", "Runtime.executionContextDestroyed", `{"executionContextId":7,"executionContextUniqueId":"another-execution"}`, false, false},
		{"exact session cleared", "worker-session", "Runtime.executionContextsCleared", `{}`, true, false},
		{"foreign session cleared", "foreign-session", "Runtime.executionContextsCleared", `{}`, false, true},
		{"missing context identity", "worker-session", "Runtime.executionContextDestroyed", `{}`, false, true},
		{"nonobject cleared", "worker-session", "Runtime.executionContextsCleared", `null`, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newUserFixture(t, func(_ *userFixture, request userTestRequest) bool {
				return request.Operation == "retire" // No invented bridge cleanup receipt.
			}, false)
			c := f.open()
			err := c.handleEvent(tc.session, tc.method, json.RawMessage(tc.params))
			if (err != nil) != tc.invalid {
				t.Fatalf("event validation error = %v; invalid=%t", err, tc.invalid)
			}
			select {
			case <-c.workerGone:
				if !tc.ended {
					t.Fatal("unrelated or malformed event proved original execution ended")
				}
			default:
				if tc.ended {
					t.Fatal("exact original execution end was not retained")
				}
			}
			if !tc.ended && !tc.invalid {
				select {
				case <-c.Done():
					t.Fatal("unrelated execution event retired live original controller")
				default:
				}
			}
		})
	}
}
