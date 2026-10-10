package host

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPipeEndpointRecordsSurviveActiveRecordChanges(t *testing.T) {
	dir := t.TempDir()
	first, second := `\\.\pipe\open-browser-use-first`, `\\.\pipe\open-browser-use-second`
	for _, endpoint := range []string{first, second} {
		if err := WriteEndpointRecord(dir, endpoint); err != nil {
			t.Fatal(err)
		}
		if err := WriteActiveSocketRecord(dir, endpoint); err != nil {
			t.Fatal(err)
		}
	}
	if err := RemoveActiveSocketRecord(dir, first); err != nil {
		t.Fatal(err)
	}
	active, err := ReadActiveSocketRecord(dir)
	if err != nil || active.SocketPath != second {
		t.Fatalf("another host's active record changed: %#v %v", active, err)
	}
	if err := RemoveActiveSocketRecord(dir, second); err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []string{first, second} {
		record, err := ReadEndpointRecord(EndpointRecordPath(dir, endpoint))
		if err != nil || record.SocketPath != endpoint {
			t.Fatalf("lost independent endpoint: %#v %v", record, err)
		}
	}
	if err := RemoveEndpointRecord(dir, first); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadEndpointRecord(EndpointRecordPath(dir, second)); err != nil {
		t.Fatal(err)
	}
}

func TestEndpointRecordsRejectInvalidAndMismatchedRecords(t *testing.T) {
	dir := t.TempDir()
	endpoint := `\\.\pipe\open-browser-use-valid`
	path := EndpointRecordPath(dir, endpoint)
	for _, payload := range []string{`{}`, `{"socketPath":"/tmp/other.sock"}`, `{"socketPath":"\\\\server\\pipe\\remote"}`, `{"socketPath":"\\\\.\\pipe\\different"}`} {
		if err := os.WriteFile(path, []byte(payload), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadEndpointRecord(path); err == nil {
			t.Fatalf("accepted invalid descriptor: %s", payload)
		}
	}
	if err := WriteEndpointRecord(dir, filepath.Join(dir, "legacy.sock")); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("legacy sockets need no descriptor: %v %v", entries, err)
	}
}
