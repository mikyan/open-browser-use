package obu

import (
	"net"
	"reflect"
	"strings"
	"testing"
)

func TestLocatorCompositionScopeAndFalseVisibility(t *testing.T) {
	browser := NewBrowser(NewClient(Options{SocketPath: "unused"}))
	tab := browser.Tab(7)
	outer := tab.FrameLocator("#child").GetByRole("listitem")
	visible := false
	composed := outer.Filter(FilterOptions{Has: browser.Tab(7).GetByText("Research"), HasNot: tab.FrameLocator("#child").GetByText("Unavailable"), Visible: &visible}).And(tab.FrameLocator("#child").Locator(".eligible")).Or(tab.FrameLocator("#child").GetByTestID("backup"))
	if composed.err != nil {
		t.Fatal(composed.err)
	}
	want := Params{"kind": "filter", "visible": false, "has": []Params{{"kind": "text", "value": "Research"}}, "hasNot": []Params{{"kind": "text", "value": "Unavailable"}}}
	if !reflect.DeepEqual(composed.steps[2], want) {
		t.Fatalf("filter: %#v", composed.steps[2])
	}
	if !reflect.DeepEqual(composed.steps[3], Params{"kind": "and", "locator": []Params{{"kind": "css", "selector": ".eligible"}}}) {
		t.Fatal(composed.steps[3])
	}
	if len(outer.steps) != 2 {
		t.Fatal("mutated outer")
	}
	reordered := &Locator{Tab: tab, steps: []Params{{"selector": "#child", "kind": "frame"}, {"kind": "css", "selector": "a"}}}
	if outer.And(reordered).err != nil {
		t.Fatal("map order affected prefix")
	}
}

func TestLocatorCompositionRejectsForeignFrameRefAndEmptyOperand(t *testing.T) {
	browser := NewBrowser(NewClient(Options{SocketPath: "unused"}))
	tab := browser.Tab(7)
	outer := tab.FrameLocator("#one").Locator("article")
	foreign := NewBrowser(NewClient(Options{SocketPath: "unused"})).Tab(7).Locator("a")
	for _, bad := range []*Locator{foreign, browser.Tab(8).Locator("a")} {
		if _, err := outer.Filter(FilterOptions{Has: bad}).Count(); err == nil || !strings.Contains(err.Error(), "same tab and client") {
			t.Fatal(err)
		}
	}
	for _, bad := range []*Locator{tab.FrameLocator("#two").Locator("a"), tab.Locator("section").FrameLocator("#one").Locator("a")} {
		if outer.Filter(FilterOptions{HasNot: bad}).err == nil {
			t.Fatal("foreign frame accepted")
		}
	}
	for _, bad := range []*Locator{outer.And(tab.Locator("a")), outer.Or(tab.FrameLocator("#one")), outer.Filter(FilterOptions{Has: tab.GetByRef("capture", "e1")}), tab.GetByRef("capture", "e1").And(tab.Locator("a"))} {
		if bad.err == nil {
			t.Fatal("invalid operand accepted")
		}
	}
	_, err := copyLocatorSteps([]Params{{"kind": "css", "selector": "a"}, {"kind": "filter", "hasNot": []Params{{"kind": "frame", "selector": "iframe"}, {"kind": "css", "selector": "b"}}}}, false)
	if err == nil {
		t.Fatal("nested frame accepted")
	}
}

func TestLocatorCompositionCopiesNestedTreesAndBoundsDrag(t *testing.T) {
	tab := NewBrowser(NewClient(Options{SocketPath: "unused"})).Tab(7)
	operand := tab.Locator("*").Filter(FilterOptions{Has: tab.GetByText("Original")})
	composed := tab.Locator("article").Filter(FilterOptions{Has: operand})
	operand.steps[1]["has"].([]Params)[0]["value"] = "Changed"
	if composed.steps[1]["has"].([]Params)[1]["has"].([]Params)[0]["value"] != "Original" {
		t.Fatal("operand alias leaked")
	}
	chain := tab.Locator("*")
	for i := 1; i < 32; i++ {
		chain = chain.Locator("*")
	}
	if chain.err != nil || chain.Locator("*").err == nil {
		t.Fatal("32 step bound")
	}
	nested := tab.Locator("*")
	for i := 0; i < 8; i++ {
		nested = tab.Locator("*").Filter(FilterOptions{Has: nested})
	}
	if nested.err != nil || tab.Locator("*").Filter(FilterOptions{Has: nested}).err == nil {
		t.Fatal("depth bound")
	}
	wide := tab.Locator("*").Filter(FilterOptions{Has: chain, HasNot: chain})
	if err := wide.DragTo(wide); err == nil || !strings.Contains(err.Error(), "128") {
		t.Fatal(err)
	}
	if wide.Filter(FilterOptions{Has: wide}).err == nil {
		t.Fatal("aggregate bound")
	}
	short := &Locator{Tab: tab, steps: chain.steps[1:]}
	exact := tab.Locator("*").Filter(FilterOptions{Has: short, HasNot: short}).Filter(FilterOptions{Has: chain, HasNot: short})
	if exact.err != nil || exact.Last().err == nil {
		t.Fatal("128 step boundary")
	}
}

func TestLocatorMixedSelectOptionsWire(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		legacyControlHandshake(t, conn)
		request := readRequest(t, conn)
		params := request["params"].(map[string]any)
		values := params["args"].(map[string]any)["values"]
		want := []any{"Manual", map[string]any{"value": "sticker"}, map[string]any{"label": "Bundle", "index": float64(3)}}
		if !reflect.DeepEqual(values, want) {
			t.Errorf("mixed values changed: %#v", values)
		}
		writeResponse(t, conn, request["id"], Params{"value": []string{"manual", "sticker"}, "engine": Params{"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}})
	})
	defer cleanup()
	browser := NewBrowser(NewClient(Options{SocketPath: path}))
	defer browser.Close()
	value, err := browser.Tab(7).GetByLabel("Materials").SelectOption([]any{"Manual", Params{"value": "sticker"}, Params{"label": "Bundle", "index": 3}})
	if err != nil || !reflect.DeepEqual(value, []string{"manual", "sticker"}) {
		t.Fatal(value, err)
	}
}
