package managedviewer

import (
	"encoding/json"
	"os"
	"testing"
)

// First run testdata/generate-bridge-fixture.mjs to capture the real private
// bridge. This opt-in then regenerates public goldens through the real Go
// projection; normal test runs only compare and never mutate fixtures.
func updatePublicFixture(t *testing.T, path string, actual any) bool {
	t.Helper()
	if os.Getenv("OBU_UPDATE_VIEWER_FIXTURES") != "1" {
		return false
	}
	data, err := json.MarshalIndent(actual, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	return true
}
