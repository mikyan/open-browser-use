package managedprotocol

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestPreparingHumanStateHasNoViewportAndReadOnlyCannotAdoptIt(t *testing.T) {
	for _, generation := range []int{0, 1, 2} {
		raw := json.RawMessage(fmt.Sprintf(`{"state":"preparing","leaseId":"lease","tabId":1,"generation":%d,"viewport":null,"inputBudgetVersion":1}`, generation))
		human, err := ParseHumanState(raw)
		if err != nil || human.Generation != uint64(generation) || human.Viewport != nil || human.InputBudgetVersion != 1 {
			t.Fatalf("preparing admission rejected: %v", err)
		}
		if _, err := ParseViewState(raw); err == nil {
			t.Fatal("read-only view adopted preparing")
		}
	}
	for _, raw := range []string{
		`{"state":"preparing","leaseId":"lease","tabId":1,"generation":1,"viewport":{"width":640,"height":480}}`,
		`{"state":"preparing","leaseId":"lease","tabId":1,"generation":1}`,
		`{"state":"preparing","leaseId":"lease","tabId":1,"generation":0,"viewport":null,"inputBudgetVersion":2}`,
	} {
		if _, err := ParseHumanState(json.RawMessage(raw)); err == nil {
			t.Fatalf("invalid preparing accepted: %s", raw)
		}
	}
	// Test the state prohibition independently of the input capability field.
	if _, err := ParseViewState(json.RawMessage(`{"state":"preparing","leaseId":"lease","tabId":1,"generation":1,"viewport":null}`)); err == nil {
		t.Fatal("read-only preparing accepted without capability")
	}
}

func TestDialogMetadataRequiresOriginalPositiveAdmittedGeneration(t *testing.T) {
	raw := json.RawMessage(`{"leaseId":"lease","generation":1,"dialogId":"dialog","type":"prompt","message":"原生😀","defaultPrompt":""}`)
	for _, state := range []string{"preparing", "navigating", "active"} {
		human := &HumanState{State: state, LeaseID: "lease", Generation: 1}
		if _, err := ParsePendingDialog(raw, human); err != nil {
			t.Fatalf("proved dialog in %s rejected: %v", state, err)
		}
		human.Generation = 0
		if _, err := ParsePendingDialog(raw, human); err == nil {
			t.Fatalf("generation zero %s acquired dialog authority", state)
		}
	}
	for _, state := range []string{"starting", "releasing", "released", "error"} {
		if _, err := ParsePendingDialog(raw, &HumanState{State: state, LeaseID: "lease", Generation: 1}); err == nil {
			t.Fatalf("%s acquired dialog authority", state)
		}
	}
}
