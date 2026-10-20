package managedprotocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestResultSelectionPreservesOriginalDeliveryIdentity(t *testing.T) {
	for _, operation := range []string{"select", "humanBegin"} {
		for _, delivery := range []string{`"original-delivery"`, `"` + strings.Repeat("a", 128) + `"`} {
			f, _ := Object([]byte(`{"operation":"` + operation + `","tabId":1,"deliveryId":` + delivery + `}`))
			var err error
			if operation == "select" {
				err = ValidateSelection(f)
			} else {
				err = ValidateHuman(operation, f)
			}
			if err != nil {
				t.Fatalf("original identity rejected: %v", err)
			}
		}
		for _, delivery := range []string{`null`, `1`, `""`, `"a\n"`, `"` + strings.Repeat("a", 129) + `"`} {
			f, _ := Object([]byte(`{"operation":"` + operation + `","tabId":1,"deliveryId":` + delivery + `}`))
			var err error
			if operation == "select" {
				err = ValidateSelection(f)
			} else {
				err = ValidateHuman(operation, f)
			}
			if err == nil {
				t.Fatalf("invalid identity accepted: %s", delivery)
			}
		}
	}
	f, _ := Object([]byte(`{"operation":"select","tabId":null,"deliveryId":"old"}`))
	if ValidateSelection(f) == nil {
		t.Fatal("unselect accepted an unrelated delivery identity")
	}
}

func TestResultTabsKeepCapabilitiesAndLegacyTaskSemantics(t *testing.T) {
	for _, running := range []bool{false, true} {
		tabs, err := ParseViewerTabs([]byte(`[{"id":1,"title":"Task","url":"https://example.test"},{"id":2,"title":"Result","url":"https://example.test/result","kind":"result","watchable":true,"takeover":false,"deliveryId":"original","privateTarget":"hidden"}]`), running)
		if err != nil {
			t.Fatal(err)
		}
		if tabs[0].Kind != "task" || tabs[0].Watchable != running || tabs[0].Takeover != running || !tabs[1].Watchable || tabs[1].Takeover || tabs[1].DeliveryID != "original" {
			t.Fatalf("capabilities changed: %+v", tabs)
		}
		if strings.Contains(string(mustJSON(tabs)), "privateTarget") {
			t.Fatal("private target leaked")
		}
	}
	for _, item := range []string{
		`{"id":1,"kind":"result","watchable":true,"takeover":true}`,
		`{"id":1,"kind":"task","watchable":true,"takeover":true,"deliveryId":"old"}`,
		`{"id":1,"kind":"result","watchable":null,"takeover":true,"deliveryId":"old"}`,
		`{"id":1,"watchable":true}`,
	} {
		if _, err := ParseViewerTabs([]byte("["+item+"]"), true); err == nil {
			t.Fatalf("invalid tab accepted: %s", item)
		}
	}
}

func TestBrowserPageSelectionKeepsChoiceSeparateFromDelivery(t *testing.T) {
	for _, operation := range []string{"select", "humanBegin"} {
		for _, fields := range []string{`"tabId":7,"pageSelectionId":"original-choice"`, `"tabId":7,"pageSelectionId":"` + strings.Repeat("x", 128) + `"`} {
			f, _ := Object([]byte(`{"operation":"` + operation + `",` + fields + `}`))
			var err error
			if operation == "select" {
				err = ValidateSelection(f)
			} else {
				err = ValidateHuman(operation, f)
			}
			if err != nil {
				t.Fatalf("original browser choice rejected: %s: %v", operation, err)
			}
		}
		for _, fields := range []string{`"tabId":7,"pageSelectionId":null`, `"tabId":7,"pageSelectionId":""`, `"tabId":7,"pageSelectionId":"choice","deliveryId":"result"`, `"tabId":null,"pageSelectionId":"choice"`} {
			f, _ := Object([]byte(`{"operation":"` + operation + `",` + fields + `}`))
			var err error
			if operation == "select" {
				err = ValidateSelection(f)
			} else {
				err = ValidateHuman(operation, f)
			}
			if err == nil {
				t.Fatalf("invalid choice accepted: %s", fields)
			}
		}
	}
	tabs, err := ParseViewerTabs([]byte(`[{"id":7,"title":"Child","url":"https://child.example/","kind":"browser","watchable":true,"takeover":true,"pageSelectionId":"original-choice"}]`), false)
	if err != nil || len(tabs) != 1 || !strings.Contains(string(mustJSON(tabs)), `"pageSelectionId":"original-choice"`) {
		t.Fatalf("browser choice not preserved: %v %v", tabs, err)
	}
}

func TestReadOnlyViewCannotCarryNativeInputOrHumanFrameIdentity(t *testing.T) {
	state := map[string]any{"state": "active", "leaseId": "view", "tabId": 1, "generation": 1, "viewport": map[string]any{"width": 800, "height": 600}, "lastInputSequence": 0}
	if _, err := ParseViewState(mustJSON(state)); err != nil {
		t.Fatal(err)
	}
	state["lastInputSequence"] = 1
	if _, err := ParseViewState(mustJSON(state)); err == nil {
		t.Fatal("view granted an input counter")
	}
	frame, _ := Object([]byte(`{"controlMode":"user-view","viewLeaseId":"view","generation":1}`))
	mode, lease, generation, err := ParseFrameIdentity(frame)
	if err != nil || mode != "user-view" || lease != "view" || generation != 1 {
		t.Fatal("read-only frame identity lost")
	}
	frame["humanLeaseId"] = json.RawMessage(`"human"`)
	if _, _, _, err := ParseFrameIdentity(frame); err == nil {
		t.Fatal("mixed native authorities accepted")
	}
}
