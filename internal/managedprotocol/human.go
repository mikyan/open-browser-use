// Package managedprotocol validates bounded human input shared by the local
// viewer and the private worker adapter. It grants no browser authority.
package managedprotocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"regexp"
	"unicode/utf16"
	"unicode/utf8"
)

const MaxSafeInteger = 1<<53 - 1
const MaxCommandBytes = 32 << 10

// ErrHumanGenerationRetired cancels only the old generation's unsent work.
// Adapters must still settle input already submitted to the original native
// channel; this local cause is never proof of a native acknowledgement.
var ErrHumanGenerationRetired = errors.New("human input generation retired")

func HumanFields(operation string) []string {
	switch operation {
	case "humanBegin":
		return []string{"operation", "tabId"}
	case "humanEnd":
		return []string{"operation", "leaseId"}
	case "humanInput":
		return []string{"operation", "leaseId", "generation", "sequence", "input"}
	}
	return nil
}

func Object(data []byte) (map[string]json.RawMessage, error) {
	if !utf8.Valid(data) {
		return nil, errors.New("invalid UTF-8 JSON")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	if token, err := d.Token(); err != nil || token != json.Delim('{') {
		return nil, errors.New("expected input object")
	}
	f := map[string]json.RawMessage{}
	for d.More() {
		token, err := d.Token()
		name, ok := token.(string)
		if err != nil || !ok || f[name] != nil {
			return nil, errors.New("invalid or duplicate input field")
		}
		var value json.RawMessage
		if err := d.Decode(&value); err != nil {
			return nil, err
		}
		f[name] = value
	}
	if _, err := d.Token(); err != nil {
		return nil, err
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, errors.New("trailing input JSON")
	}
	return f, nil
}

func exact(f map[string]json.RawMessage, required, optional []string) bool {
	allowed := map[string]bool{}
	for _, name := range required {
		if len(f[name]) == 0 || bytes.Equal(f[name], []byte("null")) {
			return false
		}
		allowed[name] = true
	}
	for _, name := range optional {
		allowed[name] = true
	}
	for name := range f {
		if !allowed[name] {
			return false
		}
	}
	return true
}

func integer(raw json.RawMessage, minimum, maximum uint64) bool {
	var value uint64
	return !bytes.Equal(raw, []byte("null")) && json.Unmarshal(raw, &value) == nil && value >= minimum && value <= maximum
}
func finite(raw json.RawMessage, maximum float64, positive bool) bool {
	var value float64
	return !bytes.Equal(raw, []byte("null")) && json.Unmarshal(raw, &value) == nil && !math.IsNaN(value) && !math.IsInf(value, 0) && math.Abs(value) <= maximum && (!positive || value >= 0)
}
func text(raw json.RawMessage, maximum int, controls bool) bool {
	var value string
	if json.Unmarshal(raw, &value) != nil || value == "" || len(utf16.Encode([]rune(value))) > maximum {
		return false
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
func choice(raw json.RawMessage, values ...string) bool {
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return false
	}
	for _, candidate := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

func ValidateHuman(operation string, f map[string]json.RawMessage) error {
	bad := errors.New("invalid typed human command")
	required := HumanFields(operation)
	if required == nil || !exact(f, required, nil) || !choice(f["operation"], operation) {
		return bad
	}
	if operation == "humanBegin" {
		if !integer(f["tabId"], 1, MaxSafeInteger) {
			return bad
		}
		return nil
	}
	if !text(f["leaseId"], 128, false) {
		return bad
	}
	if operation == "humanEnd" {
		return nil
	}
	if !integer(f["generation"], 1, MaxSafeInteger) || !integer(f["sequence"], 1, MaxSafeInteger) || len(f["input"]) > 32<<10 {
		return bad
	}
	input, err := Object(f["input"])
	if err != nil {
		return bad
	}
	var kind string
	if json.Unmarshal(input["type"], &kind) != nil {
		return bad
	}
	if raw, exists := input["modifiers"]; exists && !integer(raw, 0, 15) {
		return bad
	}
	switch kind {
	case "pointer":
		if !exact(input, []string{"type", "action", "x", "y"}, []string{"button", "modifiers"}) || !choice(input["action"], "move", "down", "up") || !finite(input["x"], 100000, true) || !finite(input["y"], 100000, true) {
			return bad
		}
		if raw, exists := input["button"]; exists && (!choice(raw, "left", "middle", "right") || choice(input["action"], "move")) {
			return bad
		}
		if !choice(input["action"], "move") && input["button"] == nil {
			return bad
		}
	case "wheel":
		if !exact(input, []string{"type", "x", "y", "deltaX", "deltaY"}, []string{"modifiers"}) || !finite(input["x"], 100000, true) || !finite(input["y"], 100000, true) || !finite(input["deltaX"], 4096, false) || !finite(input["deltaY"], 4096, false) {
			return bad
		}
	case "key":
		if !exact(input, []string{"type", "action", "key", "code", "windowsVirtualKeyCode"}, []string{"modifiers"}) || !choice(input["action"], "down", "up") || !text(input["key"], 64, false) || !text(input["code"], 64, false) || !integer(input["windowsVirtualKeyCode"], 0, 255) {
			return bad
		}
		var code string
		_ = json.Unmarshal(input["code"], &code)
		if !keyCodePattern.MatchString(code) {
			return bad
		}
	case "text":
		if !exact(input, []string{"type", "text"}, nil) || !text(input["text"], 4096, true) {
			return bad
		}
		var value string
		_ = json.Unmarshal(input["text"], &value)
		for _, r := range value {
			if r < 32 && r != '\t' && r != '\r' && r != '\n' || r == 127 {
				return bad
			}
		}
	default:
		return bad
	}
	return nil
}

var keyCodePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]{0,63}$`)

type Viewport struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// HumanState deliberately omits document, target, channel and native handles.
type HumanState struct {
	State      string    `json:"state"`
	LeaseID    string    `json:"leaseId"`
	TabID      uint64    `json:"tabId"`
	Generation uint64    `json:"generation"`
	Viewport   *Viewport `json:"viewport"`
}

type HumanCleanup struct {
	LeaseID          string `json:"leaseId"`
	CleanupConfirmed bool   `json:"cleanupConfirmed"`
}

type InputReceipt struct {
	LeaseID      string `json:"leaseId"`
	Generation   uint64 `json:"generation"`
	Sequence     uint64 `json:"sequence"`
	Acknowledged bool   `json:"acknowledged"`
}

func ParseHumanState(data json.RawMessage) (*HumanState, error) {
	if len(data) == 0 || bytes.Equal(data, []byte("null")) {
		return nil, nil
	}
	f, err := Object(data)
	if err != nil || !choice(f["state"], "starting", "active", "navigating", "releasing", "released", "error") || !text(f["leaseId"], 128, false) || !integer(f["tabId"], 1, MaxSafeInteger) || !integer(f["generation"], 0, MaxSafeInteger) || f["viewport"] == nil {
		return nil, errors.New("invalid human status")
	}
	var result HumanState
	if json.Unmarshal(data, &result) != nil {
		return nil, errors.New("invalid human status")
	}
	if result.State == "navigating" && (result.Generation == 0 || !bytes.Equal(f["viewport"], []byte("null"))) {
		return nil, errors.New("invalid navigating human generation")
	}
	if !bytes.Equal(f["viewport"], []byte("null")) {
		viewport, err := Object(f["viewport"])
		if err != nil || !finite(viewport["width"], 16384, true) || !finite(viewport["height"], 16384, true) || result.Viewport.Width < 1 || result.Viewport.Height < 1 {
			return nil, errors.New("invalid human viewport")
		}
	} else if result.State == "active" && result.Generation != 0 {
		return nil, errors.New("active human viewport missing")
	}
	if raw, ok := f["lastInputSequence"]; ok && !integer(raw, 0, MaxSafeInteger) {
		return nil, errors.New("invalid human sequence")
	}
	return &result, nil
}

func ParseHumanCleanup(data json.RawMessage) (*HumanCleanup, error) {
	if len(data) == 0 {
		return nil, nil
	}
	f, err := Object(data)
	if err != nil || !text(f["leaseId"], 128, false) || !bytes.Equal(f["cleanupConfirmed"], []byte("true")) {
		return nil, errors.New("invalid human cleanup receipt")
	}
	var result HumanCleanup
	_ = json.Unmarshal(data, &result)
	return &result, nil
}

func ParseInputReceipt(data json.RawMessage) (*InputReceipt, error) {
	if len(data) == 0 {
		return nil, nil
	}
	f, err := Object(data)
	if err != nil || !text(f["leaseId"], 128, false) || !integer(f["generation"], 1, MaxSafeInteger) || !integer(f["sequence"], 1, MaxSafeInteger) || !bytes.Equal(f["acknowledged"], []byte("true")) {
		return nil, errors.New("invalid human input receipt")
	}
	var result InputReceipt
	_ = json.Unmarshal(data, &result)
	return &result, nil
}

// MatchInputReceipt never manufactures acknowledgement from a submitted request.
func MatchInputReceipt(request map[string]json.RawMessage, receipt *InputReceipt) bool {
	if receipt == nil {
		return false
	}
	var lease string
	var generation, sequence uint64
	return json.Unmarshal(request["leaseId"], &lease) == nil && json.Unmarshal(request["generation"], &generation) == nil && json.Unmarshal(request["sequence"], &sequence) == nil && receipt.LeaseID == lease && receipt.Generation == generation && receipt.Sequence == sequence && receipt.Acknowledged
}

func ParseFrameIdentity(f map[string]json.RawMessage) (mode, lease string, generation uint64, err error) {
	bad := errors.New("invalid human frame identity")
	if f["controlMode"] == nil {
		if f["humanLeaseId"] != nil || f["generation"] != nil {
			return "", "", 0, bad
		}
		return "", "", 0, nil
	}
	if json.Unmarshal(f["controlMode"], &mode) != nil || mode != "human" && mode != "observe" {
		return "", "", 0, bad
	}
	if mode == "observe" {
		if f["humanLeaseId"] != nil || f["generation"] != nil {
			return "", "", 0, bad
		}
		return mode, "", 0, nil
	}
	if !text(f["humanLeaseId"], 128, false) || !integer(f["generation"], 1, MaxSafeInteger) {
		return "", "", 0, bad
	}
	_ = json.Unmarshal(f["humanLeaseId"], &lease)
	_ = json.Unmarshal(f["generation"], &generation)
	return mode, lease, generation, nil
}
