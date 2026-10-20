package managedprotocol

import (
	"bytes"
	"encoding/json"
	"errors"
)

// DeliveryID identifies the original delivery, not permission to attach to it.
// The managed backend must revalidate that original page for every admission.
func DeliveryID(raw json.RawMessage) bool { return text(raw, 128, false) }

// PageSelectionID names a short-lived explicit user choice, never a delivery
// or Agent ownership. Only the worker can promote that original native page.
func PageSelectionID(raw json.RawMessage) bool { return text(raw, 128, false) }

func selectionTokens(f map[string]json.RawMessage) bool {
	return !(f["deliveryId"] != nil && f["pageSelectionId"] != nil) &&
		(f["deliveryId"] == nil || DeliveryID(f["deliveryId"])) &&
		(f["pageSelectionId"] == nil || PageSelectionID(f["pageSelectionId"]))
}

func ParsePageSelectionVersion(raw json.RawMessage) (uint64, error) {
	if raw == nil {
		return 0, nil
	}
	if !integer(raw, 1, 1) {
		return 0, errors.New("invalid browser page selection capability")
	}
	return 1, nil
}

type PageSelectionReceipt struct {
	TabID           uint64 `json:"tabId"`
	PageSelectionID string `json:"pageSelectionId"`
	DeliveryID      string `json:"deliveryId"`
	Retained        bool   `json:"retained"`
}

func ParsePageSelectionReceipt(raw json.RawMessage) (*PageSelectionReceipt, error) {
	if raw == nil {
		return nil, nil
	}
	f, err := Object(raw)
	var value PageSelectionReceipt
	if err != nil || !exact(f, []string{"tabId", "pageSelectionId", "deliveryId", "retained"}, nil) ||
		!integer(f["tabId"], 1, MaxSafeInteger) || !PageSelectionID(f["pageSelectionId"]) || !DeliveryID(f["deliveryId"]) ||
		!bytes.Equal(f["retained"], []byte("true")) || json.Unmarshal(raw, &value) != nil {
		return nil, errors.New("invalid browser page selection receipt")
	}
	return &value, nil
}

func MatchPageSelectionReceipt(f map[string]json.RawMessage, receipt *PageSelectionReceipt) bool {
	if f["pageSelectionId"] == nil {
		return receipt == nil
	}
	var tabID uint64
	var choiceID string
	return receipt != nil && receipt.Retained && json.Unmarshal(f["tabId"], &tabID) == nil &&
		json.Unmarshal(f["pageSelectionId"], &choiceID) == nil && receipt.TabID == tabID && receipt.PageSelectionID == choiceID
}

func ValidateSelection(f map[string]json.RawMessage) error {
	if !exact(f, []string{"operation"}, []string{"tabId", "deliveryId", "pageSelectionId"}) || !choice(f["operation"], "select") || f["tabId"] == nil ||
		!bytes.Equal(f["tabId"], []byte("null")) && !integer(f["tabId"], 1, MaxSafeInteger) ||
		!selectionTokens(f) || (f["deliveryId"] != nil || f["pageSelectionId"] != nil) && bytes.Equal(f["tabId"], []byte("null")) {
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
	if err != nil || state.State == "preparing" || f["inputBudgetVersion"] != nil || f["keyRepeatVersion"] != nil || f["pointerClickCountVersion"] != nil || f["clipboardTransferVersion"] != nil || f["fileChooserVersion"] != nil || f["lastInputSequence"] != nil && !integer(f["lastInputSequence"], 0, 0) {
		return nil, errors.New("read-only view reported input")
	}
	return state, nil
}

type ViewerTab struct {
	ID              uint64 `json:"id"`
	Title           string `json:"title"`
	URL             string `json:"url"`
	Kind            string `json:"kind"`
	Watchable       bool   `json:"watchable"`
	Takeover        bool   `json:"takeover"`
	DeliveryID      string `json:"deliveryId,omitempty"`
	PageSelectionID string `json:"pageSelectionId,omitempty"`
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
		if f["kind"] == nil && f["watchable"] == nil && f["takeover"] == nil && f["deliveryId"] == nil && f["pageSelectionId"] == nil {
			// Older managed workers expose only active task attachments.
			tab.Kind, tab.Watchable, tab.Takeover = "task", running, running
		} else {
			if !choice(f["kind"], "task", "result", "browser") || !boolean(f["watchable"]) {
				return nil, errors.New("invalid viewer tab capability")
			}
			if !boolean(f["takeover"]) || !selectionTokens(f) ||
				tab.Kind == "result" && (!DeliveryID(f["deliveryId"]) || f["pageSelectionId"] != nil) ||
				tab.Kind == "browser" && (!PageSelectionID(f["pageSelectionId"]) || f["deliveryId"] != nil) ||
				tab.Kind == "task" && (f["deliveryId"] != nil || f["pageSelectionId"] != nil) {
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
