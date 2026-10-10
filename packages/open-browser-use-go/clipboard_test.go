package obu

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

const clipboardPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII="

func TestClipboardEscapedWireBounds(t *testing.T) {
	for _, char := range []string{"<", "\x00"} {
		text := strings.Repeat(char, 8*1024*1024)
		items := []Params{{"entries": []Params{{"mime_type": "text/plain", "text": text}}}}
		for method, payload := range map[string]Params{"writeClipboardText": {"text": text}, "writeClipboard": {"items": items}} {
			if _, err := ClipboardParams(method, 9, payload, ClipboardOptions{}); err == nil || !strings.Contains(err.Error(), "OBU_CLIPBOARD_LIMIT") {
				t.Fatalf("%s encoded overflow: %v", method, err)
			}
		}
		for method, value := range map[string]Params{"readClipboardText": {"text": text}, "readClipboard": {"items": items}} {
			if _, err := ValidateClipboardResult(method, value, MaxClipboardBytes); err == nil || !strings.Contains(err.Error(), "OBU_CLIPBOARD_LIMIT") {
				t.Fatalf("%s encoded overflow: %v", method, err)
			}
		}
	}
	boundary := strings.Repeat("<", (maxClipboardJSONBytes-11)/6)
	if _, err := ValidateClipboardResult("readClipboardText", Params{"text": boundary}, MaxClipboardBytes); err != nil {
		t.Fatalf("valid encoded boundary: %v", err)
	}
	if _, err := ValidateClipboardResult("readClipboardText", Params{"text": boundary + "<"}, MaxClipboardBytes); err == nil || !strings.Contains(err.Error(), "OBU_CLIPBOARD_LIMIT") {
		t.Fatalf("over encoded boundary: %v", err)
	}
}

func clipboardInfo() Params {
	return Params{"metadata": Params{"turnLifecycleVersion": 1, "clipboardVersion": 1}}
}
func clipboardRich() []Params {
	return []Params{{"entries": []Params{{"mime_type": "text/plain", "text": "中文🙂"}, {"mime_type": "text/html", "text": "<b>报告</b>"}, {"mime_type": "image/png", "base64": clipboardPNG}}, "presentation_style": "inline"}}
}

func TestClipboardFacadeAndLegacyEnvelopeScope(t *testing.T) {
	input := clipboardRich()
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		for _, method := range []string{"getInfo", "getControlState", "writeClipboard", "readClipboard", "readClipboardText", "writeClipboardText", "writeClipboard", "readClipboardText"} {
			req := readRequest(t, conn)
			if req == nil || req["method"] != method {
				t.Errorf("unexpected request %#v", req)
				return
			}
			if method == "getInfo" {
				input[0]["entries"].([]Params)[0]["text"] = "changed"
				writeResponse(t, conn, req["id"], clipboardInfo())
				continue
			}
			if method == "getControlState" {
				writeResponse(t, conn, req["id"], testControlState(7, "next"))
				continue
			}
			p := req["params"].(map[string]any)
			if p["tabId"] != float64(9) || p["control_epoch"] != float64(7) || p["turn_id"] != "initial" {
				t.Errorf("scope %#v", p)
			}
			if timeout := p["timeoutMs"].(float64); timeout < 1 || timeout > 1000 {
				t.Errorf("budget %v", timeout)
			}
			result := Params{}
			switch method {
			case "writeClipboard":
				items := p["items"].([]any)
				if len(items) > 0 && items[0].(map[string]any)["entries"].([]any)[0].(map[string]any)["text"] != "中文🙂" {
					t.Error("caller mutation changed payload")
				}
			case "readClipboard":
				result["items"] = clipboardRich()
			case "readClipboardText":
				result["text"] = "中文🙂"
			case "writeClipboardText":
				if p["text"] != "" {
					t.Error("empty text lost")
				}
			}
			writeResponse(t, conn, req["id"], result)
		}
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path, TurnID: "initial"})
	defer c.Close()
	clipboard := NewBrowser(c).Tab(9).Clipboard()
	opt := ClipboardOptions{Timeout: time.Second}
	if _, err := c.WriteClipboard(9, input, opt); err != nil {
		t.Fatal(err)
	}
	items, err := clipboard.Read(opt)
	if err != nil || len(items) != 1 || len(items[0].Entries) != 3 || *items[0].Entries[0].Text != "中文🙂" || *items[0].Entries[2].Base64 != clipboardPNG {
		t.Fatalf("rich %#v %v", items, err)
	}
	if text, err := clipboard.ReadText(opt); err != nil || text != "中文🙂" {
		t.Fatalf("text %q %v", text, err)
	}
	if err := clipboard.WriteText("", opt); err != nil {
		t.Fatal(err)
	}
	if err := clipboard.Write([]ClipboardItem{}, opt); err != nil {
		t.Fatal(err)
	}
	if result, err := c.ReadClipboardText(9, opt); err != nil || !reflect.DeepEqual(result, map[string]any{"text": "中文🙂"}) {
		t.Fatalf("envelope %v %v", result, err)
	}
}

func TestClipboardValidationBeforeConnection(t *testing.T) {
	for _, opt := range []ClipboardOptions{{MaxBytes: -1}, {MaxBytes: MaxClipboardBytes + 1}, {Timeout: time.Microsecond}, {Timeout: 121 * time.Second}, {Timeout: -1}} {
		if _, err := ClipboardParams("readClipboard", 9, nil, opt); err == nil {
			t.Errorf("accepted %#v", opt)
		}
	}
	for _, payload := range []Params{{"text": nil}, {"text": 1}, {"text": string([]byte{0xff})}, {"text": "中文"}, {"text": "x", "extra": true}} {
		if _, err := ClipboardParams("writeClipboardText", 9, payload, ClipboardOptions{MaxBytes: 5}); err == nil {
			t.Errorf("accepted %#v", payload)
		}
	}
	badEntries := [][]Params{{}, {{"mime_type": "text/plain"}}, {{"mime_type": "text/plain", "text": "x", "base64": "eA=="}}, {{"mime_type": "text/plain", "text": "x", "extra": 1}}, {{"mime_type": "image/jpeg", "base64": clipboardPNG}}, {{"mime_type": "image/png", "base64": clipboardPNG + "\n"}}, {{"mime_type": "image/png", "base64": "eA=="}}, {{"mime_type": "text/plain", "text": "x"}, {"mime_type": "text/plain", "text": "y"}}}
	for _, entries := range badEntries {
		if _, err := ClipboardParams("writeClipboard", 9, Params{"items": []Params{{"entries": entries}}}, ClipboardOptions{}); err == nil {
			t.Errorf("accepted %#v", entries)
		}
	}
	for _, items := range []any{nil, Params{}, []Params{clipboardRich()[0], clipboardRich()[0]}, []Params{{"entries": clipboardRich()[0]["entries"], "extra": true}}, []Params{{"entries": clipboardRich()[0]["entries"], "presentation_style": nil}}} {
		if _, err := ClipboardParams("writeClipboard", 9, Params{"items": items}, ClipboardOptions{}); err == nil {
			t.Errorf("accepted %#v", items)
		}
	}
	c := NewClient(Options{SocketPath: "unused"})
	if err := NewBrowser(c).Tab(9).Clipboard().WriteText(string([]byte{0xff})); err == nil || c.conn != nil {
		t.Fatal("invalid text connected")
	}
	if _, err := c.ReadClipboard(9, ClipboardOptions{}, ClipboardOptions{}); err == nil {
		t.Fatal("multiple options accepted")
	}
	p, err := ClipboardParams("writeClipboard", 9, Params{"items": []Params{}}, ClipboardOptions{MaxBytes: 1, Timeout: time.Millisecond})
	if err != nil || len(p["items"].([]any)) != 0 {
		t.Fatalf("no-op %v %v", p, err)
	}
}

func TestClipboardResultBytesPNGAndUnicode(t *testing.T) {
	for _, value := range []any{nil, Params{}, Params{"text": 1}, Params{"text": string([]byte{0xff})}, Params{"text": "x", "extra": true}} {
		if _, err := ValidateClipboardResult("readClipboardText", value, 100); err == nil {
			t.Errorf("accepted %#v", value)
		}
	}
	for _, value := range []any{Params{}, Params{"items": nil}, Params{"items": []any{}, "extra": 1}} {
		if _, err := ValidateClipboardResult("readClipboard", value, 100); err == nil {
			t.Errorf("accepted %#v", value)
		}
	}
	if _, err := ValidateClipboardResult("writeClipboard", Params{"ok": true}, 100); err == nil {
		t.Fatal("write extra accepted")
	}
	decoded, _ := base64.StdEncoding.DecodeString(clipboardPNG)
	total := len([]byte("中文🙂<b>报告</b>")) + len(decoded)
	if _, err := ValidateClipboardResult("readClipboard", Params{"items": clipboardRich()}, total); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateClipboardResult("readClipboard", Params{"items": clipboardRich()}, total-1); err == nil {
		t.Fatal("aggregate cap ignored")
	}
	for _, mutate := range []func([]byte){func(b []byte) { binary.BigEndian.PutUint32(b[16:], 0) }, func(b []byte) { binary.BigEndian.PutUint32(b[16:], 16777217) }, func(b []byte) { b[24] = 3 }, func(b []byte) { b[26] = 1 }, func(b []byte) { b[28] = 2 }} {
		data := append([]byte(nil), decoded...)
		mutate(data)
		if _, err := validateClipboardItems([]Params{{"entries": []Params{{"mime_type": "image/png", "base64": base64.StdEncoding.EncodeToString(data)}}}}, 1000); err == nil {
			t.Fatal("invalid PNG accepted")
		}
	}
	boundary := strings.Repeat("x", MaxClipboardBytes)
	if _, err := ValidateClipboardResult("readClipboardText", Params{"text": boundary}, MaxClipboardBytes); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateClipboardResult("readClipboardText", Params{"text": boundary}, MaxClipboardBytes-1); err == nil {
		t.Fatal("caller cap ignored")
	}
	for _, raw := range []string{`{"text":"\ud800"}`, `{"text":"\udfff"}`, `{"text":"\ud800x"}`, `{"text":"` + string([]byte{0xff}) + `"}`} {
		if validateClipboardJSONUnicode([]byte(raw)) == nil {
			t.Errorf("lossy JSON accepted %q", raw)
		}
	}
	for _, raw := range []string{`{"text":"\ud83d\ude42"}`, `{"text":"\\ud800"}`, `{"text":"中文🙂�"}`} {
		if err := validateClipboardJSONUnicode([]byte(raw)); err != nil {
			t.Errorf("valid JSON %q: %v", raw, err)
		}
	}
}

func TestClipboardCapabilityIncludingManualEpoch(t *testing.T) {
	for _, version := range []any{nil, true, 2} {
		for _, manual := range []bool{false, true} {
			path, cleanup := startSDKServer(t, func(conn net.Conn) {
				req := readRequest(t, conn)
				writeResponse(t, conn, req["id"], Params{"metadata": Params{"turnLifecycleVersion": 1, "clipboardVersion": version}})
				if !manual {
					req = readRequest(t, conn)
					writeResponse(t, conn, req["id"], testControlState(7, "next"))
				}
				if req = readRequest(t, conn); req != nil {
					t.Errorf("unsupported sent %#v", req)
				}
			})
			c := NewClient(Options{SocketPath: path})
			var err error
			if manual {
				_, err = c.Request("readClipboard", Params{"tabId": 9, "control_epoch": 7})
			} else {
				_, err = NewBrowser(c).Tab(9).Clipboard().Read()
			}
			if err == nil || !strings.Contains(err.Error(), "OBU_CLIPBOARD_UNSUPPORTED") {
				t.Errorf("%v", err)
			}
			c.Close()
			cleanup()
		}
	}
}

func TestClipboardDeadlineQueueAndStaleNoReplay(t *testing.T) {
	c := NewClient(Options{SocketPath: "unused"})
	c.mu.Lock()
	_, err := c.WriteClipboardText(9, "never", ClipboardOptions{Timeout: time.Millisecond})
	c.mu.Unlock()
	if err == nil || c.conn != nil {
		t.Fatalf("queue %v", err)
	}
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		req := readRequest(t, conn)
		writeResponse(t, conn, req["id"], clipboardInfo())
		req = readRequest(t, conn)
		p := req["params"].(map[string]any)
		if p["control_epoch"] != float64(7) || p["turn_id"] != "old" {
			t.Errorf("retargeted %#v", p)
		}
		wire.WriteJSON(conn, Params{"id": req["id"], "error": Params{"message": "OBU_STALE_CONTROL_EPOCH"}})
		if req = readRequest(t, conn); req != nil {
			t.Errorf("replayed %#v", req)
		}
	})
	defer cleanup()
	c = NewClient(Options{SocketPath: path, TurnID: "new"})
	defer c.Close()
	c.control = clientControlState{version: 1, epoch: 8, turnID: "new"}
	_, err = c.Request("writeClipboardText", Params{"tabId": 9, "text": "once", "control_epoch": 7, "turn_id": "old"})
	if err == nil || !strings.Contains(err.Error(), "OBU_STALE_CONTROL_EPOCH") {
		t.Fatal(err)
	}
}

func TestClipboardDiscoveryBudgetAndRawDeadline(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		req := readRequest(t, conn)
		time.Sleep(100 * time.Millisecond)
		writeResponse(t, conn, req["id"], clipboardInfo())
		req = readRequest(t, conn)
		writeResponse(t, conn, req["id"], testControlState(7, "next"))
		if req = readRequest(t, conn); req != nil {
			t.Errorf("late write %#v", req)
		}
	})
	c := NewClient(Options{SocketPath: path})
	_, err := c.WriteClipboardText(9, "never", ClipboardOptions{Timeout: 20 * time.Millisecond})
	if err == nil || !strings.Contains(err.Error(), "deadline") {
		t.Errorf("%v", err)
	}
	c.Close()
	cleanup()
	path, cleanup = startSDKServer(t, func(conn net.Conn) {
		req := readRequest(t, conn)
		writeResponse(t, conn, req["id"], clipboardInfo())
		if req = readRequest(t, conn); req != nil {
			t.Errorf("invalid write %#v", req)
		}
	})
	defer cleanup()
	c = NewClient(Options{SocketPath: path})
	defer c.Close()
	for _, timeout := range []any{nil, true, 0, 1.5, 120001} {
		if _, err := c.Request("writeClipboard", Params{"tabId": 9, "items": []any{}, "control_epoch": 7, "timeoutMs": timeout}); err == nil {
			t.Errorf("accepted %v", timeout)
		}
	}
}

func TestClipboardWireRejectsLossySurrogateResult(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		req := readRequest(t, conn)
		writeResponse(t, conn, req["id"], clipboardInfo())
		req = readRequest(t, conn)
		writeResponse(t, conn, req["id"], testControlState(7, "next"))
		req = readRequest(t, conn)
		wire.WriteJSON(conn, map[string]any{"id": req["id"], "result": json.RawMessage(`{"text":"\ud800"}`)})
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path})
	defer c.Close()
	if text, err := NewBrowser(c).Tab(9).Clipboard().ReadText(); err == nil || !strings.Contains(err.Error(), "UTF-8 JSON") {
		t.Fatalf("lossy response %q %v", text, err)
	}
}
