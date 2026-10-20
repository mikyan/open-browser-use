package managedprotocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

const MaxDialogTextBytes = 8 << 10

// DialogIdentity is a display-scoped token, never a native target or CDP handle.
type DialogIdentity struct {
	LeaseID    string `json:"leaseId"`
	Generation uint64 `json:"generation"`
	DialogID   string `json:"dialogId"`
}

type PendingDialog struct {
	DialogIdentity
	Type          string       `json:"type"`
	Message       string       `json:"message"`
	DefaultPrompt *string      `json:"defaultPrompt,omitempty"`
	Source        DialogSource `json:"source,omitzero"`
}

// DialogClaim pins display metadata even before the one permitted decision.
// A zero Source means the original producer did not provide provenance.
type DialogClaim struct {
	Source  DialogSource
	Claimed bool
}

type DialogReceipt struct {
	DialogIdentity
	Acknowledged bool `json:"acknowledged"`
}

// encoding/json replaces lone UTF-16 surrogates with U+FFFD. Reject them before
// decoding so the bridge and viewer cannot disagree on a decision's text.
func dialogText(raw json.RawMessage, max int, empty, controls bool) bool {
	var value string
	if len(raw) < 2 || raw[0] != '"' || !utf8.Valid(raw) || json.Unmarshal(raw, &value) != nil || len(value) > max || !empty && value == "" {
		return false
	}
	for i := 1; i < len(raw)-1; i++ {
		if raw[i] != '\\' {
			continue
		}
		i++
		if raw[i] != 'u' {
			continue
		}
		n, err := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		i += 4
		if !utf16.IsSurrogate(rune(n)) {
			continue
		}
		if n < 0xd800 || n > 0xdbff || i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
			return false
		}
		low, err := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
		if err != nil || low < 0xdc00 || low > 0xdfff {
			return false
		}
		i += 6
	}
	if !controls {
		for _, r := range value {
			if r < 32 || r == 127 {
				return false
			}
		}
	}
	return true
}

func dialogIdentity(f map[string]json.RawMessage) bool {
	return dialogText(f["leaseId"], 128, false, false) && integer(f["generation"], 1, MaxSafeInteger) && dialogText(f["dialogId"], 128, false, false)
}

func validateDialogResponse(f map[string]json.RawMessage) error {
	var accept bool
	if !dialogIdentity(f) || bytes.Equal(f["accept"], []byte("null")) || json.Unmarshal(f["accept"], &accept) != nil ||
		f["promptText"] != nil && (!accept || !dialogText(f["promptText"], MaxDialogTextBytes, true, true)) {
		return errors.New("invalid typed human dialog response")
	}
	return nil
}

func ParsePendingDialog(data json.RawMessage, human *HumanState) (*PendingDialog, error) {
	if len(data) == 0 || bytes.Equal(data, []byte("null")) {
		return nil, nil
	}
	f, err := Object(data)
	if err != nil || !exact(f, []string{"leaseId", "generation", "dialogId", "type", "message"}, []string{"defaultPrompt", "source"}) || !dialogIdentity(f) ||
		!choice(f["type"], "alert", "confirm", "prompt", "beforeunload") || !dialogText(f["message"], MaxDialogTextBytes, true, true) ||
		f["defaultPrompt"] != nil && (!choice(f["type"], "prompt") || !dialogText(f["defaultPrompt"], MaxDialogTextBytes, true, true)) {
		return nil, errors.New("invalid pending human dialog")
	}
	var result PendingDialog
	_ = json.Unmarshal(data, &result)
	if raw, present := f["source"]; present {
		source, err := parseDialogSource(raw)
		if err != nil {
			return nil, err
		}
		result.Source = source
	}
	if human == nil || human.State != "active" && human.State != "preparing" && human.State != "navigating" || human.Generation == 0 || human.LeaseID != result.LeaseID || human.Generation != result.Generation {
		return nil, errors.New("pending dialog has no original admitted human generation")
	}
	return &result, nil
}

func ParseDialogReceipt(data json.RawMessage) (*DialogReceipt, error) {
	if len(data) == 0 {
		return nil, nil
	}
	f, err := Object(data)
	if err != nil || !exact(f, []string{"leaseId", "generation", "dialogId", "acknowledged"}, nil) || !dialogIdentity(f) || !bytes.Equal(f["acknowledged"], []byte("true")) {
		return nil, errors.New("invalid human dialog receipt")
	}
	var result DialogReceipt
	_ = json.Unmarshal(data, &result)
	return &result, nil
}

func MatchDialogReceipt(request map[string]json.RawMessage, receipt *DialogReceipt) bool {
	var original DialogIdentity
	data, err := json.Marshal(request)
	return err == nil && json.Unmarshal(data, &original) == nil && receipt != nil && receipt.Acknowledged && original == receipt.DialogIdentity
}

// MatchDialogResponse checks the typed decision against an observed original
// dialog. The native owner must repeat this check at its dispatch boundary.
func MatchDialogResponse(request map[string]json.RawMessage, pending *PendingDialog) bool {
	if pending == nil || validateDialogResponse(request) != nil {
		return false
	}
	return MatchDialogReceipt(request, &DialogReceipt{DialogIdentity: pending.DialogIdentity, Acknowledged: true}) &&
		(request["promptText"] == nil || pending.Type == "prompt")
}
