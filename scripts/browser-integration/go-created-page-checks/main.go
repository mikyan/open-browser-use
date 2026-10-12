// One native created page through the public typed Go SDK; no replay.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"time"

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
	Owner        string    `json:"owner"`
	ReadyGate    readyGate `json:"readyGate"`
	PreparedGate readyGate `json:"preparedGate"`
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

func publishGateRecord(path string, encoded []byte, deadline time.Time) (err error) {
	file, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".pending-*")
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, os.Remove(file.Name())) }()
	_, writeErr := file.Write(append(encoded, '\n'))
	if err := errors.Join(writeErr, file.Close()); err != nil {
		return err
	}
	if !time.Now().Before(deadline) {
		return errors.New("gate deadline expired before publication")
	}
	// Publish a fully closed same-directory file without replacing any target.
	return os.Link(file.Name(), path)
}

func awaitReadyGate(gate readyGate, detail map[string]any, deadline time.Time, prepared bool) error {
	label := "ready"
	if prepared {
		label = "prepared"
	}
	if !time.Now().Before(deadline) {
		return fmt.Errorf("%s gate deadline expired before publication", label)
	}
	record := map[string]any{"token": gate.Token}
	keys := []string{"waiterId", "remainingMs", "readyAt", "scope", "tabId"}
	if prepared {
		detail["preparedAt"] = time.Now().UnixMilli()
		detail["preparedRemainingMs"] = float64(time.Until(deadline)) / float64(time.Millisecond)
		record["remainingMs"] = detail["preparedRemainingMs"]
		keys = []string{"waiterId", "scope", "tabId", "key", "owner", "variant", "sourceBefore", "preparedAt"}
	}
	for _, key := range keys {
		record[key] = detail[key]
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if err := publishGateRecord(gate.ReadyPath, encoded, deadline); err != nil {
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
			return fmt.Errorf("%s gate release is not a regular file", label)
		}
		release, err := os.Open(gate.ReleasePath)
		if err != nil {
			return err
		}
		opened, statErr := release.Stat()
		if statErr != nil || !opened.Mode().IsRegular() {
			return errors.Join(fmt.Errorf("%s gate release changed type", label), statErr, release.Close())
		}
		content, readErr := io.ReadAll(io.LimitReader(release, 257))
		if err := errors.Join(readErr, release.Close()); err != nil {
			return err
		}
		if string(content) != gate.Token {
			return fmt.Errorf("%s gate release token mismatch", label)
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("%s gate deadline expired before release", label)
		}
		field := "releaseObservedAt"
		if prepared {
			field = "preparedReleaseObservedAt"
		}
		detail[field] = time.Now().UnixMilli()
		return nil
	}
	return fmt.Errorf("%s gate deadline expired; no created-page input submitted", label)
}

func remainingActionTimeout(deadline time.Time) (time.Duration, error) {
	milliseconds := time.Until(deadline).Milliseconds() - 1000
	if milliseconds < 1 {
		return 0, errors.New("created page deadline expired; no further input submitted")
	}
	return time.Duration(min(int64(5000), milliseconds)) * time.Millisecond, nil
}

func parseInput(raw []byte) (input, error) {
	var c input
	var fields map[string]json.RawMessage
	if len(raw) > fileLimit || json.Unmarshal(raw, &fields) != nil || len(fields) != 10 {
		return c, errors.New("invalid helper input fields or size")
	}
	for _, key := range []string{"socketPath", "sessionId", "turnId", "controlEpoch", "tabId", "variant", "key", "owner", "readyGate", "preparedGate"} {
		if value, ok := fields[key]; !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return c, fmt.Errorf("missing input %s", key)
		}
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return c, err
	}
	paths := map[string]bool{}
	for name, gate := range map[string]readyGate{"readyGate": c.ReadyGate, "preparedGate": c.PreparedGate} {
		var gateFields map[string]json.RawMessage
		if json.Unmarshal(fields[name], &gateFields) != nil || len(gateFields) != 3 || gateFields["readyPath"] == nil || gateFields["releasePath"] == nil || gateFields["token"] == nil {
			return c, fmt.Errorf("invalid %s fields", name)
		}
		if err := validateGate(gate); err != nil {
			return c, err
		}
		for _, path := range []string{gate.ReadyPath, gate.ReleasePath} {
			parent, err := filepath.EvalSymlinks(filepath.Dir(path))
			if err != nil {
				return c, err
			}
			canonical := filepath.Join(parent, filepath.Base(path))
			if runtime.GOOS == "windows" {
				canonical = strings.ToLower(canonical)
			}
			if paths[canonical] {
				return c, errors.New("both gates must use four distinct file paths")
			}
			paths[canonical] = true
		}
	}
	for _, value := range []string{c.SocketPath, c.SessionID, c.TurnID, c.Key, c.Owner} {
		if value == "" || len(value) > 4096 {
			return c, errors.New("invalid helper identity")
		}
	}
	if c.ControlEpoch < 1 || c.ControlEpoch > 9007199254740991 || c.TabID < 0 || int64(c.TabID) > 9007199254740991 ||
		(c.Variant != "root" && c.Variant != "oopif" && c.Variant != "dynamic-oopif") {
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

func checkSource(page map[string]any, c input, clicked bool) error {
	for key, value := range map[string]any{"key": c.Key, "owner": c.Owner, "variant": c.Variant} {
		if page[key] != value {
			return errors.New("wrong original source document")
		}
	}
	for _, key := range []string{"sourceNonce", "documentToken"} {
		if !validUUID(page[key]) {
			return errors.New("invalid original source identity")
		}
	}
	clicks, ok := page["clicks"].([]any)
	expected := 0
	if clicked {
		expected = 1
	}
	if !ok || len(clicks) != expected {
		return errors.New("original link must be clicked exactly once")
	}
	if clicked {
		click, ok := clicks[0].(map[string]any)
		if !ok || click["trusted"] != true || click["ctrlKey"] != true || click["metaKey"] != false || click["altKey"] != false || click["shiftKey"] != false || click["button"] != float64(0) || click["sequence"] != float64(1) || click["sourceNonce"] != page["sourceNonce"] || click["documentToken"] != page["documentToken"] {
			return errors.New("missing sole trusted Control click")
		}
	}
	return nil
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func validUUID(value any) bool { s, ok := value.(string); return ok && uuidPattern.MatchString(s) }
func checkChild(page, before map[string]any) error {
	for _, key := range []string{"documentNonce", "documentToken"} {
		if !validUUID(page[key]) {
			return errors.New("invalid original child identity")
		}
		if before != nil && page[key] != before[key] {
			return errors.New("child identity changed")
		}
	}
	want := []any{}
	if before != nil {
		want = []any{map[string]any{"trusted": true, "sequence": float64(1), "documentNonce": page["documentNonce"], "documentToken": page["documentToken"]}}
	}
	if !reflect.DeepEqual(page["clicks"], want) {
		return errors.New("child POST requires one trusted click")
	}
	return nil
}
func run(raw []byte) (detail map[string]any) {
	detail = map[string]any{"caller": "go", "ok": false, "stages": []map[string]any{}, "waitCleanup": map[string]any{"attempted": false, "ok": false}, "clientClose": map[string]any{"attempted": false, "ok": false}}
	var deadline time.Time
	budget := func() (time.Duration, error) {
		if deadline.IsZero() || !time.Now().Before(deadline) {
			return 0, errors.New("original created-page deadline expired")
		}
		return time.Until(deadline), nil
	}
	stage := func(name string, cleanup bool, action func() error) error {
		record := map[string]any{"name": name, "startedAt": time.Now().UnixMilli(), "ok": false}
		detail["stages"] = append(detail["stages"].([]map[string]any), record)
		var err error
		if !cleanup && !deadline.IsZero() {
			_, err = budget()
		}
		if err == nil {
			err = action()
		}
		if err == nil && !cleanup && !deadline.IsZero() {
			_, err = budget()
		}
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
	var wait *obu.PageWait
	defer func() {
		if problem := recover(); problem != nil && detail["error"] == nil {
			detail["error"] = map[string]any{"stage": "internal", "type": "panic", "message": fmt.Sprint(problem)}
		}
		cleanup := func(name string, record map[string]any, action func() error) {
			record["attempted"] = true
			if err := stage(name, true, action); err != nil {
				stages := detail["stages"].([]map[string]any)
				record["error"] = stages[len(stages)-1]["error"]
			} else {
				record["ok"] = true
				record["returnedAt"] = time.Now().UnixMilli()
			}
		}
		if wait != nil {
			cleanup("waitCleanup", detail["waitCleanup"].(map[string]any), wait.Cancel)
		}
		if browser != nil {
			cleanup("close", detail["clientClose"].(map[string]any), browser.Close)
		}
		detail["ok"] = detail["error"] == nil && detail["waitCleanup"].(map[string]any)["ok"] == true && detail["clientClose"].(map[string]any)["ok"] == true
	}()
	var c input
	if stage("input", false, func() (err error) { c, err = parseInput(raw); return err }) != nil {
		return
	}
	scope := obu.Params{"session_id": c.SessionID, "turn_id": c.TurnID, "control_epoch": c.ControlEpoch}
	detail["scope"], detail["tabId"], detail["variant"], detail["key"], detail["owner"] = scope, c.TabID, c.Variant, c.Key, c.Owner
	deadline = time.Now().Add(20 * time.Second)
	detail["firstRequestAt"] = time.Now().UnixMilli()
	browser = obu.NewBrowser(obu.NewClient(obu.Options{SocketPath: c.SocketPath, SessionID: c.SessionID, TurnID: c.TurnID, Timeout: time.Until(deadline)}))
	// The first public request connects and checks the supplied scope. Later work
	// uses this same typed client; the independent parent records actual wire scope.
	if stage("scopeBefore", false, func() error {
		value, err := browser.Client.Request("getControlState", scope)
		detail["scopeBefore"] = value
		if err != nil {
			return err
		}
		return checkScope(value, c)
	}) != nil {
		return
	}
	tab := browser.Tab(c.TabID)
	action := func(run func(obu.BrowserActionOptions) error) error {
		timeout, err := remainingActionTimeout(deadline)
		if err != nil {
			return err
		}
		if err = run(obu.BrowserActionOptions{Timeout: timeout}); err != nil {
			return err
		}
		_, err = budget()
		return err
	}
	readState := func(locator *obu.Locator) (map[string]any, error) {
		for {
			var text *string
			err := action(func(opts obu.BrowserActionOptions) (e error) { text, e = locator.TextContent(opts); return e })
			if err != nil {
				return nil, err
			}
			if text == nil || len(*text) > 65536 {
				return nil, errors.New("missing or oversized document state")
			}
			if *text == "" {
				remaining, err := budget()
				if err != nil {
					return nil, err
				}
				time.Sleep(min(25*time.Millisecond, remaining))
				continue
			}
			var state map[string]any
			if json.Unmarshal([]byte(*text), &state) != nil || state == nil {
				return nil, errors.New("invalid document state")
			}
			return state, nil
		}
	}
	read := func(name string, locator *obu.Locator, check func(map[string]any) error) error {
		return stage(name, false, func() error {
			value, err := readState(locator)
			detail[name] = value
			if err != nil {
				return err
			}
			return check(value)
		})
	}
	if read("rootBefore", tab.Locator("#state"), func(value map[string]any) error {
		if err := checkSource(value, c, false); err != nil {
			return err
		}
		if !reflect.DeepEqual(value["frameAdds"], []any{}) {
			return errors.New("dynamic fixture was already used")
		}
		return nil
	}) != nil {
		return
	}
	if stage("ready", false, func() (err error) {
		remaining, err := budget()
		if err != nil {
			return err
		}
		wait, err = tab.ExpectPage(obu.PageWaitOptions{Timeout: remaining.Truncate(time.Millisecond)})
		return err
	}) != nil {
		return
	}
	detail["waiterId"], detail["remainingMs"], detail["readyAt"] = wait.WaiterID, wait.RemainingMS, time.Now().UnixMilli()
	if ackDeadline := time.Now().Add(time.Duration(wait.RemainingMS * float64(time.Millisecond))); ackDeadline.Before(deadline) {
		deadline = ackDeadline
	}
	if stage("gate", false, func() error { return awaitReadyGate(c.ReadyGate, detail, deadline, false) }) != nil {
		return
	}
	if c.Variant == "dynamic-oopif" && stage("addFrame", false, func() error {
		return action(func(opts obu.BrowserActionOptions) error { return tab.Locator("#add-frame").Click(opts) })
	}) != nil {
		return
	}
	button, state := tab.Locator("#open-child"), tab.Locator("#state")
	if c.Variant != "root" {
		frame := tab.FrameLocator("#created-page-frame")
		button, state = frame.Locator("#open-child"), frame.Locator("#state")
	}
	if read("sourceBefore", state, func(v map[string]any) error { return checkSource(v, c, false) }) != nil {
		return
	}
	if stage("preparedGate", false, func() error { return awaitReadyGate(c.PreparedGate, detail, deadline, true) }) != nil {
		return
	}
	detail["triggerAt"] = time.Now().UnixMilli()
	if stage("trigger", false, func() error {
		return action(func(opts obu.BrowserActionOptions) error {
			opts.Args = obu.Params{"modifiers": []string{"Control"}}
			return button.Click(opts)
		})
	}) != nil {
		return
	}
	var child *obu.Tab
	if stage("collect", false, func() (err error) { child, err = wait.Result(); return err }) != nil {
		return
	}
	detail["childId"], detail["collectedAt"] = child.ID, time.Now().UnixMilli()
	if read("sourceAfter", state, func(v map[string]any) error {
		if err := checkSource(v, c, true); err != nil {
			return err
		}
		before := detail["sourceBefore"].(map[string]any)
		if v["sourceNonce"] != before["sourceNonce"] || v["documentToken"] != before["documentToken"] {
			return errors.New("source changed during trigger")
		}
		return nil
	}) != nil {
		return
	}
	if c.Variant == "dynamic-oopif" && read("rootAfter", tab.Locator("#state"), func(v map[string]any) error {
		if err := checkSource(v, c, false); err != nil {
			return err
		}
		if !reflect.DeepEqual(v["frameAdds"], []any{map[string]any{"trusted": true, "sequence": float64(1)}}) {
			return errors.New("dynamic frame was not added exactly once")
		}
		return nil
	}) != nil {
		return
	}
	if read("childBefore", child.Locator("#state"), func(v map[string]any) error { return checkChild(v, nil) }) != nil {
		return
	}
	for _, field := range []struct{ name, label, value string }{{"fillKey", "Source key", c.Key}, {"fillOwner", "Owner", c.Owner}} {
		if stage(field.name, false, func() error {
			return action(func(opts obu.BrowserActionOptions) error {
				return child.GetByLabel(field.label, obu.TextOptions{Exact: true}).Fill(field.value, opts)
			})
		}) != nil {
			return
		}
	}
	if stage("commit", false, func() error {
		return action(func(opts obu.BrowserActionOptions) error { return child.Locator("#commit").Click(opts) })
	}) != nil {
		return
	}
	if stage("receipt", false, func() error {
		for {
			var text *string
			if err := action(func(opts obu.BrowserActionOptions) (err error) {
				text, err = child.Locator("#result").TextContent(opts)
				return err
			}); err != nil {
				return err
			}
			if text != nil && *text != "" {
				var value map[string]any
				if len(*text) > 65536 || json.Unmarshal([]byte(*text), &value) != nil {
					return errors.New("invalid receipt")
				}
				detail["receipt"] = value
				want := map[string]any{"ok": true, "key": c.Key, "owner": c.Owner, "documentNonce": detail["childBefore"].(map[string]any)["documentNonce"]}
				if !reflect.DeepEqual(value, want) {
					return errors.New("wrong original child receipt")
				}
				return nil
			}
			remaining, err := budget()
			if err != nil {
				return err
			}
			time.Sleep(min(25*time.Millisecond, remaining))
		}
	}) != nil {
		return
	}
	_ = read("childAfter", child.Locator("#state"), func(v map[string]any) error { return checkChild(v, detail["childBefore"].(map[string]any)) })
	return
}
func main() {
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, fileLimit+1))
	var detail map[string]any
	if err != nil {
		detail = map[string]any{"caller": "go", "ok": false, "error": map[string]any{"stage": "input", "message": err.Error()}}
	} else {
		detail = run(raw)
	}
	if err = json.NewEncoder(os.Stdout).Encode(detail); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if detail["ok"] != true {
		fmt.Fprintln(os.Stderr, detail["error"])
		os.Exit(1)
	}
}
