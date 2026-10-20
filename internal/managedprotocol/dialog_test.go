package managedprotocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestHumanDialogTypedDecisionAndUnicode(t *testing.T) {
	if dialogText(json.RawMessage{'"', 0xff, '"'}, MaxDialogTextBytes, true, true) {
		t.Fatal("invalid raw UTF-8 was replaced rather than rejected")
	}
	base := `{"operation":"humanDialogRespond","leaseId":"lease","generation":1,"dialogId":"dialog","accept":true`
	for _, suffix := range []string{`}`, `,"promptText":""}`, `,"promptText":"中文😀\n"}`, `,"promptText":"\ud83d\ude00"}`, `,"promptText":"\\ud800"}`, `,"promptText":` + string(mustJSON(strings.Repeat("😀", 2048))) + `}`} {
		f, err := Object([]byte(base + suffix))
		if err != nil || ValidateHuman("humanDialogRespond", f) != nil {
			t.Fatalf("valid dialog decision rejected: %s", suffix[:min(len(suffix), 80)])
		}
	}
	invalid := []string{
		base + `,"promptText":"\ud800"}`, base + `,"promptText":"\udc00"}`, base + `,"promptText":"\ud800\u0041"}`,
		base + `,"promptText":null}`, base + `,"promptText":` + string(mustJSON(strings.Repeat("😀", 2049))) + `}`,
		base + `,"accept":false}`, base + `,"sequence":1}`, base + `,"targetId":"foreign"}`,
		strings.Replace(base+`}`, `"generation":1`, `"generation":0`, 1),
		strings.Replace(base+`}`, `"accept":true`, `"accept":null`, 1),
		strings.Replace(base+`,"promptText":""}`, `"accept":true`, `"accept":false`, 1),
		strings.Replace(base+`}`, `"dialog"`, `"\ud800"`, 1),
	}
	for i, raw := range invalid {
		f, err := Object([]byte(raw))
		if err == nil && ValidateHuman("humanDialogRespond", f) == nil {
			t.Fatalf("invalid decision %d accepted", i)
		}
	}
}

func TestHumanDialogStateAndIndependentReceipt(t *testing.T) {
	human := &HumanState{State: "active", LeaseID: "lease", Generation: 1}
	raw := []byte(`{"leaseId":"lease","generation":1,"dialogId":"dialog","type":"prompt","message":"","defaultPrompt":""}`)
	dialog, err := ParsePendingDialog(raw, human)
	if err != nil || dialog.DefaultPrompt == nil || *dialog.DefaultPrompt != "" {
		t.Fatalf("empty prompt lost: %v", err)
	}
	for _, mutate := range []func(map[string]any){
		func(f map[string]any) { f["leaseId"] = "foreign" }, func(f map[string]any) { f["generation"] = 2 },
		func(f map[string]any) { f["type"] = "beforeunload" }, func(f map[string]any) { f["type"] = "alert" },
		func(f map[string]any) { f["privateTarget"] = "hidden" }, func(f map[string]any) { f["message"] = strings.Repeat("x", 8193) },
	} {
		var f map[string]any
		_ = json.Unmarshal(raw, &f)
		mutate(f)
		if _, err := ParsePendingDialog(mustJSON(f), human); err == nil {
			t.Fatal("invalid dialog state accepted")
		}
	}
	for _, owner := range []*HumanState{nil, {State: "active", LeaseID: "lease", Generation: 0}, {State: "starting", LeaseID: "lease", Generation: 1}} {
		if _, err := ParsePendingDialog(raw, owner); err == nil {
			t.Fatal("dialog escaped active generation")
		}
	}
	request, _ := Object([]byte(`{"operation":"humanDialogRespond","leaseId":"lease","generation":1,"dialogId":"dialog","accept":true,"promptText":""}`))
	if !MatchDialogResponse(request, dialog) {
		t.Fatal("original response rejected")
	}
	dialog.Type = "confirm"
	if MatchDialogResponse(request, dialog) {
		t.Fatal("prompt text granted to confirm")
	}
	receipt, err := ParseDialogReceipt([]byte(`{"leaseId":"lease","generation":1,"dialogId":"dialog","acknowledged":true}`))
	if err != nil || !MatchDialogReceipt(request, receipt) {
		t.Fatal("original receipt rejected")
	}
	for _, raw := range []string{`null`, `{"leaseId":"lease","generation":1,"sequence":1,"acknowledged":true}`, `{"leaseId":"lease","generation":1,"dialogId":"dialog","acknowledged":false}`, `{"leaseId":"lease","generation":1,"dialogId":"dialog","acknowledged":true,"native":"hidden"}`} {
		if _, err := ParseDialogReceipt([]byte(raw)); err == nil {
			t.Fatal("invalid native proof accepted")
		}
	}
	receipt.DialogID = "new"
	if MatchDialogReceipt(request, receipt) {
		t.Fatal("new dialog supplied old receipt")
	}
}

func TestHumanBeforeUnloadKeepsTypedDecisionAndGenerationBoundary(t *testing.T) {
	raw := json.RawMessage(`{"leaseId":"lease","generation":2,"dialogId":"leave-original","type":"beforeunload","message":""}`)
	for _, state := range []string{"active", "preparing", "navigating"} {
		human := &HumanState{State: state, LeaseID: "lease", Generation: 2}
		pending, err := ParsePendingDialog(raw, human)
		if err != nil || pending.DefaultPrompt != nil || pending.Message != "" {
			t.Fatalf("original empty beforeunload rejected in %s: %v", state, err)
		}
		for _, accept := range []bool{false, true} {
			request, _ := Object(mustJSON(map[string]any{"operation": "humanDialogRespond", "leaseId": "lease", "generation": 2, "dialogId": "leave-original", "accept": accept}))
			if !MatchDialogResponse(request, pending) {
				t.Fatalf("explicit decision %v rejected", accept)
			}
			request["promptText"] = json.RawMessage(`""`)
			if MatchDialogResponse(request, pending) {
				t.Fatal("beforeunload accepted prompt text")
			}
		}
	}
	for _, owner := range []*HumanState{nil, {State: "starting", LeaseID: "lease", Generation: 2}, {State: "active", LeaseID: "lease", Generation: 3}, {State: "active", LeaseID: "foreign", Generation: 2}} {
		if _, err := ParsePendingDialog(raw, owner); err == nil {
			t.Fatal("beforeunload escaped its admitted generation")
		}
	}
	for _, extra := range []string{`,"defaultPrompt":""`, `,"nativeTarget":"private"`} {
		invalid := append(append([]byte(nil), raw[:len(raw)-1]...), []byte(extra+`}`)...)
		if _, err := ParsePendingDialog(invalid, &HumanState{State: "active", LeaseID: "lease", Generation: 2}); err == nil {
			t.Fatal("beforeunload accepted unrelated fields")
		}
	}
}
