package managedprotocol

import (
	"encoding/json"
	"testing"
)

func TestPageSelectionCapabilityAndReceiptAreStrict(t *testing.T) {
	for _, raw := range []string{"null", "0", "2", `"1"`, "true", "1.0"} {
		if _, err := ParsePageSelectionVersion(json.RawMessage(raw)); err == nil {
			t.Fatalf("invalid capability accepted: %s", raw)
		}
	}
	for _, raw := range []json.RawMessage{nil, json.RawMessage("1")} {
		if _, err := ParsePageSelectionVersion(raw); err != nil {
			t.Fatal(err)
		}
	}
	const original = `{"tabId":7,"pageSelectionId":"choice","deliveryId":"delivery","retained":true}`
	r, err := ParsePageSelectionReceipt([]byte(original))
	if err != nil {
		t.Fatal(err)
	}
	f, _ := Object([]byte(`{"operation":"select","tabId":7,"pageSelectionId":"choice"}`))
	if !MatchPageSelectionReceipt(f, r) {
		t.Fatal("original choice receipt lost")
	}
	for _, request := range []string{`{"tabId":8,"pageSelectionId":"choice"}`, `{"tabId":7,"pageSelectionId":"other"}`, `{"tabId":7,"deliveryId":"delivery"}`} {
		f, _ := Object([]byte(request))
		if MatchPageSelectionReceipt(f, r) {
			t.Fatalf("foreign/unsolicited receipt accepted: %s", request)
		}
	}
	for _, raw := range []string{"null", `{}`, `{"tabId":7,"pageSelectionId":"choice","deliveryId":"delivery","retained":false}`, `{"tabId":7,"pageSelectionId":"choice","deliveryId":"delivery","retained":true,"targetId":"private"}`, `{"tabId":7,"pageSelectionId":"choice","deliveryId":null,"retained":true}`, `{"tabId":7,"tabId":8,"pageSelectionId":"choice","deliveryId":"delivery","retained":true}`} {
		if _, err := ParsePageSelectionReceipt([]byte(raw)); err == nil {
			t.Fatalf("malformed receipt accepted: %s", raw)
		}
	}
}
