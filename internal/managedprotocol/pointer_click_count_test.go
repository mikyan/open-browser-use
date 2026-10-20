package managedprotocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPointerClickCountStateAndInputBounds(t *testing.T) {
	base := `{"state":"active","leaseId":"original","tabId":1,"generation":1,"viewport":{"width":640,"height":480}`
	for _, suffix := range []string{`}`, `,"pointerClickCountVersion":1}`} {
		h, err := ParseHumanState(json.RawMessage(base + suffix))
		if err != nil || string(mustJSON(h)) != base+suffix {
			t.Fatalf("native capability lost: %s %v", mustJSON(h), err)
		}
	}
	for _, raw := range []string{"null", "0", "2", "-1", "1.0", `"1"`, "true"} {
		if _, err := ParseHumanState([]byte(base + `,"pointerClickCountVersion":` + raw + `}`)); err == nil {
			t.Errorf("invalid native capability %s", raw)
		}
	}
	if _, err := ParseViewState([]byte(base + `,"pointerClickCountVersion":1}`)); err == nil {
		t.Error("readonly view advertised pointer capability")
	}
	validate := func(input string) error {
		f, err := Object([]byte(`{"operation":"humanInput","leaseId":"original","generation":1,"sequence":1,"input":` + input + `}`))
		if err != nil {
			return err
		}
		return ValidateHuman("humanInput", f)
	}
	down := `{"type":"pointer","action":"down","x":1,"y":2,"button":"left"`
	for _, action := range []string{"down", "up"} {
		for _, count := range []string{"", `,"clickCount":1`, `,"clickCount":2`, `,"clickCount":3`, `,"clickCount":2147483647`} {
			if err := validate(strings.Replace(down+count+`}`, `"down"`, `"`+action+`"`, 1)); err != nil {
				t.Errorf("valid %s %s rejected: %v", action, count, err)
			}
		}
	}
	for _, raw := range []string{"null", "0", "-1", "1.5", "1.0", "2147483648", `"2"`, "true", "{}"} {
		if validate(down+`,"clickCount":`+raw+`}`) == nil {
			t.Errorf("invalid count %s", raw)
		}
	}
	for _, input := range []string{`{"type":"pointer","action":"move","x":1,"y":2,"clickCount":1}`,
		`{"type":"text","text":"x","clickCount":1}`, `{"type":"wheel","x":1,"y":1,"deltaX":0,"deltaY":1,"clickCount":1}`,
		down + `,"clickCount":2,"clickCount":2}`} {
		if validate(input) == nil {
			t.Errorf("foreign or duplicate count accepted: %s", input)
		}
	}
	f, _ := Object([]byte(`{"operation":"humanInput","leaseId":"original","generation":1,"sequence":1,"pointerClickCountVersion":1,"input":` + down + `,"clickCount":2}}`))
	if ValidateHuman("humanInput", f) == nil {
		t.Error("caller self-granted native capability")
	}
}
