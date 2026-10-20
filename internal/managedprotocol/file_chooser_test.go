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

func TestHumanDirectoryManifestPreservesHierarchyAndRejectsAmbiguousPaths(t *testing.T) {
	file := func(path string) HumanFile {
		parts := strings.Split(path, "/")
		return HumanFile{Name: parts[len(parts)-1], RelativePath: path}
	}
	good := []HumanFile{file("资料/甲/相同.txt"), file("资料/乙/相同.txt"), file("资料/空文件")}
	raw, _ := json.Marshal(good)
	got, total, err := ParseHumanFiles(raw)
	if err != nil || total != 0 || len(got) != 3 || got[1].RelativePath != good[1].RelativePath {
		t.Fatal("original nested names or empty file lost", err)
	}
	for name, paths := range map[string][]string{
		"absolute": {"/root/a"}, "drive": {"C:/root/a"}, "backslash": {`root\dir/a`},
		"empty segment": {"root//a"}, "dot": {"root/./a"}, "traversal": {"root/../a"},
		"bare file": {"a"}, "reserved ancestor": {"root/CON/a"}, "trailing space": {"root/dir /a"},
		"mixed roots": {"root/a", "other/b"}, "root case": {"root/a", "ROOT/b"},
		"directory case": {"root/Folder/a", "root/folder/b"}, "unicode case": {"root/Σ/a", "root/ς/b"},
		"duplicate": {"root/a", "root/a"}, "file case": {"root/a", "root/A"},
		"file before directory": {"root/a", "root/a/b"}, "directory before file": {"root/a/b", "root/a"},
		"too deep": {strings.Repeat("r/", MaxHumanPathSegments) + "a"},
	} {
		t.Run(name, func(t *testing.T) {
			files := []HumanFile{}
			for _, path := range paths {
				files = append(files, file(path))
			}
			raw, _ := json.Marshal(files)
			if _, _, err := ParseHumanFiles(raw); err == nil {
				t.Fatal("ambiguous path accepted", paths)
			}
		})
	}
	for _, raw := range []string{
		`[{"name":"a","size":0,"relativePath":"root/b"}]`,
		`[{"name":"a","size":0,"relativePath":"root/a"},{"name":"b","size":0}]`,
		`[{"name":"a","size":0},{"name":"b","size":0,"relativePath":"root/b"}]`,
		`[{"name":"a","size":0,"relativePath":null}]`,
		`[{"name":"a","size":0,"relativePath":""}]`,
		`[{"name":"a","size":0,"relativePath":"root/\ud800/a"}]`,
	} {
		if _, _, err := ParseHumanFiles(json.RawMessage(raw)); err == nil {
			t.Fatal("invalid directory metadata accepted", raw)
		}
	}
	if ValidateHumanFileMode(got, false) == nil || ValidateHumanFileMode([]HumanFile{{Name: "a"}}, true) == nil {
		t.Fatal("structural parser granted the chooser mode")
	}
}

func TestHumanDirectoryPathByteDepthAndCommandBudgets(t *testing.T) {
	path := strings.Repeat(strings.Repeat("中", 80)+"/", 4) + strings.Repeat("a", 60)
	if len(path) != MaxHumanRelativePathBytes {
		t.Fatal("test boundary drift")
	}
	row := HumanFile{Name: strings.Repeat("a", 60), RelativePath: path}
	if err := ValidateHumanFileMode([]HumanFile{row}, true); err != nil {
		t.Fatal("exact byte bound rejected", err)
	}
	row.RelativePath = "a" + row.RelativePath
	if err := ValidateHumanFileMode([]HumanFile{row}, true); err == nil {
		t.Fatal("UTF-8 byte bound ignored")
	}
	deep := HumanFile{Name: "a", RelativePath: strings.Repeat("r/", MaxHumanPathSegments-1) + "a"}
	if err := ValidateHumanFileMode([]HumanFile{deep}, true); err != nil {
		t.Fatal("exact segment bound rejected", err)
	}
	files := make([]HumanFile, MaxHumanFiles)
	for i := range files {
		name := strings.Repeat("a", 59) + string(rune('a'+i))
		files[i] = HumanFile{Name: name, RelativePath: path[:len(path)-60] + name}
	}
	request, _ := json.Marshal(map[string]any{"operation": "humanFileBegin", "leaseId": strings.Repeat("l", 128), "generation": MaxSafeInteger, "chooserId": strings.Repeat("c", 128), "files": files})
	fields, err := Object(request)
	if err != nil || len(request) > MaxCommandBytes || ValidateHuman("humanFileBegin", fields) != nil {
		t.Fatal("bounded manifest exceeds command contract", len(request), err)
	}
}

func TestHumanFileChooserVersionControlsDirectoryFieldAndRoundTrip(t *testing.T) {
	const base = `{"leaseId":"l","generation":1,"chooserId":"c","multiple":false`
	for _, version := range []uint64{0, 1, 2, 3} {
		for _, mode := range []string{"", `,"directory":true`, `,"directory":false`, `,"directory":null`, `,"directory":0`} {
			human := &HumanState{LeaseID: "l", Generation: 1, State: "active", FileChooserVersion: version}
			raw := json.RawMessage(base + mode + "}")
			chooser, err := ParsePendingFileChooser(raw, human)
			valid := version == 1 && mode == "" || version == 2 && (mode == `,"directory":true` || mode == `,"directory":false`)
			if valid != (err == nil) {
				t.Fatalf("version %d mode %q accepted=%v", version, mode, err == nil)
			}
			if valid {
				serialized, err := json.Marshal(chooser)
				if err != nil {
					t.Fatal(err)
				}
				again, err := ParsePendingFileChooser(serialized, human)
				if err != nil || *again != *chooser {
					t.Fatal("chooser mode lost through sanitized status", string(serialized), err)
				}
			}
		}
	}
	for _, version := range []string{"1", "2", "0", "3", "null", "2.0"} {
		raw := json.RawMessage(`{"state":"preparing","leaseId":"l","tabId":1,"generation":1,"viewport":null,"fileChooserVersion":` + version + `}`)
		_, err := ParseHumanState(raw)
		if (err == nil) != (version == "1" || version == "2") {
			t.Fatal("incorrect version acceptance", version, err)
		}
	}
}
