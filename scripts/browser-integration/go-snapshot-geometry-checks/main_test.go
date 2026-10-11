package main

import (
	"encoding/json"
	"testing"

	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
)

func TestScreenshotEvidenceUsesSharedArtifactFieldNames(t *testing.T) {
	native := obu.Screenshot{Base64: "AAECAw==", MimeType: "image/png"}
	encoded, err := json.Marshal(screenshotEvidence(native))
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"base64":"AAECAw==","mimeType":"image/png"}` {
		t.Fatalf("Unexpected screenshot artifact: %s", encoded)
	}
}
