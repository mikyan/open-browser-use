// One owned Page download through the public typed Go SDK; no replay.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
)

const fileLimit = 65536

type readyGate struct {
	ReadyPath   string `json:"readyPath"`
	ReleasePath string `json:"releasePath"`
	Token       string `json:"token"`
}

type input struct {
	SocketPath   string    `json:"socketPath"`
	SessionID    string    `json:"sessionId"`
	TurnID       string    `json:"turnId"`
	ControlEpoch int64     `json:"controlEpoch"`
	TabID        int       `json:"tabId"`
	Variant      string    `json:"variant"`
	Key          string    `json:"key"`
	Kind         string    `json:"kind"`
	ReadyGate    readyGate `json:"readyGate"`
}

func repositoryTmp() (string, error) {
	directory, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if info, err := os.Stat(filepath.Join(directory, "go.mod")); err == nil && info.Mode().IsRegular() {
			return filepath.EvalSymlinks(filepath.Join(directory, ".tmp"))
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			return "", errors.New("repository .tmp directory not found")
		}
		directory = parent
	}
}

func validateGate(gate readyGate) error {
	if gate.Token == "" || len(gate.Token) > 256 || strings.IndexFunc(gate.Token, func(r rune) bool { return r <= 32 || r == 127 }) >= 0 {
		return errors.New("invalid readyGate token")
	}
	temporary, err := repositoryTmp()
	if err != nil {
		return err
	}
	parents := []string{}
	for _, path := range []string{gate.ReadyPath, gate.ReleasePath} {
		if !filepath.IsAbs(path) {
			return errors.New("ready gate paths must be absolute")
		}
		parent, err := filepath.EvalSymlinks(filepath.Dir(path))
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(temporary, parent)
		if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
			return errors.New("ready gate must stay in a dedicated repository .tmp directory")
		}
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			return errors.New("ready gate paths must be fresh")
		}
		parents = append(parents, parent)
	}
	if parents[0] != parents[1] || filepath.Clean(gate.ReadyPath) == filepath.Clean(gate.ReleasePath) {
		return errors.New("ready gate paths must be distinct files in the same run directory")
	}
	return nil
}

func awaitReadyGate(gate readyGate, detail map[string]any, deadline time.Time) error {
	if !time.Now().Before(deadline) {
		return errors.New("ready gate deadline expired before publication")
	}
	record := map[string]any{"token": gate.Token}
	for _, key := range []string{"waiterId", "remainingMs", "readyAt", "scope", "tabId"} {
		record[key] = detail[key]
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(gate.ReadyPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(append(encoded, '\n'))
	if err := errors.Join(writeErr, file.Close()); err != nil {
		return err
	}
	for time.Now().Before(deadline) {
		info, err := os.Lstat(gate.ReleasePath)
		if os.IsNotExist(err) {
			time.Sleep(min(25*time.Millisecond, max(0, time.Until(deadline))))
			continue
		}
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return errors.New("ready gate release is not a regular file")
		}
		release, err := os.Open(gate.ReleasePath)
		if err != nil {
			return err
		}
		opened, statErr := release.Stat()
		if statErr != nil || !opened.Mode().IsRegular() {
			return errors.Join(errors.New("ready gate release changed type"), statErr, release.Close())
		}
		content, readErr := io.ReadAll(io.LimitReader(release, 257))
		if err := errors.Join(readErr, release.Close()); err != nil {
			return err
		}
		if string(content) != gate.Token {
			return errors.New("ready gate release token mismatch")
		}
		if !time.Now().Before(deadline) {
			return errors.New("ready gate deadline expired before release")
		}
		detail["releaseObservedAt"] = time.Now().UnixMilli()
		return nil
	}
	return errors.New("ready gate deadline expired; no download input submitted")
}

func remainingActionTimeout(deadline time.Time) (time.Duration, error) {
	milliseconds := time.Until(deadline).Milliseconds()
	if milliseconds < 1 {
		return 0, errors.New("original download wait deadline expired; no further input submitted")
	}
	return time.Duration(min(int64(5000), milliseconds)) * time.Millisecond, nil
}

func parseInput(raw []byte) (input, error) {
	var c input
	var fields map[string]json.RawMessage
	if len(raw) > fileLimit || json.Unmarshal(raw, &fields) != nil || len(fields) != 9 {
		return c, errors.New("invalid helper input fields or size")
	}
	for _, key := range []string{"socketPath", "sessionId", "turnId", "controlEpoch", "tabId", "variant", "key", "kind", "readyGate"} {
		if value, ok := fields[key]; !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return c, fmt.Errorf("missing input %s", key)
		}
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return c, err
	}
	var gateFields map[string]json.RawMessage
	if json.Unmarshal(fields["readyGate"], &gateFields) != nil || len(gateFields) != 3 || gateFields["readyPath"] == nil || gateFields["releasePath"] == nil || gateFields["token"] == nil {
		return c, errors.New("invalid readyGate fields")
	}
	if err := validateGate(c.ReadyGate); err != nil {
		return c, err
	}
	for _, value := range []string{c.SocketPath, c.SessionID, c.TurnID, c.Key} {
		if value == "" || len(value) > 4096 {
			return c, errors.New("invalid helper identity")
		}
	}
	if c.ControlEpoch < 1 || c.ControlEpoch > 9007199254740991 || c.TabID < 0 || int64(c.TabID) > 9007199254740991 ||
		(c.Variant != "root" && c.Variant != "oopif" && c.Variant != "dynamic-oopif") || (c.Kind != "post" && c.Kind != "blob") {
		return c, errors.New("invalid helper scope or variant")
	}
	return c, nil
}

func checkScope(value any, c input) error {
	state, ok := value.(map[string]any)
	if !ok || state["lifecycleVersion"] != float64(1) || state["controlEpoch"] != float64(c.ControlEpoch) || state["closing"] != false {
		return errors.New("control epoch changed or original scope is invalid/closing")
	}
	if turn, ok := state["nextTurnId"].(string); !ok || turn == "" {
		return errors.New("missing nextTurnId")
	}
	return nil
}

func readState(locator *obu.Locator) (map[string]any, error) {
	text, err := locator.TextContent(obu.BrowserActionOptions{Timeout: 5 * time.Second})
	if err != nil {
		return nil, err
	}
	if text == nil {
		return nil, errors.New("missing original Page state")
	}
	var state map[string]any
	if err := json.Unmarshal([]byte(*text), &state); err != nil || state == nil {
		return nil, errors.New("invalid original Page state")
	}
	return state, nil
}

func checkInitialPage(page map[string]any, c input) error {
	clicks, clickOK := page["clicks"].([]any)
	adds, addOK := page["frameAdds"].([]any)
	if page["key"] != c.Key || page["kind"] != c.Kind || !clickOK || len(clicks) != 0 || !addOK || len(adds) != 0 {
		return errors.New("wrong original Page or fixture already used")
	}
	return nil
}

func readOriginalFile(path string) (result map[string]any, err error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("SDK path must be absolute")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, file.Close()) }()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > fileLimit {
		return nil, errors.New("original file must be ordinary and bounded")
	}
	content, err := io.ReadAll(io.LimitReader(file, fileLimit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(content)) != info.Size() || len(content) > fileLimit {
		return nil, errors.New("original file size changed or exceeds limit")
	}
	end := bytes.IndexByte(content, '\n')
	if end < 1 || !utf8.Valid(content[:end]) {
		return nil, errors.New("original file lacks its valid JSON header")
	}
	var analysis map[string]string
	if err := json.Unmarshal(content[:end], &analysis); err != nil || len(analysis) != 4 {
		return nil, errors.New("invalid original file JSON header")
	}
	for _, key := range []string{"key", "kind", "owner", "nonce"} {
		if analysis[key] == "" {
			return nil, fmt.Errorf("invalid file %s", key)
		}
	}
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`).MatchString(analysis["nonce"]) {
		return nil, errors.New("invalid original file nonce")
	}
	digest := sha256.Sum256(content)
	return map[string]any{"bytes": len(content), "sha256": hex.EncodeToString(digest[:]), "base64": base64.StdEncoding.EncodeToString(content), "analysis": analysis}, nil
}

func checkEvidence(detail map[string]any, c input) error {
	page := detail["page"].(map[string]any)
	file := detail["file"].(map[string]any)
	analysis := file["analysis"].(map[string]string)
	owner, ownerOK := page["owner"].(string)
	clicks, clickOK := page["clicks"].([]any)
	if page["key"] != c.Key || page["kind"] != c.Kind || !ownerOK || owner == "" || !clickOK || len(clicks) != 1 {
		return errors.New("wrong original Page or not exactly one download click")
	}
	click, ok := clicks[0].(map[string]any)
	if !ok || click["trusted"] != true || click["buttonCount"] != float64(1) {
		return errors.New("download click was not the sole trusted click")
	}
	token, ok := page["documentToken"].(string)
	if !ok || token == "" || click["documentToken"] != token {
		return errors.New("original document identity changed")
	}
	if c.Kind == "blob" {
		blob, ok := click["blobURL"].(string)
		if !ok || len(blob) < 5 || blob[:5] != "blob:" || click["revoked"] != true || page["blobURL"] != blob {
			return errors.New("missing revoked original Blob witness")
		}
	}
	if analysis["key"] != c.Key || analysis["kind"] != c.Kind || analysis["owner"] != owner || page["expectedSHA"] != file["sha256"] {
		return errors.New("original file owner, case or digest mismatch")
	}
	if c.Variant == "dynamic-oopif" {
		root := detail["rootPage"].(map[string]any)
		clicks, ok := root["clicks"].([]any)
		if root["key"] != c.Key || root["kind"] != c.Kind || !ok || len(clicks) != 0 || !reflect.DeepEqual(root["frameAdds"], []any{map[string]any{"trusted": true}}) {
			return errors.New("dynamic frame was not added exactly once after readiness")
		}
	}
	return nil
}

func run(raw []byte) (detail map[string]any) {
	detail = map[string]any{"caller": "go", "ok": false, "stages": []map[string]any{}, "waitCleanup": map[string]any{"attempted": false, "ok": false}}
	stage := func(name string, action func() error) error {
		record := map[string]any{"name": name, "startedAt": time.Now().UnixMilli(), "ok": false}
		detail["stages"] = append(detail["stages"].([]map[string]any), record)
		err := action()
		record["finishedAt"] = time.Now().UnixMilli()
		record["ok"] = err == nil
		if err != nil {
			failure := map[string]any{"stage": name, "type": fmt.Sprintf("%T", err), "message": err.Error()}
			record["error"] = failure
			if detail["error"] == nil {
				detail["error"] = failure
			}
		}
		return err
	}
	var browser *obu.Browser
	var wait *obu.DownloadWait
	defer func() {
		if problem := recover(); problem != nil && detail["error"] == nil {
			detail["error"] = map[string]any{"stage": "internal", "type": "panic", "message": fmt.Sprint(problem)}
		}
		cleanup := detail["waitCleanup"].(map[string]any)
		if wait != nil {
			cleanup["attempted"] = true
			if err := stage("waitCleanup", wait.Cancel); err != nil {
				stages := detail["stages"].([]map[string]any)
				cleanup["error"] = stages[len(stages)-1]["error"]
			} else {
				cleanup["ok"] = true
			}
		}
		if browser != nil {
			_ = stage("close", browser.Close)
		}
		detail["ok"] = detail["error"] == nil && cleanup["ok"] == true
	}()
	var c input
	if stage("input", func() (err error) { c, err = parseInput(raw); return err }) != nil {
		return detail
	}
	scope := obu.Params{"session_id": c.SessionID, "turn_id": c.TurnID, "control_epoch": c.ControlEpoch}
	detail["scope"], detail["tabId"], detail["variant"], detail["kind"], detail["key"] = scope, c.TabID, c.Variant, c.Kind, c.Key
	browser = obu.NewBrowser(obu.NewClient(obu.Options{SocketPath: c.SocketPath, SessionID: c.SessionID, TurnID: c.TurnID, Timeout: 15 * time.Second}))
	if stage("connect", browser.Connect) != nil {
		return detail
	}
	tab := browser.Tab(c.TabID)
	readScope := func(name string) error {
		return stage(name, func() error {
			state, err := browser.Client.Request("getControlState", scope)
			detail[name] = state
			if err != nil {
				return err
			}
			return checkScope(state, c)
		})
	}
	if readScope("scopeBefore") != nil {
		return detail
	}
	if stage("rootBefore", func() error {
		page, err := readState(tab.Locator("#state"))
		detail["rootBefore"] = page
		if err != nil {
			return err
		}
		return checkInitialPage(page, c)
	}) != nil || readScope("scopeAfter") != nil {
		return detail
	}
	gateDeadline := time.Now().Add(15 * time.Second)
	if stage("ready", func() (err error) {
		wait, err = tab.ExpectDownload(obu.DownloadWaitOptions{Timeout: 15 * time.Second, RequirePath: true})
		return err
	}) != nil {
		return detail
	}
	detail["waiterId"], detail["remainingMs"], detail["readyAt"] = wait.WaiterID, wait.RemainingMS, time.Now().UnixMilli()
	if acknowledgedDeadline := time.Now().Add(time.Duration(wait.RemainingMS * float64(time.Millisecond))); acknowledgedDeadline.Before(gateDeadline) {
		gateDeadline = acknowledgedDeadline
	}
	if stage("gate", func() error { return awaitReadyGate(c.ReadyGate, detail, gateDeadline) }) != nil {
		return detail
	}
	if c.Variant == "dynamic-oopif" && stage("addFrame", func() error {
		timeout, err := remainingActionTimeout(gateDeadline)
		if err != nil {
			return err
		}
		if err := tab.GetByRole("button", obu.RoleOptions{Name: "Add download frame", Exact: true}).Click(obu.BrowserActionOptions{Timeout: timeout}); err != nil {
			return err
		}
		_, err = remainingActionTimeout(gateDeadline)
		return err
	}) != nil {
		return detail
	}
	button := tab.GetByRole("button", obu.RoleOptions{Name: "Download original report", Exact: true})
	state := tab.Locator("#state")
	if c.Variant != "root" {
		frame := tab.FrameLocator("#download-frame")
		button = frame.GetByRole("button", obu.RoleOptions{Name: "Download original report", Exact: true})
		state = frame.Locator("#state")
	}
	if stage("trigger", func() error {
		timeout, err := remainingActionTimeout(gateDeadline)
		if err != nil {
			return err
		}
		detail["triggerAt"] = time.Now().UnixMilli()
		if err := button.Click(obu.BrowserActionOptions{Timeout: timeout}); err != nil {
			return err
		}
		_, err = remainingActionTimeout(gateDeadline)
		return err
	}) != nil {
		return detail
	}
	var download *obu.Download
	if stage("collect", func() (err error) { download, err = wait.Result(); return err }) != nil {
		return detail
	}
	detail["downloadId"], detail["collectedAt"] = download.DownloadID, time.Now().UnixMilli()
	var path string
	if stage("path", func() (err error) {
		path, err = download.Path(obu.DownloadOptions{Timeout: 10 * time.Second})
		detail["productPath"] = path
		return err
	}) != nil {
		return detail
	}
	if stage("file", func() error { file, err := readOriginalFile(path); detail["file"] = file; return err }) != nil {
		return detail
	}
	if stage("page", func() error { page, err := readState(state); detail["page"] = page; return err }) != nil {
		return detail
	}
	if c.Variant == "dynamic-oopif" && stage("rootPage", func() error { page, err := readState(tab.Locator("#state")); detail["rootPage"] = page; return err }) != nil {
		return detail
	}
	_ = stage("verify", func() error { return checkEvidence(detail, c) })
	return detail
}

func main() {
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, fileLimit+1))
	var detail map[string]any
	if err != nil {
		detail = map[string]any{"caller": "go", "ok": false, "stages": []any{}, "waitCleanup": map[string]any{"attempted": false, "ok": false}, "error": map[string]any{"stage": "input", "type": fmt.Sprintf("%T", err), "message": err.Error()}}
	} else {
		detail = run(raw)
	}
	if err := json.NewEncoder(os.Stdout).Encode(detail); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if detail["ok"] != true {
		fmt.Fprintln(os.Stderr, detail["error"])
		os.Exit(1)
	}
}
