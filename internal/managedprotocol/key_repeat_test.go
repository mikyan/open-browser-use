package managedprotocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestKeyRepeatStateProjectionAndBounds(t *testing.T) {
	base := `{"state":"active","leaseId":"original","tabId":1,"generation":1,"viewport":{"width":640,"height":480}`
	for _, suffix := range []string{`}`, `,"keyRepeatVersion":1}`} {
		t.Run(suffix, func(t *testing.T) {
			h, err := ParseHumanState(json.RawMessage(base + suffix))
			if err != nil || string(mustJSON(h)) != base+suffix {
				t.Fatalf("optional capability was changed: %s %v", mustJSON(h), err)
			}
		})
	}
	for _, raw := range []string{"null", "0", "2", "-1", "1.0", `"1"`, "true", "{}"} {
		t.Run(raw, func(t *testing.T) {
			if _, err := ParseHumanState(json.RawMessage(base + `,"keyRepeatVersion":` + raw + `}`)); err == nil {
				t.Fatal("invalid capability accepted")
			}
		})
	}
	if _, err := ParseHumanState(json.RawMessage(base + `,"keyRepeatVersion":1,"keyRepeatVersion":1}`)); err == nil {
		t.Fatal("duplicate capability accepted")
	}
	for _, generation := range []string{"0", "1"} {
		raw := `{"state":"preparing","leaseId":"original","tabId":1,"generation":` + generation + `,"viewport":null,"keyRepeatVersion":1}`
		h, err := ParseHumanState(json.RawMessage(raw))
		if err != nil || string(mustJSON(h)) != raw {
			t.Fatalf("preparing capability lost: %s %v", mustJSON(h), err)
		}
	}
}

func TestKeyRepeatOnlyTrueOnKeyDown(t *testing.T) {
	key := `{"type":"key","action":"down","key":"Enter","code":"Enter","windowsVirtualKeyCode":13`
	validate := func(input string) error {
		f, err := Object([]byte(`{"operation":"humanInput","leaseId":"original","generation":1,"sequence":1,"input":` + input + `}`))
		if err != nil {
			return err
		}
		return ValidateHuman("humanInput", f)
	}
	for _, input := range []string{key + `}`, key + `,"repeat":true}`, key + `,"repeat":true,"modifiers":8}`} {
		if err := validate(input); err != nil {
			t.Errorf("valid original down rejected: %s: %v", input, err)
		}
	}
	for _, raw := range []string{"false", "null", "0", "1", `"true"`, "{}", "[]"} {
		if validate(key+`,"repeat":`+raw+`}`) == nil {
			t.Errorf("invalid repeat accepted: %s", raw)
		}
	}
	for _, input := range []string{strings.Replace(key+`,"repeat":true}`, `"down"`, `"up"`, 1), `{"type":"text","text":"x","repeat":true}`, `{"type":"pointer","action":"move","x":1,"y":1,"repeat":true}`, `{"type":"wheel","x":1,"y":1,"deltaX":1,"deltaY":1,"repeat":true}`, key + `,"repeat":true,"repeat":true}`} {
		if validate(input) == nil {
			t.Errorf("non-repeat input accepted: %s", input)
		}
	}
}

func TestKeyRepeatCapabilityIsNotCallerOrViewAuthority(t *testing.T) {
	base := `{"state":"active","leaseId":"original","tabId":1,"generation":1,"viewport":{"width":640,"height":480}`
	for _, raw := range []string{"1", "null", "0"} {
		if _, err := ParseViewState(json.RawMessage(base + `,"keyRepeatVersion":` + raw + `}`)); err == nil {
			t.Errorf("readonly capability accepted: %s", raw)
		}
	}
	f, _ := Object([]byte(`{"operation":"humanInput","leaseId":"original","generation":1,"sequence":1,"keyRepeatVersion":1,"input":{"type":"key","action":"down","key":"a","code":"KeyA","windowsVirtualKeyCode":65,"repeat":true}}`))
	if ValidateHuman("humanInput", f) == nil {
		t.Fatal("caller granted its own repeat capability")
	}
}
