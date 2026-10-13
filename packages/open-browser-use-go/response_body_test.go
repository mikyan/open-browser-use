package obu

import (
	"encoding/base64"
	"github.com/ifuryst/open-browser-use/internal/wire"
	"net"
	"reflect"
	"strings"
	"testing"
	"time"
)

var bodyRef = ResponseBodyRef{"diag,[]中文", "request-7"}

func bodyResult(data []byte) Params {
	return Params{"captureId": bodyRef.CaptureID, "requestId": bodyRef.RequestID, "encoding": "base64", "data": base64.StdEncoding.EncodeToString(data), "byteLength": len(data)}
}
func bodyEnvelope(value any) Params {
	return Params{"value": value, "engine": Params{"name": "playwright-crx", "version": "1", "playwrightVersion": "1", "capabilities": Params{"responseBody": 1}}}
}
func bodyRaw() Params {
	return Params{"tabId": 9, "action": "responseBody", "args": Params{"captureId": bodyRef.CaptureID, "requestId": bodyRef.RequestID}}
}
func TestResponseBodyFacadeCapturesScopeAndBinaryBytes(t *testing.T) {
	data := []byte{0, 255, 13, 10}
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		for _, method := range []string{"getInfo", "getControlState", "browserAction", "browserAction"} {
			req := readRequest(t, conn)
			if req == nil || req["method"] != method {
				t.Error(req)
				return
			}
			if method == "getInfo" {
				writeResponse(t, conn, req["id"], Params{"metadata": Params{"turnLifecycleVersion": 1, "responseBodyVersion": 1}})
				continue
			}
			if method == "getControlState" {
				writeResponse(t, conn, req["id"], testControlState(7, "next"))
				continue
			}
			p := req["params"].(map[string]any)
			if p["action"] != "responseBody" || p["tabId"] != float64(9) || p["control_epoch"] != float64(7) || p["turn_id"] != "initial" || p["locator"] != nil {
				t.Error(p)
			}
			if !reflect.DeepEqual(p["args"], map[string]any{"captureId": bodyRef.CaptureID, "requestId": bodyRef.RequestID, "maxBytes": float64(32)}) {
				t.Error(p)
			}
			writeResponse(t, conn, req["id"], bodyEnvelope(bodyResult(data)))
		}
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path, TurnID: "initial"})
	defer c.Close()
	tab := NewBrowser(c).Tab(9)
	for _, fn := range []func(ResponseBodyRef, ...ResponseBodyOptions) (ResponseBody, error){tab.ResponseBody, tab.Playwright.ResponseBody} {
		got, err := fn(bodyRef, ResponseBodyOptions{MaxBytes: 32, Timeout: time.Second})
		if err != nil || got.Data != base64.StdEncoding.EncodeToString(data) || got.ByteLength != 4 {
			t.Fatal(got, err)
		}
	}
}
func TestResponseBodyRejectsInvalidBeforeConnecting(t *testing.T) {
	c := NewClient(Options{SocketPath: "unused"})
	defer c.Close()
	for _, mutate := range []func(Params){func(p Params) { p["locator"] = []any{} }, func(p Params) { p["timeoutMs"] = nil }, func(p Params) { p["args"].(Params)["captureId"] = string([]byte{0xff}) }, func(p Params) { p["args"].(Params)["requestId"] = "" }, func(p Params) { p["args"].(Params)["maxBytes"] = 0 }, func(p Params) { p["args"].(Params)["maxBytes"] = true }, func(p Params) { p["args"].(Params)["url"] = "x" }} {
		p := bodyRaw()
		mutate(p)
		if _, err := c.Request("browserAction", p); err == nil || !strings.Contains(err.Error(), "OBU_RESPONSE_BODY_INVALID") {
			t.Fatal(p, err)
		}
	}
	for _, opts := range []ResponseBodyOptions{{MaxBytes: -1}, {MaxBytes: MaxResponseBodyBytes + 1}, {Timeout: time.Microsecond}, {Timeout: 121 * time.Second}} {
		if _, err := NewBrowser(c).Tab(9).ResponseBody(bodyRef, opts); err == nil {
			t.Fatal(opts)
		}
	}
	if c.conn != nil {
		t.Fatal("invalid request connected")
	}
	if _, err := c.BrowserAction(9, "responseBody", BrowserActionOptions{Args: bodyRaw()["args"].(Params), Timeout: 1500 * time.Microsecond}); err == nil || !strings.Contains(err.Error(), "OBU_RESPONSE_BODY_INVALID") {
		t.Fatal("fractional millisecond duration was truncated", err)
	}
}
func TestResponseBodyCanonicalSchemaReferenceAndEmptyBytes(t *testing.T) {
	if value, err := ValidateResponseBody(bodyResult(nil), bodyRef, 1); err != nil || value.ByteLength != 0 || value.Data != "" {
		t.Fatal(value, err)
	}
	for _, mutate := range []func(Params){func(p Params) { p["extra"] = 1 }, func(p Params) { p["captureId"] = "other" }, func(p Params) { p["requestId"] = "other" }, func(p Params) { p["data"] = "/x==" }, func(p Params) { p["data"] = "_w==" }, func(p Params) { p["data"] = "/w=\n" }, func(p Params) { p["byteLength"] = true }, func(p Params) { p["byteLength"] = 0 }, func(p Params) { p["encoding"] = "utf8" }} {
		p := bodyResult([]byte{255})
		mutate(p)
		if _, err := ValidateResponseBody(p, bodyRef, 32); err == nil {
			t.Fatal(p)
		}
	}
	if _, err := ValidateResponseBody(bodyResult([]byte{0, 1}), bodyRef, 1); err == nil {
		t.Fatal("oversize accepted")
	}
}
func TestResponseBodyMetadataGatesRawExplicitAndTypedRequests(t *testing.T) {
	for _, version := range []any{nil, true, 2} {
		for _, manual := range []bool{false, true} {
			path, cleanup := startSDKServer(t, func(conn net.Conn) {
				for {
					var req map[string]any
					if wire.ReadJSON(conn, &req) != nil {
						return
					}
					var result any
					switch req["method"] {
					case "getInfo":
						result = Params{"metadata": Params{"turnLifecycleVersion": 1, "responseBodyVersion": version}}
					case "getControlState":
						result = testControlState(7, "next")
					default:
						t.Error("unsupported request sent", req)
						return
					}
					writeResponse(t, conn, req["id"], result)
				}
			})
			c := NewClient(Options{SocketPath: path})
			p := bodyRaw()
			if manual {
				p["control_epoch"] = 7
			}
			if _, err := c.Request("browserAction", p); err == nil || !strings.Contains(err.Error(), "UNSUPPORTED") {
				t.Fatal(version, manual, err)
			}
			c.Close()
			cleanup()
		}
	}
}
func TestResponseBodyRawValidatesEnvelopeAndNeverReplaysFailure(t *testing.T) {
	for _, failure := range []string{"malformed", "OBU_RESPONSE_BODY_EXPIRED"} {
		calls := 0
		path, cleanup := startSDKServer(t, func(conn net.Conn) {
			for {
				var req map[string]any
				if wire.ReadJSON(conn, &req) != nil {
					return
				}
				if req["method"] == "getInfo" {
					writeResponse(t, conn, req["id"], Params{"metadata": Params{"responseBodyVersion": 1}})
					continue
				}
				calls++
				if failure == "malformed" {
					result := bodyResult([]byte{255})
					result["requestId"] = "wrong"
					writeResponse(t, conn, req["id"], bodyEnvelope(result))
				} else {
					_ = wire.WriteJSON(conn, Params{"id": req["id"], "error": Params{"message": failure}})
				}
			}
		})
		c := NewClient(Options{SocketPath: path})
		p := bodyRaw()
		p["control_epoch"] = 7
		if _, err := c.Request("browserAction", p); err == nil || !strings.Contains(err.Error(), "OBU_RESPONSE_BODY_") {
			t.Fatal(err)
		}
		c.Close()
		cleanup()
		if calls != 1 {
			t.Fatal(calls)
		}
	}
}
func TestResponseBodyDiscoveryConsumesDeadline(t *testing.T) {
	calls := 0
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		for {
			var req map[string]any
			if wire.ReadJSON(conn, &req) != nil {
				return
			}
			if req["method"] == "getInfo" {
				time.Sleep(80 * time.Millisecond)
				writeResponse(t, conn, req["id"], Params{"metadata": Params{"responseBodyVersion": 1}})
			} else {
				calls++
				t.Error("expired body sent", req)
				return
			}
		}
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path})
	defer c.Close()
	p := bodyRaw()
	p["control_epoch"] = 7
	p["timeoutMs"] = 10
	if _, err := c.Request("browserAction", p); err == nil {
		t.Fatal("expired discovery accepted")
	}
	if calls != 0 {
		t.Fatal(calls)
	}
}
