package managedprotocol

import (
	"bytes"
	"encoding/json"
	"errors"
)

// DeliveryID identifies the original delivery, not permission to attach to it.
// The managed backend must revalidate that original page for every admission.
func DeliveryID(raw json.RawMessage) bool { return text(raw, 128, false) }

func ValidateSelection(f map[string]json.RawMessage) error {
	if !exact(f, []string{"operation"}, []string{"tabId", "deliveryId"}) || !choice(f["operation"], "select") || f["tabId"] == nil ||
		!bytes.Equal(f["tabId"], []byte("null")) && !integer(f["tabId"], 1, MaxSafeInteger) ||
		f["deliveryId"] != nil && (!DeliveryID(f["deliveryId"]) || bytes.Equal(f["tabId"], []byte("null"))) {
		return errors.New("invalid viewer selection")
	}
	return nil
}

// ViewState shares geometry and navigation semantics, but carries no input
// authority. Native state may report only a zero input counter; it is omitted
// from public JSON, just like HumanState's private native counter.
func ParseViewState(data json.RawMessage) (*HumanState, error) {
	state, err := ParseHumanState(data)
	if err != nil || state == nil {
		return state, err
	}
	f, err := Object(data)
	if err != nil || state.State == "preparing" || f["inputBudgetVersion"] != nil || f["keyRepeatVersion"] != nil || f["lastInputSequence"] != nil && !integer(f["lastInputSequence"], 0, 0) {
		return nil, errors.New("read-only view reported input")
	}
	return state, nil
}

type ViewerTab struct {
	ID         uint64 `json:"id"`
	Title      string `json:"title"`
	URL        string `json:"url"`
	Kind       string `json:"kind"`
	Watchable  bool   `json:"watchable"`
	Takeover   bool   `json:"takeover"`
	DeliveryID string `json:"deliveryId,omitempty"`
}

func ParseViewerTabs(data json.RawMessage, running bool) ([]ViewerTab, error) {
	var raw []json.RawMessage
	if bytes.Equal(data, []byte("null")) || json.Unmarshal(data, &raw) != nil || len(raw) > 4096 {
		return nil, errors.New("invalid viewer tab list")
	}
	tabs := make([]ViewerTab, 0, len(raw))
	seen := map[uint64]bool{}
	for _, item := range raw {
		f, err := Object(item)
		var tab ViewerTab
		if err != nil || json.Unmarshal(item, &tab) != nil || !integer(f["id"], 1, MaxSafeInteger) || seen[tab.ID] || len(tab.Title) > 4096 || len(tab.URL) > 16384 {
			return nil, errors.New("invalid viewer tab")
		}
		if f["kind"] == nil && f["watchable"] == nil && f["takeover"] == nil && f["deliveryId"] == nil {
			// Older managed workers expose only active task attachments.
			tab.Kind, tab.Watchable, tab.Takeover = "task", running, running
		} else {
			if !choice(f["kind"], "task", "result") || !boolean(f["watchable"]) {
				return nil, errors.New("invalid viewer tab capability")
			}
			if !boolean(f["takeover"]) || tab.Kind == "result" && !DeliveryID(f["deliveryId"]) || tab.Kind == "task" && f["deliveryId"] != nil {
				return nil, errors.New("invalid viewer delivery identity")
			}
		}
		seen[tab.ID] = true
		tabs = append(tabs, tab)
	}
	return tabs, nil
}

func boolean(raw json.RawMessage) bool {
	return bytes.Equal(raw, []byte("true")) || bytes.Equal(raw, []byte("false"))
}
