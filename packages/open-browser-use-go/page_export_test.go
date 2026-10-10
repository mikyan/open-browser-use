package obu

import (
	"encoding/base64"
	"math"
	"net"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

func exportInfo() Params {
	return Params{"metadata": Params{"turnLifecycleVersion": 1, "pageExportVersion": 1}}
}
func exportResult(format string, data []byte) map[string]any {
	mime := "application/pdf"
	if format == "mhtml" {
		mime = "multipart/related"
	}
	return map[string]any{"format": format, "mimeType": mime, "encoding": "base64", "data": base64.StdEncoding.EncodeToString(data), "byteLength": float64(len(data))}
}
func exportPointer[T any](value T) *T { return &value }

func TestPageExportHelpersPreserveScopeAndBinaryResults(t *testing.T) {
	data := map[string][]byte{"pdf": {'%', 'P', 'D', 'F', '-', 255, 0}, "mhtml": []byte("MIME-Version: 1.0\r\n报告🙂")}
	pageRanges := "1-2"
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		for _, method := range []string{"getInfo", "getControlState", "exportPage", "exportPage", "exportPage"} {
			req := readRequest(t, conn)
			if req == nil || req["method"] != method {
				t.Errorf("unexpected request: %#v", req)
				return
			}
			if method == "getInfo" {
				writeResponse(t, conn, req["id"], exportInfo())
				continue
			}
			if method == "getControlState" {
				writeResponse(t, conn, req["id"], testControlState(7, "next"))
				continue
			}
			p := req["params"].(map[string]any)
			if p["control_epoch"] != float64(7) || p["turn_id"] != "initial" || p["tabId"] != float64(9) {
				t.Errorf("scope changed: %#v", p)
			}
			if timeout := p["timeoutMs"].(float64); timeout < 1 || timeout > 1000 {
				t.Errorf("timeout=%v", timeout)
			}
			format := p["format"].(string)
			if format == "pdf" && !reflect.DeepEqual(p["pdf"], map[string]any{"landscape": false, "marginTop": float64(0), "pageRanges": "1-2"}) {
				t.Errorf("options changed: %#v", p)
			}
			if format == "mhtml" && p["pdf"] != nil {
				t.Errorf("unexpected PDF options")
			}
			writeResponse(t, conn, req["id"], exportResult(format, data[format]))
		}
	})
	defer cleanup()
	client := NewClient(Options{SocketPath: path, TurnID: "initial"})
	defer client.Close()
	tab := NewBrowser(client).Tab(9)
	for index, format := range []string{"pdf", "mhtml", "mhtml"} {
		var got PageExport
		var err error
		switch format {
		case "pdf":
			got, err = tab.ExportPDF(ExportPageOptions{Timeout: time.Second, PDF: &PDFOptions{Landscape: exportPointer(false), MarginTop: exportPointer(0.0), PageRanges: &pageRanges}})
		default:
			if index == 1 {
				got, err = tab.ExportMHTML(ExportPageOptions{Timeout: time.Second})
			} else {
				got, err = tab.ExportPage(format, ExportPageOptions{Timeout: time.Second})
			}
		}
		if err != nil {
			t.Fatal(err)
		}
		if got.Data != base64.StdEncoding.EncodeToString(data[format]) || got.ByteLength != len(data[format]) {
			t.Fatalf("result=%#v", got)
		}
	}
}

func TestPageExportOptionValidation(t *testing.T) {
	ranges := "1-2"
	copied, err := ExportPageParams("pdf", ExportPageOptions{PDF: &PDFOptions{PageRanges: &ranges}})
	if err != nil {
		t.Fatal(err)
	}
	ranges = "9"
	if copied["pdf"].(Params)["pageRanges"] != "1-2" {
		t.Fatal("caller mutation changed prepared PDF options")
	}
	for _, options := range []ExportPageOptions{{MaxBytes: -1}, {MaxBytes: MaxPageExportBytes + 1}, {Timeout: -1}, {Timeout: time.Microsecond}, {Timeout: 121 * time.Second},
		{PDF: &PDFOptions{Scale: exportPointer(.09)}}, {PDF: &PDFOptions{Scale: exportPointer(2.1)}}, {PDF: &PDFOptions{Scale: exportPointer(math.NaN())}},
		{PDF: &PDFOptions{PaperWidth: exportPointer(0.0)}}, {PDF: &PDFOptions{PaperHeight: exportPointer(201.0)}},
		{PDF: &PDFOptions{MarginLeft: exportPointer(-1.0)}}, {PDF: &PDFOptions{MarginRight: exportPointer(201.0)}},
		{PDF: &PDFOptions{PageRanges: exportPointer("all")}}, {PDF: &PDFOptions{PageRanges: exportPointer("1\n")}}, {PDF: &PDFOptions{PageRanges: exportPointer(strings.Repeat("1", 1025))}}} {
		if _, err := ExportPageParams("pdf", options); err == nil {
			t.Errorf("invalid options accepted: %#v", options)
		}
	}
	if _, err := ExportPageParams("mhtml", ExportPageOptions{PDF: &PDFOptions{}}); err == nil {
		t.Fatal("MHTML accepted PDF options")
	}
	if _, err := ExportPageParams("png", ExportPageOptions{}); err == nil {
		t.Fatal("invalid format accepted")
	}
	if _, err := NewBrowser(NewClient(Options{SocketPath: "unused"})).Tab(9).ExportPDF(ExportPageOptions{}, ExportPageOptions{}); err == nil {
		t.Fatal("multiple options accepted")
	}
	if p, err := ExportPageParams("pdf", ExportPageOptions{MaxBytes: 1, Timeout: time.Millisecond, PDF: &PDFOptions{Scale: exportPointer(.1), PaperWidth: exportPointer(200.0), MarginLeft: exportPointer(200.0)}}); err != nil || p["maxBytes"] != 1 {
		t.Fatalf("boundary %#v %v", p, err)
	}
}

func TestPageExportResultValidation(t *testing.T) {
	for _, patch := range []map[string]any{{"extra": 1}, {"format": "mhtml"}, {"mimeType": "text/html"}, {"encoding": "utf8"}, {"data": "/x=="}, {"data": "_w=="}, {"data": "/w=\n"}, {"data": "????"}, {"byteLength": true}, {"byteLength": float64(2)}, {"byteLength": float64(0)}} {
		good := exportResult("pdf", []byte{255})
		for k, v := range patch {
			good[k] = v
		}
		if _, err := ValidatePageExport(good, "pdf", 100); err == nil {
			t.Errorf("bad result accepted: %#v", good)
		}
	}
	if _, err := ValidatePageExport(nil, "pdf", 100); err == nil {
		t.Fatal("nil accepted")
	}
	if _, err := ValidatePageExport(exportResult("mhtml", []byte("中文")), "mhtml", 5); err == nil {
		t.Fatal("caller cap ignored")
	}
	boundary := exportResult("pdf", []byte(strings.Repeat("x", MaxPageExportBytes)))
	if got, err := ValidatePageExport(boundary, "pdf", MaxPageExportBytes); err != nil || got.ByteLength != MaxPageExportBytes {
		t.Fatalf("boundary %v", err)
	}
	if _, err := ValidatePageExport(boundary, "pdf", MaxPageExportBytes-1); err == nil {
		t.Fatal("oversize accepted")
	}
}

func TestPageExportCapabilityIncludesManualEpoch(t *testing.T) {
	for _, version := range []any{nil, true, 2} {
		for _, manual := range []bool{false, true} {
			path, cleanup := startSDKServer(t, func(conn net.Conn) {
				req := readRequest(t, conn)
				if req["method"] != "getInfo" {
					t.Errorf("expected discovery: %#v", req)
					return
				}
				writeResponse(t, conn, req["id"], Params{"metadata": Params{"turnLifecycleVersion": 1, "pageExportVersion": version}})
				if !manual {
					req = readRequest(t, conn)
					if req["method"] != "getControlState" {
						t.Errorf("expected state: %#v", req)
						return
					}
					writeResponse(t, conn, req["id"], testControlState(7, "next"))
				}
				if req = readRequest(t, conn); req != nil {
					t.Errorf("unsupported export sent: %#v", req)
				}
			})
			client := NewClient(Options{SocketPath: path})
			var err error
			if manual {
				_, err = client.Request("exportPage", Params{"tabId": 9, "format": "pdf", "control_epoch": 7})
			} else {
				_, err = NewBrowser(client).Tab(9).ExportPDF()
			}
			if err == nil || !strings.Contains(err.Error(), "OBU_PAGE_EXPORT_UNSUPPORTED") {
				t.Errorf("version=%v manual=%v error=%v", version, manual, err)
			}
			client.Close()
			cleanup()
		}
	}
}

func TestPageExportShortBudgetIncludesDiscovery(t *testing.T) {
	for _, manual := range []bool{false, true} {
		path, cleanup := startSDKServer(t, func(conn net.Conn) {
			req := readRequest(t, conn)
			time.Sleep(150 * time.Millisecond)
			writeResponse(t, conn, req["id"], exportInfo())
			if !manual {
				req = readRequest(t, conn)
				if req["method"] != "getControlState" {
					t.Errorf("unexpected %#v", req)
					return
				}
				writeResponse(t, conn, req["id"], testControlState(7, "next"))
			}
			if req = readRequest(t, conn); req != nil {
				t.Errorf("expired export sent: %#v", req)
			}
		})
		client := NewClient(Options{SocketPath: path})
		var err error
		if manual {
			_, err = client.Request("exportPage", Params{"tabId": 9, "format": "pdf", "control_epoch": 7, "timeoutMs": 20})
		} else {
			_, err = NewBrowser(client).Tab(9).ExportPDF(ExportPageOptions{Timeout: 20 * time.Millisecond})
		}
		if err == nil || !strings.Contains(err.Error(), "deadline") {
			t.Errorf("error=%v", err)
		}
		client.Close()
		cleanup()
	}
}

func TestPageExportRawDeadlineValidation(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		req := readRequest(t, conn)
		writeResponse(t, conn, req["id"], exportInfo())
		req = readRequest(t, conn)
		writeResponse(t, conn, req["id"], testControlState(7, "next"))
		if req = readRequest(t, conn); req != nil {
			t.Errorf("invalid request sent: %#v", req)
		}
	})
	defer cleanup()
	client := NewClient(Options{SocketPath: path})
	defer client.Close()
	for _, timeout := range []any{nil, true, 0, 1.5, 120001} {
		if _, err := client.Request("exportPage", Params{"tabId": 9, "format": "pdf", "timeoutMs": timeout}); err == nil {
			t.Errorf("invalid timeout accepted: %v", timeout)
		}
	}
}

func TestPageExportLostResponseIsNotReplayed(t *testing.T) {
	seen := make(chan []string, 1)
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		methods := []string{}
		for _, reply := range []any{exportInfo(), testControlState(7, "next")} {
			req := readRequest(t, conn)
			methods = append(methods, req["method"].(string))
			writeResponse(t, conn, req["id"], reply)
		}
		req := readRequest(t, conn)
		methods = append(methods, req["method"].(string))
		seen <- methods
	})
	defer cleanup()
	client := NewClient(Options{SocketPath: path})
	defer client.Close()
	if _, err := NewBrowser(client).Tab(9).ExportPDF(ExportPageOptions{Timeout: 50 * time.Millisecond}); err == nil {
		t.Fatal("missing response accepted")
	}
	if got := <-seen; !reflect.DeepEqual(got, []string{"getInfo", "getControlState", "exportPage"}) {
		t.Fatalf("calls=%v", got)
	}
}

func TestPageExportQueuedDeadlineAndStaleScope(t *testing.T) {
	// The existing request gate must not turn export's finite budget into an
	// unbounded mutex wait, even before a connection or capability negotiation.
	client := NewClient(Options{SocketPath: "unused"})
	client.mu.Lock()
	_, err := NewBrowser(client).Tab(9).ExportPDF(ExportPageOptions{Timeout: time.Millisecond})
	client.mu.Unlock()
	if err == nil || client.conn != nil {
		t.Fatalf("queued export error=%v connected=%v", err, client.conn != nil)
	}
	// A submitted manual scope must not borrow a refreshed client's epoch.
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		req := readRequest(t, conn)
		writeResponse(t, conn, req["id"], exportInfo())
		req = readRequest(t, conn)
		p := req["params"].(map[string]any)
		if p["control_epoch"] != float64(7) || p["turn_id"] != "old" {
			t.Errorf("retargeted: %#v", p)
		}
		wire.WriteJSON(conn, Params{"id": req["id"], "error": Params{"message": "OBU_STALE_CONTROL_EPOCH"}})
	})
	defer cleanup()
	client = NewClient(Options{SocketPath: path, TurnID: "new"})
	defer client.Close()
	client.control = clientControlState{version: 1, epoch: 8, turnID: "new"}
	_, err = client.Request("exportPage", Params{"tabId": 9, "format": "pdf", "control_epoch": 7, "turn_id": "old"})
	if err == nil || !strings.Contains(err.Error(), "OBU_STALE_CONTROL_EPOCH") {
		t.Fatalf("stale=%v", err)
	}
}
