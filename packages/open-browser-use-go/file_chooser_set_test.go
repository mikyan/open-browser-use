package obu

import (
	"net"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

type chooserDeadlineConn struct {
	net.Conn
	deadline time.Time
}

func (c *chooserDeadlineConn) SetDeadline(deadline time.Time) error {
	c.deadline = deadline
	return c.Conn.SetDeadline(deadline)
}

func TestFileChooserSetterDeadlineWireAndNoReplay(t *testing.T) {
	timeouts := []int{-1, 50, 10000, 120000, 1}
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		chooserHandshake(t, conn)
		warm := readRequest(t, conn)
		if warm == nil || warm["method"] != "getTabs" {
			t.Errorf("unexpected warmup: %v", warm)
			return
		}
		writeResponse(t, conn, warm["id"], []any{})
		for index, expected := range timeouts {
			r := readRequest(t, conn)
			if r == nil {
				t.Errorf("missing setter request %d", index)
				return
			}
			p := r["params"].(map[string]any)
			if r["method"] != "setFileChooserFiles" || p["fileChooserId"] != "chooser" || p["control_epoch"] != float64(7) || p["turn_id"] != "initial" || !reflect.DeepEqual(p["files"], []any{}) {
				t.Errorf("unexpected wire request: %v", r)
			}
			if actual, exists := p["timeoutMs"]; expected < 0 && exists || expected >= 0 && actual != float64(expected) {
				t.Errorf("timeout changed: %v; want %d", p, expected)
			}
			if expected == 50 {
				time.Sleep(150 * time.Millisecond)
			}
			if index == len(timeouts)-1 {
				if err := wire.WriteJSON(conn, Params{"id": r["id"], "error": Params{"message": "OBU_FILE_CHOOSER_CONSUMED"}}); err != nil {
					t.Error(err)
				}
			} else {
				writeResponse(t, conn, r["id"], Params{})
			}
		}
		if extra := readRequest(t, conn); extra != nil {
			t.Errorf("setter was replayed: %v", extra)
		}
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path, TurnID: "initial", Timeout: time.Second})
	defer c.Close()
	if _, err := c.GetTabs(); err != nil {
		t.Fatal(err)
	}
	c.options.Timeout = 100 * time.Millisecond
	tracked := &chooserDeadlineConn{Conn: c.conn}
	c.conn = tracked
	for index, timeout := range []int{-1, 50, 0, 120000, 1} {
		started := time.Now()
		var err error
		budget := c.options.Timeout
		if timeout < 0 {
			_, err = c.SetFileChooserFiles("chooser", nil)
		} else {
			_, err = c.SetFileChooserFilesWithTimeout("chooser", nil, timeout)
			budget = time.Duration(timeouts[index])*time.Millisecond + time.Second
		}
		if index == len(timeouts)-1 {
			if err == nil || !strings.Contains(err.Error(), "OBU_FILE_CHOOSER_CONSUMED") {
				t.Fatalf("original rejection not retained: %v", err)
			}
		} else if err != nil {
			t.Fatal(err)
		}
		if deadline := tracked.deadline.Sub(started); deadline < budget || deadline > budget+500*time.Millisecond {
			t.Errorf("transport budget %v, want %v", deadline, budget)
		}
	}
}

func TestFileChooserSetterInvalidTimeoutNeverConnects(t *testing.T) {
	c := NewClient(Options{SocketPath: "unused"})
	defer c.Close()
	for _, timeout := range []int{-1, 120001} {
		if _, err := c.SetFileChooserFilesWithTimeout("chooser", nil, timeout); err == nil || !strings.Contains(err.Error(), "file chooser timeout") {
			t.Fatalf("invalid timeout did not fail locally: %v", err)
		}
	}
	if c.nextID != 0 || c.conn != nil {
		t.Fatal("invalid timeout reached discovery or transport")
	}
}
