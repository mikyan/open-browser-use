package managedprotocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestHumanInputBudgetCapabilityIsOptionalFixedAndNeverViewAuthority(t *testing.T) {
	base := `{"state":"active","leaseId":"original","tabId":1,"generation":1,"viewport":{"width":640,"height":480}`
	for _, suffix := range []string{"}", `,"inputBudgetVersion":1}`} {
		state, err := ParseHumanState(json.RawMessage(base + suffix))
		if err != nil || state == nil {
			t.Fatalf("valid capability rejected: %v", err)
		}
		if string(mustJSON(state)) != base+suffix {
			t.Fatal("projection invented or dropped the original optional capability")
		}
	}
	for _, raw := range []string{"null", "0", "2", "-1", "1.0", `"1"`, "true", "{}"} {
		if _, err := ParseHumanState(json.RawMessage(base + `,"inputBudgetVersion":` + raw + `}`)); err == nil {
			t.Fatalf("unknown capability accepted: %s", raw)
		}
	}
	if _, err := ParseHumanState(json.RawMessage(base + `,"inputBudgetVersion":1,"inputBudgetVersion":1}`)); err == nil {
		t.Fatal("duplicate capability accepted")
	}
	if _, err := ParseViewState(json.RawMessage(base + `,"inputBudgetVersion":1}`)); err == nil {
		t.Fatal("read-only view advertised an input budget")
	}
	if _, err := ParseViewState(json.RawMessage(base + `}`)); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{`"inputBudgetVersion":1`, `"timeoutMs":335000`} {
		command, _ := Object([]byte(`{"operation":"humanInput","leaseId":"original","generation":1,"sequence":1,"input":{"type":"text","text":"x"},` + field + `}`))
		if ValidateHuman("humanInput", command) == nil {
			t.Fatal("caller selected its own input budget")
		}
	}
	state, err := ParseHumanState(json.RawMessage(strings.Replace(base+`,"inputBudgetVersion":1}`, `"generation":1`, `"generation":0`, 1)))
	if err != nil || state.Generation != 0 || state.InputBudgetVersion != 1 {
		t.Fatal("capability must not manufacture first-frame authority")
	}
}
