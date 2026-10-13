package obu

import (
	"net"
	"strings"
	"testing"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

func TestDialogRawRequiresCapabilityBeforeDecision(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		for {
			var r map[string]any
			if wire.ReadJSON(conn, &r) != nil {
				return
			}
			var result any = Params{}
			switch r["method"] {
			case "getInfo":
				result = Params{"metadata": Params{"turnLifecycleVersion": 1}}
			case "getControlState":
				result = testControlState(7, "next")
			default:
				t.Error("unsupported dialog request reached peer", r["method"])
			}
			writeResponse(t, conn, r["id"], result)
		}
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path})
	defer c.Close()
	if _, err := c.Request("armDialog", Params{"tabId": 9, "type": "confirm", "accept": true}); err == nil || !strings.Contains(err.Error(), "OBU_DIALOG_UNSUPPORTED") {
		t.Fatalf("unsupported decision accepted: %v", err)
	}
}
