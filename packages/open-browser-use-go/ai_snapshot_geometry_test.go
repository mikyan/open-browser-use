package obu

import (
	"encoding/json"
	"math"
	"net"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

func validAIGeometryCapture() Params {
	value := validAICapture()
	value["snapshot"] = value["snapshot"].(string) + " [box=0,-20,0,0]"
	value["stats"].(Params)["bytes"] = len(value["snapshot"].(string))
	value["geometry"] = Params{
		"coordinateSpace": "frame-viewport-css",
		"frames": []any{
			Params{"id": "root", "parentId": nil, "ownerRef": nil, "viewport": Params{"width": 800, "height": 600, "scrollX": -1.25, "scrollY": 100, "devicePixelRatio": 1.5}},
			Params{"id": "f1", "parentId": "root", "ownerRef": "e1", "viewport": Params{"width": 100, "height": 50, "scrollX": 0, "scrollY": 20, "devicePixelRatio": 1.5}},
		},
		"boxes": []any{
			Params{"ref": "e1", "frameId": "root", "box": Params{"x": -1.5, "y": 2, "width": 100, "height": 50}},
			Params{"ref": "f1e2", "frameId": "f1", "box": Params{"x": 0, "y": -20, "width": 0, "height": 0}},
		},
	}
	return value
}

func TestAISnapshotGeometryWireOptionsAndNoFallback(t *testing.T) {
	done := make(chan struct{})
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		defer close(done)
		legacyControlHandshake(t, conn)
		for index := 0; index < 3; index++ {
			request := readRequest(t, conn)
			params := request["params"].(map[string]any)
			want := map[string]any{}
			if index != 1 {
				want["boxes"] = true
			}
			if index == 0 {
				want["maxFrames"] = float64(2)
			}
			if request["method"] != "browserAction" || params["action"] != "snapshotAI" || !reflect.DeepEqual(params["args"], want) {
				t.Errorf("wrong geometry request: %#v", request)
			}
			if index == 2 {
				if err := wire.WriteJSON(conn, Params{"id": request["id"], "error": Params{"message": "unsupported boxes"}}); err != nil {
					t.Error(err)
				}
				continue
			}
			value := validAICapture()
			if index == 0 {
				value = validAIGeometryCapture()
			}
			writeResponse(t, conn, request["id"], Params{"value": value, "engine": Params{"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0", "capabilities": Params{"snapshotAI": 1, "captureRefs": 1, "snapshotBoxes": 1}}})
		}
	})
	defer cleanup()
	browser := NewBrowser(NewClient(Options{SocketPath: path, Timeout: time.Second}))
	defer browser.Close()
	tab := browser.Tab(7)
	result, err := tab.Playwright.SnapshotAI(AISnapshotOptions{Boxes: true, MaxFrames: 2, Timeout: time.Second})
	if err != nil || result.Geometry == nil {
		t.Fatalf("geometry missing: %#v %v", result, err)
	}
	if result.Geometry.CoordinateSpace != "frame-viewport-css" || result.Geometry.Boxes[1].Box.Y != -20 || result.Geometry.Boxes[1].Box.Width != 0 ||
		result.Geometry.Frames[0].ParentID != nil || *result.Geometry.Frames[1].OwnerRef != "e1" || result.Geometry.Frames[0].Viewport.DevicePixelRatio != 1.5 {
		t.Fatalf("geometry changed: %#v", result.Geometry)
	}
	if result, err := tab.SnapshotAI(AISnapshotOptions{Boxes: false}); err != nil || result.Geometry != nil {
		t.Fatalf("default changed: %#v %v", result, err)
	}
	if _, err := tab.SnapshotAI(AISnapshotOptions{Boxes: true}); err == nil || !strings.Contains(err.Error(), "unsupported boxes") {
		t.Fatalf("original unsupported error lost: %v", err)
	}
	<-done
}

func geometryObject(value map[string]any) map[string]any { return value["geometry"].(map[string]any) }
func geometryFrame(value map[string]any, index int) map[string]any {
	return geometryObject(value)["frames"].([]any)[index].(map[string]any)
}
func geometryBox(value map[string]any, index int) map[string]any {
	return geometryObject(value)["boxes"].([]any)[index].(map[string]any)
}
func cloneGeometryCapture(t *testing.T) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(validAIGeometryCapture())
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(encoded, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestAISnapshotGeometryRejectsMalformedTopologyAndSchema(t *testing.T) {
	_, limits, _ := aiCaptureLimits(AISnapshotOptions{})
	mutations := map[string]func(map[string]any){
		"null":          func(v map[string]any) { v["geometry"] = nil },
		"missing":       func(v map[string]any) { delete(v, "geometry") },
		"extraGeometry": func(v map[string]any) { geometryObject(v)["frameGuid"] = "private" },
		"wrongSpace":    func(v map[string]any) { geometryObject(v)["coordinateSpace"] = "main-viewport-css" },
		"missingBox":    func(v map[string]any) { geometryObject(v)["boxes"] = geometryObject(v)["boxes"].([]any)[:1] },
		"duplicateBox":  func(v map[string]any) { geometryObject(v)["boxes"].([]any)[1] = geometryBox(v, 0) },
		"fakeRef":       func(v map[string]any) { geometryBox(v, 1)["ref"] = "e999" },
		"wrongPrefix":   func(v map[string]any) { geometryBox(v, 1)["frameId"] = "root" },
		"nullBox":       func(v map[string]any) { geometryBox(v, 0)["box"] = nil },
		"negativeBox":   func(v map[string]any) { geometryBox(v, 0)["box"].(map[string]any)["width"] = -1 },
		"missingZero":   func(v map[string]any) { delete(geometryBox(v, 1)["box"].(map[string]any), "width") },
		"wrongBoxCase": func(v map[string]any) {
			b := geometryBox(v, 0)["box"].(map[string]any)
			b["X"] = b["x"]
			delete(b, "x")
		},
		"extraBox":          func(v map[string]any) { geometryBox(v, 0)["quad"] = []any{} },
		"missingFrame":      func(v map[string]any) { geometryObject(v)["frames"] = geometryObject(v)["frames"].([]any)[:1] },
		"duplicateFrame":    func(v map[string]any) { geometryObject(v)["frames"].([]any)[1] = geometryFrame(v, 0) },
		"reordered":         func(v map[string]any) { f := geometryObject(v)["frames"].([]any); f[0], f[1] = f[1], f[0] },
		"rootOwner":         func(v map[string]any) { geometryFrame(v, 0)["ownerRef"] = "e1" },
		"missingRootParent": func(v map[string]any) { delete(geometryFrame(v, 0), "parentId") },
		"unknownParent":     func(v map[string]any) { geometryFrame(v, 1)["parentId"] = "f2" },
		"selfParent":        func(v map[string]any) { geometryFrame(v, 1)["parentId"] = "f1" },
		"wrongOwner":        func(v map[string]any) { geometryFrame(v, 1)["ownerRef"] = "f1e2" },
		"unknownOwner":      func(v map[string]any) { geometryFrame(v, 1)["ownerRef"] = "e999" },
		"missingRefFrame":   func(v map[string]any) { geometryFrame(v, 1)["id"] = "f2" },
		"extraFrame":        func(v map[string]any) { geometryFrame(v, 1)["frameGuid"] = "private" },
		"wrongFrameCase":    func(v map[string]any) { f := geometryFrame(v, 1); f["ID"] = f["id"]; delete(f, "id") },
		"zeroDPR":           func(v map[string]any) { geometryFrame(v, 0)["viewport"].(map[string]any)["devicePixelRatio"] = 0 },
		"negativeHeight":    func(v map[string]any) { geometryFrame(v, 0)["viewport"].(map[string]any)["height"] = -1 },
		"extraViewport":     func(v map[string]any) { geometryFrame(v, 0)["viewport"].(map[string]any)["scale"] = 1 },
		"duplicateOwner": func(v map[string]any) {
			f := map[string]any{}
			for k, x := range geometryFrame(v, 1) {
				f[k] = x
			}
			f["id"] = "f2"
			geometryObject(v)["frames"] = append(geometryObject(v)["frames"].([]any), f)
			v["stats"].(map[string]any)["frames"] = 3
		},
		"outsideSlot": func(v map[string]any) {
			v["refs"].([]any)[1] = "f33e2"
			geometryBox(v, 1)["ref"] = "f33e2"
			geometryBox(v, 1)["frameId"] = "f33"
			geometryFrame(v, 1)["id"] = "f33"
		},
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			value := cloneGeometryCapture(t)
			mutate(value)
			if _, err := decodeAISnapshot(value, limits, true); err == nil {
				t.Fatal("malformed geometry accepted")
			}
		})
	}
	for _, value := range []any{nil, true, "1", math.NaN(), math.Inf(1), math.Inf(-1)} {
		for _, target := range []string{"box", "viewport"} {
			capture := cloneGeometryCapture(t)
			if target == "box" {
				geometryBox(capture, 0)["box"].(map[string]any)["x"] = value
			} else {
				geometryFrame(capture, 0)["viewport"].(map[string]any)["scrollX"] = value
			}
			if _, err := decodeAISnapshot(capture, limits, true); err == nil {
				t.Fatalf("invalid numeric %v %v accepted", target, value)
			}
		}
	}
}

func TestAISnapshotGeometryAgreementSparseFramesAndEmptyRoot(t *testing.T) {
	_, limits, _ := aiCaptureLimits(AISnapshotOptions{})
	if _, err := decodeAISnapshot(validAIGeometryCapture(), limits); err == nil {
		t.Fatal("unrequested geometry accepted")
	}
	if _, err := decodeAISnapshot(validAICapture(), limits, true); err == nil {
		t.Fatal("missing geometry accepted")
	}
	value := cloneGeometryCapture(t)
	value["refs"].([]any)[1] = "f32e2"
	geometryBox(value, 1)["ref"] = "f32e2"
	geometryBox(value, 1)["frameId"] = "f32"
	geometryFrame(value, 1)["id"] = "f32"
	if _, err := decodeAISnapshot(value, limits, true); err != nil {
		t.Fatal(err)
	}
	_, smallLimits, _ := aiCaptureLimits(AISnapshotOptions{MaxBytes: 1})
	if _, err := decodeAISnapshot(value, smallLimits, true); err == nil {
		t.Fatal("annotated bytes exceeded limit")
	}
	value["refs"] = []any{}
	value["stats"].(map[string]any)["refs"] = 0
	value["stats"].(map[string]any)["frames"] = 1
	geometryObject(value)["boxes"] = []any{}
	geometryObject(value)["frames"] = geometryObject(value)["frames"].([]any)[:1]
	if _, err := decodeAISnapshot(value, limits, true); err != nil {
		t.Fatal(err)
	}
}
