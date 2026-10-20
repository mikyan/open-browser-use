package managedprotocol

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func clipboardRequest(input string) map[string]json.RawMessage {
	f, _ := Object([]byte(`{"operation":"humanInput","leaseId":"original","generation":1,"sequence":1,"input":` + input + `}`))
	return f
}

func TestClipboardTransferExactShortcut(t *testing.T) {
	base := `{"type":"key","action":"down","key":"c","code":"KeyC","windowsVirtualKeyCode":67,"modifiers":2,"clipboardTransfer":"copy"}`
	for _, op := range []string{"copy", "cut"} {
		for _, modifiers := range []int{2, 4} {
			for _, upper := range []bool{false, true} {
				key, code, vk := "c", "KeyC", 67
				if op == "cut" {
					key, code, vk = "x", "KeyX", 88
				}
				if upper {
					key = strings.ToUpper(key)
				}
				input := fmt.Sprintf(`{"type":"key","action":"down","key":%q,"code":%q,"windowsVirtualKeyCode":%d,"modifiers":%d,"clipboardTransfer":%q}`, key, code, vk, modifiers, op)
				if err := ValidateHuman("humanInput", clipboardRequest(input)); err != nil {
					t.Errorf("exact shortcut rejected: %s %v", input, err)
				}
			}
		}
	}
	invalid := []string{
		strings.Replace(base, `"down"`, `"up"`, 1),
		strings.Replace(base, `"copy"`, `"cut"`, 1),
		strings.Replace(base, `"key":"c"`, `"key":"x"`, 1),
		strings.Replace(base, `"code":"KeyC"`, `"code":"KeyX"`, 1),
		strings.Replace(base, `:67`, `:88`, 1),
		strings.Replace(base, `,"modifiers":2`, ``, 1),
		strings.Replace(base, `"clipboardTransfer":"copy"`, `"clipboardTransfer":null`, 1),
		strings.Replace(base, `"clipboardTransfer":"copy"`, `"clipboardTransfer":true`, 1),
		strings.Replace(base, `"clipboardTransfer":"copy"`, `"clipboardTransfer":"copy","repeat":true`, 1),
		strings.Replace(base, `"clipboardTransfer":"copy"`, `"clipboardTransfer":"copy","repeat":false`, 1),
		`{"type":"text","text":"c","clipboardTransfer":"copy"}`,
		`{"type":"pointer","action":"move","x":1,"y":1,"clipboardTransfer":"copy"}`,
		`{"type":"wheel","x":1,"y":1,"deltaX":1,"deltaY":1,"clipboardTransfer":"copy"}`,
	}
	for modifiers := 0; modifiers <= 15; modifiers++ {
		if modifiers != 2 && modifiers != 4 {
			invalid = append(invalid, strings.Replace(base, `"modifiers":2`, fmt.Sprintf(`"modifiers":%d`, modifiers), 1))
		}
	}
	for _, input := range invalid {
		if ValidateHuman("humanInput", clipboardRequest(input)) == nil {
			t.Errorf("invalid transfer input accepted: %s", input)
		}
	}
}

func TestClipboardTransferReceiptStrictShapeAndUnicode(t *testing.T) {
	base := `{"leaseId":"original","generation":1,"sequence":1,"acknowledged":true,"clipboardTransfer":%s}`
	valid := []string{`{"operation":"copy","status":"ready","text":""}`, `{"operation":"cut","status":"unchanged"}`, `{"operation":"copy","status":"ready","text":"中文\n\uD83E\uDDED"}`}
	for _, code := range []string{"UNSUPPORTED", "DENIED", "BUSY", "CANCELLED", "TIMEOUT", "CHANGED", "LIMIT", "READ_FAILED"} {
		valid = append(valid, fmt.Sprintf(`{"operation":"cut","status":"failed","code":%q}`, code))
	}
	for _, value := range valid {
		r, err := ParseInputReceipt([]byte(fmt.Sprintf(base, value)))
		if err != nil {
			t.Errorf("valid result rejected: %s %v", value, err)
			continue
		}
		fields, _ := Object(mustJSON(r))
		if string(fields["clipboardTransfer"]) != value {
			// JSON escaping is not the contract; semantic text and exact fields are.
			var got, want any
			_ = json.Unmarshal(fields["clipboardTransfer"], &got)
			_ = json.Unmarshal([]byte(value), &want)
			if string(mustJSON(got)) != string(mustJSON(want)) {
				t.Errorf("transfer result lost: %s", mustJSON(r))
			}
		}
		if !r.Acknowledged {
			t.Fatal("transfer failure erased native ACK")
		}
	}
	for _, size := range []int{65535, 65536, 65537} {
		value := fmt.Sprintf(`{"operation":"copy","status":"ready","text":%s}`, mustJSON(strings.Repeat("a", size)))
		_, err := ParseInputReceipt([]byte(fmt.Sprintf(base, value)))
		if (err == nil) != (size <= 65536) {
			t.Errorf("wrong byte bound %d: %v", size, err)
		}
	}
	for _, text := range []string{strings.Repeat("中", 21845) + "a", strings.Repeat("中", 21845) + "ab"} {
		_, err := ParseInputReceipt([]byte(fmt.Sprintf(base, fmt.Sprintf(`{"operation":"copy","status":"ready","text":%s}`, mustJSON(text)))))
		if (err == nil) != (len(text) <= 65536) {
			t.Errorf("UTF8 byte bound differs: %d", len(text))
		}
	}
	for _, value := range []string{
		`null`, `{}`, `{"operation":"paste","status":"unchanged"}`,
		`{"operation":"copy","status":"ready"}`, `{"operation":"copy","status":"ready","text":null}`,
		`{"operation":"copy","status":"ready","text":"\uD800"}`, `{"operation":"copy","status":"ready","text":"\uDC00"}`,
		`{"operation":"copy","status":"ready","text":"x","code":"DENIED"}`,
		`{"operation":"copy","status":"unchanged","text":""}`, `{"operation":"copy","status":"unchanged","code":"DENIED"}`,
		`{"operation":"copy","status":"failed"}`, `{"operation":"copy","status":"failed","code":"unknown"}`,
		`{"operation":"copy","status":"failed","code":"DENIED","text":""}`,
		`{"operation":"copy","status":"failed","code":"DENIED","private":"secret"}`,
		`{"operation":"copy","status":"unchanged","status":"ready","text":"x"}`,
	} {
		if _, err := ParseInputReceipt([]byte(fmt.Sprintf(base, value))); err == nil {
			t.Errorf("malformed transfer receipt accepted: %s", value)
		}
	}
}

func TestClipboardTransferReceiptMatchesOriginalRequestOnly(t *testing.T) {
	key := `{"type":"key","action":"down","key":"c","code":"KeyC","windowsVirtualKeyCode":67,"modifiers":2`
	requests := []map[string]json.RawMessage{clipboardRequest(key + `}`), clipboardRequest(key + `,"clipboardTransfer":"copy"}`)}
	for requestIndex, request := range requests {
		for _, transfer := range []string{``, `,"clipboardTransfer":{"operation":"copy","status":"ready","text":""}`, `,"clipboardTransfer":{"operation":"cut","status":"unchanged"}`, `,"clipboardTransfer":{"operation":"copy","status":"failed","code":"TIMEOUT"}`} {
			r, err := ParseInputReceipt([]byte(`{"leaseId":"original","generation":1,"sequence":1,"acknowledged":true` + transfer + `}`))
			want := requestIndex == 0 && transfer == "" || requestIndex == 1 && strings.Contains(transfer, `"operation":"copy"`)
			if err != nil || MatchInputReceipt(request, r) != want {
				t.Errorf("request %d and result %s: %v", requestIndex, transfer, err)
			}
		}
	}
}

func TestClipboardTransferStateProjectionAndBounds(t *testing.T) {
	base := `{"state":"active","leaseId":"original","tabId":1,"generation":1,"viewport":{"width":640,"height":480}`
	for _, suffix := range []string{`}`, `,"clipboardTransferVersion":1}`} {
		t.Run(suffix, func(t *testing.T) {
			h, err := ParseHumanState(json.RawMessage(base + suffix))
			if err != nil || string(mustJSON(h)) != base+suffix {
				t.Fatalf("optional capability was changed: %s %v", mustJSON(h), err)
			}
		})
	}
	for _, raw := range []string{"null", "0", "2", "-1", "1.0", `"1"`, "true", "{}"} {
		t.Run(raw, func(t *testing.T) {
			if _, err := ParseHumanState(json.RawMessage(base + `,"clipboardTransferVersion":` + raw + `}`)); err == nil {
				t.Fatal("invalid capability accepted")
			}
		})
	}
	if _, err := ParseHumanState(json.RawMessage(base + `,"clipboardTransferVersion":1,"clipboardTransferVersion":1}`)); err == nil {
		t.Fatal("duplicate capability accepted")
	}
	for _, generation := range []string{"0", "1"} {
		raw := `{"state":"preparing","leaseId":"original","tabId":1,"generation":` + generation + `,"viewport":null,"clipboardTransferVersion":1}`
		h, err := ParseHumanState(json.RawMessage(raw))
		if err != nil || string(mustJSON(h)) != raw {
			t.Fatalf("preparing capability lost: %s %v", mustJSON(h), err)
		}
	}
}

func TestClipboardTransferCapabilityIsNotCallerOrViewAuthority(t *testing.T) {
	base := `{"state":"active","leaseId":"original","tabId":1,"generation":1,"viewport":{"width":640,"height":480}`
	for _, raw := range []string{"1", "null", "0"} {
		if _, err := ParseViewState(json.RawMessage(base + `,"clipboardTransferVersion":` + raw + `}`)); err == nil {
			t.Errorf("readonly capability accepted: %s", raw)
		}
	}
	f, _ := Object([]byte(`{"operation":"humanInput","leaseId":"original","generation":1,"sequence":1,"clipboardTransferVersion":1,"input":{"type":"key","action":"down","key":"a","code":"KeyA","windowsVirtualKeyCode":65,"repeat":true}}`))
	if ValidateHuman("humanInput", f) == nil {
		t.Fatal("caller granted its own repeat capability")
	}
}
