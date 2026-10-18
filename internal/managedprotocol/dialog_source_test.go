package managedprotocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func sourceDialogJSON(source string) json.RawMessage {
	base := `{"leaseId":"lease","generation":1,"dialogId":"dialog","type":"prompt","message":"original"`
	if source != "" {
		base += `,"source":` + source
	}
	return json.RawMessage(base + `}`)
}

func TestDialogSourceCanonicalAndLegacy(t *testing.T) {
	human := &HumanState{State: "preparing", LeaseID: "lease", Generation: 1}
	for _, origin := range []string{"", "https://example.test", "http://localhost:8080", "http://127.0.0.1:0", "https://xn--bcher-kva.example", "https://[::1]", "https://[2001:db8::1]:8443", "http://[::ffff:c000:201]", "https://a..b", "https://a!b", "https://" + strings.Repeat("a", 2040)} {
		t.Run(origin, func(t *testing.T) {
			source := ""
			if origin != "" {
				source = string(mustJSON(map[string]string{"origin": origin, "frame": "child"}))
			}
			dialog, err := ParsePendingDialog(sourceDialogJSON(source), human)
			if err != nil {
				t.Fatalf("valid source rejected: %v", err)
			}
			out, _ := Object(mustJSON(dialog))
			if origin == "" && out["source"] != nil {
				t.Fatal("legacy omission became a source claim")
			}
			if origin != "" {
				var projected map[string]string
				if json.Unmarshal(out["source"], &projected) != nil || projected["origin"] != origin || projected["frame"] != "child" {
					t.Fatalf("source projection changed: %s", out["source"])
				}
			}
		})
	}
}

func TestDialogSourceRejectsUnprovedOrNoncanonicalMetadata(t *testing.T) {
	human := &HumanState{State: "active", LeaseID: "lease", Generation: 1}
	bad := []string{`null`, `{}`, `{"origin":"https://a.test","frame":"remote"}`, `{"origin":"https://a.test","frame":"child","targetId":"private"}`, `{"origin":"https://a.test","origin":"https://b.test","frame":"child"}`}
	for _, origin := range []string{"https://0x", "https://a.999999999999999999999999999999999999", "https://xn--", "https://xn--a"} {
		bad = append(bad, string(mustJSON(map[string]string{"origin": origin, "frame": "child"})))
	}
	for _, origin := range []string{"null", "about:blank", "file://host", "HTTPS://example.test", "https://EXAMPLE.test", "https://a.test/", "https://u@a.test", "https://a.test?", "https://a.test#", "https://a.test:", "https://a.test:443", "http://a.test:80", "https://a.test:0444", "https://a.test:65536", "https://127.1", "https://0177.0.0.1", "https://0x7f000001", "https://[0:0:0:0:0:0:0:1]", "https://[::FFFF:c000:201]", "https://[::ffff:192.0.2.1]", "https://bücher.test", "https://a%2etest", "https://a.test\n", "https://" + strings.Repeat("a", 2041)} {
		bad = append(bad, string(mustJSON(map[string]string{"origin": origin, "frame": "top-level"})))
	}
	for _, source := range bad {
		if _, err := ParsePendingDialog(sourceDialogJSON(source), human); err == nil {
			t.Fatalf("invalid source accepted: %.100s", source)
		}
	}
	for _, owner := range []*HumanState{nil, {State: "starting", LeaseID: "lease", Generation: 1}, {State: "preparing", LeaseID: "lease", Generation: 0}} {
		if _, err := ParsePendingDialog(sourceDialogJSON(`{"origin":"https://a.test","frame":"child"}`), owner); err == nil {
			t.Fatal("source granted human authority")
		}
	}
}

func TestDialogSourceCopiesAndDecisionDoNotGainAuthority(t *testing.T) {
	human := &HumanState{State: "active", LeaseID: "lease", Generation: 1}
	dialog, err := ParsePendingDialog(sourceDialogJSON(`{"origin":"https://original.test","frame":"child"}`), human)
	if err != nil {
		t.Fatal(err)
	}
	copy := *dialog
	copy.Source.Origin = "https://changed.test"
	if dialog.Source.Origin != "https://original.test" {
		t.Fatal("copy mutated original metadata")
	}
	request, _ := Object([]byte(`{"operation":"humanDialogRespond","leaseId":"lease","generation":1,"dialogId":"dialog","accept":true}`))
	if !MatchDialogResponse(request, dialog) {
		t.Fatal("source changed the existing decision tuple")
	}
	request["source"] = mustJSON(dialog.Source)
	if ValidateHuman("humanDialogRespond", request) == nil {
		t.Fatal("display source entered decision authority")
	}
	if _, err := ParseDialogReceipt([]byte(`{"leaseId":"lease","generation":1,"dialogId":"dialog","acknowledged":true,"source":{"origin":"https://original.test","frame":"child"}}`)); err == nil {
		t.Fatal("display metadata masqueraded as native receipt")
	}
}
