// Public Go SDK acceptance. The parent validates the pinned headless build's
// memory clipboard before running this separate process.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
)

func must[T any](value T, err error) T {
	if err != nil {
		panic(err)
	}
	return value
}
func require(ok bool, message string) {
	if !ok {
		panic(message)
	}
}
func check(err error) {
	if err != nil {
		panic(err)
	}
}
func ptr(value string) *string { return &value }
func main() {
	require(os.Getenv("OBU_TEST_MEMORY_CLIPBOARD") == "1", "Clipboard acceptance requires the verified headless memory-clipboard harness")
	require(len(os.Args) == 5, "usage: go-clipboard-checks endpoint fixtureURL artifactPath pngPath")
	endpoint, url, artifact, pngPath := os.Args[1], os.Args[2], os.Args[3], os.Args[4]
	_, err := os.Stat(artifact)
	require(os.IsNotExist(err), "clipboard artifact already exists or cannot be checked")
	png := must(os.ReadFile(pngPath))
	require(len(png) >= 8 && bytes.Equal(png[:8], []byte{137, 80, 78, 71, 13, 10, 26, 10}), "input is not PNG")
	browser := must(obu.ConnectOpenBrowserUse(obu.Options{SocketPath: endpoint, SessionID: "go-clipboard-integration", TurnID: "clipboard-acceptance", Timeout: 15 * time.Second}))
	defer browser.Close()
	defer func() { _, err := browser.Client.FinalizeTabs(nil); check(err) }()
	info := must(browser.Client.GetInfo()).(map[string]any)
	require(info["metadata"].(map[string]any)["clipboardVersion"] == float64(1), "clipboard v1 unavailable")
	tab := must(browser.NewTab(obu.GotoOptions{URL: url}))
	clipboard := tab.Clipboard()
	text := "Go clipboard 中文🙂"
	check(clipboard.WriteText(text))
	require(must(clipboard.ReadText()) == text, "Unicode text mismatch")
	items := []obu.ClipboardItem{{Entries: []obu.ClipboardEntry{{MIMEType: "text/plain", Text: &text}, {MIMEType: "text/html", Text: ptr("<b>" + text + "</b>")}, {MIMEType: "image/png", Base64: ptr(base64.StdEncoding.EncodeToString(png))}}}}
	check(clipboard.Write(items))
	actual := must(clipboard.Read())
	require(len(actual) == 1 && len(actual[0].Entries) == 3, "missing clipboard representations")
	entries := map[string]obu.ClipboardEntry{}
	for _, entry := range actual[0].Entries {
		entries[entry.MIMEType] = entry
	}
	require(entries["text/plain"].Text != nil && *entries["text/plain"].Text == text, "plain text mismatch")
	require(entries["text/html"].Text != nil && strings.Contains(*entries["text/html"].Text, text), "HTML missing text")
	require(entries["image/png"].Base64 != nil, "PNG absent")
	returnedPNG := must(base64.StdEncoding.Strict().DecodeString(*entries["image/png"].Base64))
	require(len(returnedPNG) > 8 && bytes.Equal(returnedPNG[:8], png[:8]), "PNG invalid")
	check(clipboard.Write([]obu.ClipboardItem{}))
	require(reflect.DeepEqual(must(clipboard.Read()), actual), "empty items changed clipboard")
	err = clipboard.Write([]obu.ClipboardItem{{Entries: []obu.ClipboardEntry{{MIMEType: "image/jpeg", Base64: ptr(base64.StdEncoding.EncodeToString(png))}}}})
	require(err != nil, "unknown MIME accepted")
	_, err = browser.Client.WriteClipboard(tab.ID, []obu.Params{{"entries": []obu.Params{{"mime_type": "text/plain", "text": "x", "extra": true}}}})
	require(err != nil, "unknown entry field accepted")
	err = clipboard.WriteText("中文", obu.ClipboardOptions{MaxBytes: 1})
	require(err != nil, "byte cap ignored")
	require(reflect.DeepEqual(must(clipboard.Read()), actual), "invalid writes changed clipboard")
	file := must(os.OpenFile(artifact, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600))
	err = json.NewEncoder(file).Encode(map[string]any{"items": actual})
	closeErr := file.Close()
	check(err)
	check(closeErr)
	digest := sha256.Sum256(returnedPNG)
	check(json.NewEncoder(os.Stdout).Encode(map[string]any{"checks": []string{"text-unicode", "three-representations", "empty-items-no-op", "invalid-and-oversize-no-mutation"}, "artifact": filepath.Base(artifact), "tabId": tab.ID, "pngBytes": len(returnedPNG), "pngSHA256": fmt.Sprintf("%x", digest)}))
}
