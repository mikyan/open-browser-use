package managedviewer

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestCaptureUnsupportedExplainsCompatibilityAndPreservesCleanup(t *testing.T) {
	for _, operation := range []string{"select", "humanBegin"} {
		t.Run(operation, func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				if humanTestOperation(data) == operation && !bytesNullTab(data) {
					return nil, fmt.Errorf("private native details: %w", humanReasonError("OBU_HUMAN_CAPTURE_UNSUPPORTED"))
				}
				return base(ctx, data)
			}
			s := startTest(t, b, nil)
			c := authenticate(t, s)
			send(t, c, fmt.Sprintf(`{"id":1,"operation":%q,"tabId":1}`, operation))
			humanTestCall(t, b, operation)
			m := humanTestReply(t, c, 1)
			var detail map[string]string
			if json.Unmarshal(m["error"], &detail) != nil || len(detail) != 2 || detail["code"] != "BROWSER_CAPTURE_UNSUPPORTED" || !strings.Contains(detail["message"], "推荐浏览器版本") {
				t.Fatalf("missing actionable compatibility error: %s", jsonBytes(m))
			}
			if strings.Contains(string(jsonBytes(m)), "private") || strings.Contains(string(jsonBytes(m)), "stack") {
				t.Fatal("native error leaked")
			}
			if operation == "humanBegin" {
				humanTestCall(t, b, "select")
				send(t, c, humanTestInput(2, 1))
				humanTestError(t, c, 2, "HUMAN_STALE")
			}
		})
	}
}
