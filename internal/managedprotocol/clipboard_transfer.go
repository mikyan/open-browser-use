package managedprotocol

import (
	"encoding/json"
	"errors"
)

const MaxClipboardTransferTextBytes = 64 << 10

// ClipboardTransferReceipt describes the managed browser's shared clipboard,
// not the provenance of bytes or whether a cut deleted the page's selection.
// It supplements a genuine original key ACK and never replaces that ACK.
type ClipboardTransferReceipt struct {
	Operation string  `json:"operation"`
	Status    string  `json:"status"`
	Text      *string `json:"text,omitempty"`
	Code      string  `json:"code,omitempty"`
}

func validClipboardShortcut(input map[string]json.RawMessage) bool {
	if !choice(input["type"], "key") || !choice(input["action"], "down") ||
		input["repeat"] != nil ||
		!integer(input["modifiers"], 2, 2) && !integer(input["modifiers"], 4, 4) {
		return false
	}
	switch {
	case choice(input["clipboardTransfer"], "copy"):
		return choice(input["key"], "c", "C") && choice(input["code"], "KeyC") && integer(input["windowsVirtualKeyCode"], 67, 67)
	case choice(input["clipboardTransfer"], "cut"):
		return choice(input["key"], "x", "X") && choice(input["code"], "KeyX") && integer(input["windowsVirtualKeyCode"], 88, 88)
	}
	return false
}

func parseClipboardTransfer(data json.RawMessage) (*ClipboardTransferReceipt, error) {
	f, err := Object(data)
	bad := errors.New("invalid human clipboard transfer receipt")
	if err != nil || !choice(f["operation"], "copy", "cut") {
		return nil, bad
	}
	switch {
	case choice(f["status"], "ready"):
		if !exact(f, []string{"operation", "status", "text"}, nil) ||
			!dialogText(f["text"], MaxClipboardTransferTextBytes, true, true) {
			return nil, bad
		}
	case choice(f["status"], "unchanged"):
		if !exact(f, []string{"operation", "status"}, nil) {
			return nil, bad
		}
	case choice(f["status"], "failed"):
		if !exact(f, []string{"operation", "status", "code"}, nil) ||
			!choice(f["code"], "UNSUPPORTED", "DENIED", "BUSY", "CANCELLED", "TIMEOUT", "CHANGED", "LIMIT", "READ_FAILED") {
			return nil, bad
		}
	default:
		return nil, bad
	}
	var result ClipboardTransferReceipt
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, bad
	}
	return &result, nil
}

func matchClipboardTransfer(request map[string]json.RawMessage, receipt *ClipboardTransferReceipt) bool {
	if request["input"] == nil {
		return receipt == nil
	}
	input, err := Object(request["input"])
	if err != nil {
		return false
	}
	if _, present := input["clipboardTransfer"]; !present {
		return receipt == nil
	}
	return receipt != nil && validClipboardShortcut(input) && choice(input["clipboardTransfer"], receipt.Operation)
}
