package managedprotocol

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestHumanFileStrictCommandsAndNames(t *testing.T) {
	const tuple = `"leaseId":"lease","generation":1,"chooserId":"chooser"`
	good := []string{
		`{"operation":"humanFileBegin",` + tuple + `,"files":[{"name":"报告.txt","size":0},{"name":"报告.txt","size":2}]}`,
		`{"operation":"humanFileChunk",` + tuple + `,"transferId":"transfer","fileIndex":0,"offset":0,"data":"AAE="}`,
		`{"operation":"humanFileCommit",` + tuple + `,"transferId":"transfer"}`,
		`{"operation":"humanFileCancel",` + tuple + `}`,
		`{"operation":"humanFileCancel",` + tuple + `,"transferId":"transfer"}`,
	}
	for _, data := range good {
		f, err := Object([]byte(data))
		var operation string
		_ = json.Unmarshal(f["operation"], &operation)
		if err != nil || ValidateHuman(operation, f) != nil {
			t.Fatalf("valid bounded request rejected: %s", data)
		}
		for _, extra := range []string{`"path":"C:\\private"`, `"files":[]`, `"timeoutMs":600000`, `"generation":2`} {
			bad := strings.TrimSuffix(data, "}") + "," + extra + "}"
			f, err := Object([]byte(bad))
			if err == nil && ValidateHuman(operation, f) == nil {
				t.Fatalf("extra or duplicate authority accepted: %s", bad)
			}
		}
	}
	for _, name := range []string{"", ".", "..", "../file", `C:\a`, "a/b", "a:b", "CON", "CON .txt", "LPT1  .csv", "com¹.txt", "LPT9", "name.", "name ", "a\x00b", strings.Repeat("x", 241)} {
		if HumanFileName(name) {
			t.Fatalf("unsafe basename accepted: %q", name)
		}
	}
	for _, raw := range []string{`[]`, `null`, `[{"name":"a","size":33554433}]`, `[{"name":"\ud800","size":1}]`, `[{"name":"a","size":1.0}]`, `[{"name":"a","size":null}]`} {
		if _, _, err := ParseHumanFiles(json.RawMessage(raw)); err == nil {
			t.Fatalf("invalid metadata accepted: %s", raw)
		}
	}
}

func TestHumanFileChunkCanonicalAndBounded(t *testing.T) {
	for _, encoded := range []string{"", "Zg", "Zh==", "Zg==\n", base64.StdEncoding.EncodeToString(make([]byte, MaxHumanChunkBytes+1))} {
		raw, _ := json.Marshal(encoded)
		if _, err := DecodeHumanFileChunk(raw); err == nil {
			t.Fatalf("invalid encoding accepted: %q", encoded[:min(len(encoded), 30)])
		}
	}
	raw, _ := json.Marshal(base64.StdEncoding.EncodeToString(make([]byte, MaxHumanChunkBytes)))
	if data, err := DecodeHumanFileChunk(raw); err != nil || len(data) != MaxHumanChunkBytes {
		t.Fatal("exact chunk limit rejected", err)
	}
}

func TestHumanFileChooserScopeAndReceipt(t *testing.T) {
	human := &HumanState{LeaseID: "l", Generation: 1, State: "preparing", FileChooserVersion: 1}
	pending := json.RawMessage(`{"leaseId":"l","generation":1,"chooserId":"c","multiple":true,"source":{"origin":"https://example.test","frame":"child"}}`)
	if _, err := ParsePendingFileChooser(pending, human); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"legacy", "generation", "lease", "released"} {
		h := *human
		switch mode {
		case "legacy":
			h.FileChooserVersion = 0
		case "generation":
			h.Generation = 2
		case "lease":
			h.LeaseID = "other"
		case "released":
			h.State = "released"
		}
		if _, err := ParsePendingFileChooser(pending, &h); err == nil {
			t.Fatal("foreign chooser accepted", mode)
		}
	}
	request, _ := Object([]byte(`{"operation":"humanFileCommit","leaseId":"l","generation":1,"chooserId":"c","transferId":"t"}`))
	receipt := `{"leaseId":"l","generation":1,"chooserId":"c","transferId":"t","acknowledged":true}`
	if !MatchFileResult(request, "fileChooserReceipt", json.RawMessage(receipt)) {
		t.Fatal("original ACK rejected")
	}
	for _, bad := range []string{strings.Replace(receipt, `"t"`, `"other"`, 1), strings.Replace(receipt, "true", "false", 1), strings.TrimSuffix(receipt, "}") + `,"path":"private"}`, "null"} {
		if MatchFileResult(request, "fileChooserReceipt", json.RawMessage(bad)) {
			t.Fatal("mismatched/private receipt accepted", bad)
		}
	}
}
