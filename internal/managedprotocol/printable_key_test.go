package managedprotocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPrintableKeyStateProjectionAndBounds(t *testing.T) {
	base := `{"state":"active","leaseId":"original","tabId":1,"generation":1,"viewport":{"width":640,"height":480}`
	for _, suffix := range []string{`}`, `,"printableKeyVersion":1}`} {
		h, err := ParseHumanState([]byte(base + suffix))
		if err != nil || string(mustJSON(h)) != base+suffix {
			t.Fatalf("optional printable capability changed: %s %v", mustJSON(h), err)
		}
	}
	for _, raw := range []string{"null", "0", "2", "-1", "1.0", `"1"`, "true", "{}"} {
		if _, err := ParseHumanState([]byte(base + `,"printableKeyVersion":` + raw + `}`)); err == nil {
			t.Errorf("invalid capability accepted: %s", raw)
		}
	}
	if _, err := ParseHumanState([]byte(base + `,"printableKeyVersion":1,"printableKeyVersion":1}`)); err == nil {
		t.Fatal("duplicate capability accepted")
	}
	if _, err := ParseViewState([]byte(base + `,"printableKeyVersion":1}`)); err == nil {
		t.Fatal("read-only view acquired printable input authority")
	}
	f, _ := Object([]byte(`{"operation":"humanInput","leaseId":"original","generation":1,"sequence":1,"printableKeyVersion":1,"input":{"type":"text","text":"x"}}`))
	if ValidateHuman("humanInput", f) == nil {
		t.Fatal("caller chose its own printable capability")
	}
}

func TestPrintableKeyTextUsesPinnedNativeUTF16Limit(t *testing.T) {
	key := `{"type":"key","action":"down","key":"a","code":"KeyA","windowsVirtualKeyCode":65`
	validate := func(input string) error {
		f, err := Object([]byte(`{"operation":"humanInput","leaseId":"original","generation":1,"sequence":1,"input":` + input + `}`))
		if err != nil {
			return err
		}
		return ValidateHuman("humanInput", f)
	}
	for _, value := range []string{"a", " ", "!", "é", "e\u0301", "😀", "😀a", "abc", "�"} {
		encoded, _ := json.Marshal(value)
		for _, suffix := range []string{`}`, `,"modifiers":8}`, `,"repeat":true}`} {
			if err := validate(key + `,"text":` + string(encoded) + suffix); err != nil {
				t.Errorf("valid native text rejected %q: %v", value, err)
			}
		}
	}
	for _, raw := range []string{`""`, `null`, `true`, `1`, `{}`, `[]`, `"abcd"`, `"😀😀"`, `"\ud800"`, `"\udc00"`, `"a\ud800"`, `"\u0000"`, `"\t"`, `"\n"`, `"\r"`, `"\u007f"`, `"\u0085"`, `"\u009f"`} {
		if validate(key+`,"text":`+raw+`}`) == nil {
			t.Errorf("invalid text accepted: %s", raw)
		}
	}
	for _, modifiers := range []string{"1", "2", "3", "4", "9", "10", "12", "15"} {
		if validate(key+`,"text":"a","modifiers":`+modifiers+`}`) == nil {
			t.Errorf("shortcut modifiers accepted: %s", modifiers)
		}
	}
	for _, raw := range []string{`"Enter"`, `"Shift"`, `"Dead"`, `"ab"`, `"e\u0301"`, `"\ud800"`, `"\udc00"`, `"\u0085"`} {
		if validate(strings.Replace(key+`,"text":"a"}`, `"key":"a"`, `"key":`+raw, 1)) == nil {
			t.Errorf("invalid printable key accepted: %s", raw)
		}
	}
	for _, input := range []string{
		strings.Replace(key+`,"text":"a"}`, `"down"`, `"up"`, 1),
		`{"type":"key","action":"down","key":"c","code":"KeyC","windowsVirtualKeyCode":67,"modifiers":2,"clipboardTransfer":"copy","text":"c"}`,
		key + `,"text":"a","text":"b"}`,
		`{"type":"pointer","action":"move","x":1,"y":1,"text":"a"}`,
	} {
		if validate(input) == nil {
			t.Errorf("non-printable shape accepted: %s", input)
		}
	}
	if err := validate(key + `}`); err != nil {
		t.Fatal("legacy raw down rejected", err)
	}
}
