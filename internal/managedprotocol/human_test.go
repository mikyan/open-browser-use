package managedprotocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTypedHumanInputBoundsAndDuplicateKeys(t *testing.T) {
	valid := []string{
		`{"type":"pointer","action":"down","button":"left","x":0,"y":12.5,"modifiers":15}`,
		`{"type":"pointer","action":"move","x":1,"y":2}`,
		`{"type":"wheel","x":1,"y":2,"deltaX":-4096,"deltaY":4096}`,
		`{"type":"key","action":"up","key":"Shift","code":"ShiftLeft","windowsVirtualKeyCode":16}`,
		`{"type":"text","text":"中文\t\n"}`,
		string(mustJSON(map[string]any{"type": "text", "text": strings.Repeat("😀", 2048)})),
	}
	for _, input := range valid {
		f, err := Object([]byte(`{"operation":"humanInput","leaseId":"lease","generation":1,"sequence":1,"input":` + input + `}`))
		if err != nil || ValidateHuman("humanInput", f) != nil {
			t.Errorf("valid input rejected: %s", input)
		}
	}
	invalid := []string{
		`{"type":"pointer","action":"move","x":1,"y":2,"button":"left"}`,
		`{"type":"pointer","action":"down","x":1,"y":2}`,
		`{"type":"pointer","action":"move","x":1,"x":2,"y":2}`,
		`{"type":"pointer","action":"move","x":null,"y":2}`,
		`{"type":"wheel","x":1,"y":2,"deltaX":0,"deltaY":4097}`,
		`{"type":"key","action":"down","key":"A","code":"Key A","windowsVirtualKeyCode":65}`,
		`{"type":"key","action":"down","key":"A","code":"KeyA","windowsVirtualKeyCode":256}`,
		`{"type":"text","text":"\u0000"}`,
		`{"type":"text","text":"\u007f"}`,
		`{"type":"text","text":"a","expression":"secret"}`,
		string(mustJSON(map[string]any{"type": "text", "text": strings.Repeat("😀", 2049)})),
	}
	for _, input := range invalid {
		f, err := Object([]byte(`{"operation":"humanInput","leaseId":"lease","generation":1,"sequence":1,"input":` + input + `}`))
		if err == nil && ValidateHuman("humanInput", f) == nil {
			t.Errorf("invalid input accepted: %s", input)
		}
	}
	for _, raw := range []string{`{"operation":"humanEnd","leaseId":"a","leaseId":"b"}`, `{"operation":"humanBegin","tabId":1} {}`, `{"x":1,"x":2}`} {
		if _, err := Object([]byte(raw)); err == nil {
			t.Errorf("duplicate/trailing JSON accepted: %s", raw)
		}
	}
}

func mustJSON(value any) []byte { data, _ := json.Marshal(value); return data }

func TestHumanFirstFrameStateDoesNotGrantInputAuthority(t *testing.T) {
	raw := []byte(`{"state":"active","leaseId":"original","tabId":1,"generation":0,"viewport":null}`)
	state, err := ParseHumanState(raw)
	if err != nil || state == nil || state.Generation != 0 || state.Viewport != nil {
		t.Fatalf("first-frame pending state rejected: %+v %v", state, err)
	}
	if string(mustJSON(state)) != string(raw) {
		t.Fatal("pending state invented viewport or generation")
	}
	for _, invalid := range []string{
		`{"state":"active","leaseId":"original","tabId":1,"generation":1,"viewport":null}`,
		`{"state":"active","leaseId":"original","tabId":1,"generation":2,"viewport":null}`,
		`{"state":"active","leaseId":"original","tabId":1,"generation":0}`,
		`{"state":"active","leaseId":"original","tabId":1,"generation":0,"viewport":{"width":0,"height":600}}`,
	} {
		if _, err := ParseHumanState([]byte(invalid)); err == nil {
			t.Fatalf("invalid first-frame state accepted: %s", invalid)
		}
	}
	input, _ := Object([]byte(`{"operation":"humanInput","leaseId":"original","generation":0,"sequence":1,"input":{"type":"pointer","action":"move","x":0,"y":0}}`))
	if ValidateHuman("humanInput", input) == nil {
		t.Fatal("pending first frame granted input authority")
	}
	frame, _ := Object([]byte(`{"controlMode":"human","humanLeaseId":"original","generation":0}`))
	if _, _, _, err := ParseFrameIdentity(frame); err == nil {
		t.Fatal("pending generation accepted as a real frame identity")
	}
}

func TestHumanStatusAndOriginalReceipts(t *testing.T) {
	for _, raw := range []string{
		`{"state":"active","leaseId":"a","tabId":1,"generation":0,"viewport":{"width":800,"height":600},"lastInputSequence":0,"private":"not projected"}`,
		`{"state":"releasing","leaseId":"a","tabId":1,"generation":2,"viewport":null}`,
	} {
		state, err := ParseHumanState([]byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(mustJSON(state)), "private") {
			t.Fatal("private human field leaked")
		}
	}
	for _, raw := range []string{
		`{"state":"active","leaseId":"a","tabId":1,"generation":1,"viewport":null}`,
		`{"state":"active","leaseId":"a","tabId":1,"generation":1,"viewport":{"width":800,"width":900,"height":600}}`,
		`{"state":"active","leaseId":"a","tabId":1,"generation":null,"viewport":{"width":800,"height":600}}`,
	} {
		if _, err := ParseHumanState([]byte(raw)); err == nil {
			t.Fatalf("invalid human state accepted: %s", raw)
		}
	}
	f, _ := Object([]byte(`{"leaseId":"a","generation":1,"sequence":2}`))
	receipt, err := ParseInputReceipt([]byte(`{"leaseId":"a","generation":1,"sequence":2,"acknowledged":true,"private":"hidden"}`))
	if err != nil || !MatchInputReceipt(f, receipt) {
		t.Fatal("original receipt rejected")
	}
	receipt.Sequence++
	if MatchInputReceipt(f, receipt) {
		t.Fatal("different input receipt accepted")
	}
	for _, raw := range []string{`{"leaseId":"a","cleanupConfirmed":false}`, `{"leaseId":"a","cleanupConfirmed":true,"cleanupConfirmed":false}`} {
		if _, err := ParseHumanCleanup([]byte(raw)); err == nil {
			t.Fatal("unknown cleanup reported confirmed")
		}
	}
}
