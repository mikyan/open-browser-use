package managedviewer

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"

	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
)

const maxSafeInteger = uint64(1<<53 - 1)
const maxFrameEncoding = 4 * ((4<<20 + 2) / 3)

type command struct {
	id         uint64
	operation  string
	payload    json.RawMessage
	ctx        context.Context
	epoch      uint64
	generation uint64
	// Set only by the original cleanup lane, never by public JSON.
	releaseDone func()
	// Captured from the accepted original human state at input admission,
	// never parsed from a caller command or changed by subsequent status.
	inputBudgetVersion uint64
}

// object rejects duplicate keys as well as trailing JSON. Silent last-key wins
// would make the authorization check and command consumer disagree.
func object(data []byte) (map[string]json.RawMessage, error) {
	return managedprotocol.Object(data)
}

func parseCommand(data []byte) (command, error) {
	if len(data) > managedprotocol.MaxCommandBytes {
		return command{}, errors.New("command too large")
	}
	f, err := object(data)
	if err != nil {
		return command{}, err
	}
	var c command
	if json.Unmarshal(f["id"], &c.id) != nil || c.id == 0 || c.id > maxSafeInteger || json.Unmarshal(f["operation"], &c.operation) != nil {
		return c, errors.New("invalid command identity")
	}
	allowed := map[string]bool{"id": true, "operation": true}
	switch c.operation {
	case "status", "pause", "stop":
	case "select":
		allowed["tabId"] = true
		allowed["deliveryId"] = true
		allowed["pageSelectionId"] = true
		selection := map[string]json.RawMessage{"operation": f["operation"], "tabId": f["tabId"]}
		if raw, ok := f["deliveryId"]; ok {
			selection["deliveryId"] = raw
		}
		if raw, ok := f["pageSelectionId"]; ok {
			selection["pageSelectionId"] = raw
		}
		if err := managedprotocol.ValidateSelection(selection); err != nil {
			return c, err
		}
	case "resume":
		allowed["expectedRevision"], allowed["expectedWorkerBootId"] = true, true
		var revision uint64
		var worker string
		if bytes.Equal(f["expectedRevision"], []byte("null")) || json.Unmarshal(f["expectedRevision"], &revision) != nil || revision > maxSafeInteger || json.Unmarshal(f["expectedWorkerBootId"], &worker) != nil || worker == "" || len(worker) > 256 {
			return c, errors.New("invalid resume identity")
		}
	case "humanBegin", "humanInput", "humanEnd", "humanDialogRespond", "humanFileBegin", "humanFileChunk", "humanFileCommit", "humanFileCancel":
		human := make(map[string]json.RawMessage, len(f)-1)
		for key, value := range f {
			if key != "id" {
				human[key] = value
			}
		}
		if err := managedprotocol.ValidateHuman(c.operation, human); err != nil {
			return c, err
		}
		for _, key := range managedprotocol.HumanFields(c.operation) {
			allowed[key] = true
		}
		if c.operation == "humanBegin" {
			allowed["deliveryId"] = true
			allowed["pageSelectionId"] = true
		}
		if c.operation == "humanFileCancel" {
			allowed["transferId"] = true
		}
		if c.operation == "humanDialogRespond" {
			allowed["promptText"] = true
		}
	default:
		return c, errors.New("unsupported operation")
	}
	for key := range f {
		if !allowed[key] {
			return c, errors.New("unexpected command field")
		}
	}
	delete(f, "id")
	c.payload, err = json.Marshal(f)
	return c, err
}

func jsonBytes(value any) json.RawMessage {
	data, _ := json.Marshal(value)
	return data
}

// Project trusted backend data onto the viewer's small display schema. Private
// channel identities, process paths and future backend fields never go to HTML.
func publicState(data []byte) (json.RawMessage, error) {
	if len(data) > 1<<20 {
		return nil, errors.New("backend status too large")
	}
	envelope, err := object(data)
	if err != nil {
		return nil, err
	}
	// The managed worker has one canonical nested status schema. The HTTP
	// adapter alone maps it to the public UI; normalized/task shapes are rejected.
	f, err := object(envelope["status"])
	if err != nil {
		return nil, err
	}
	var connected bool
	if json.Unmarshal(f["connected"], &connected) != nil || !connected {
		return nil, errors.New("backend control channel disconnected")
	}
	var status struct {
		State           string `json:"state"`
		InputBlocked    *bool  `json:"inputBlocked"`
		Revision        uint64 `json:"revision"`
		CleanupComplete *bool  `json:"cleanupComplete"`
	}
	statusFields, statusErr := object(f["automation"])
	if statusErr != nil || statusFields["revision"] == nil || bytes.Equal(statusFields["revision"], []byte("null")) || json.Unmarshal(f["automation"], &status) != nil || status.InputBlocked == nil || status.CleanupComplete == nil || status.Revision > maxSafeInteger {
		return nil, errors.New("invalid backend status")
	}
	switch status.State {
	case "running", "pausing", "paused", "error":
	default:
		return nil, errors.New("invalid backend state")
	}
	if *status.InputBlocked != (status.State != "running") {
		return nil, errors.New("inconsistent backend state")
	}
	var worker string
	if json.Unmarshal(f["workerBootId"], &worker) != nil || worker == "" || len(worker) > 256 {
		return nil, errors.New("missing worker identity")
	}
	var cleanupPending uint64
	if bytes.Equal(f["cleanupPending"], []byte("null")) || json.Unmarshal(f["cleanupPending"], &cleanupPending) != nil || cleanupPending > maxSafeInteger {
		return nil, errors.New("missing viewer cleanup state")
	}
	viewerClean := cleanupPending == 0 && f["cleanupError"] == nil
	var eventSequence uint64
	if bytes.Equal(f["eventSequence"], []byte("null")) || json.Unmarshal(f["eventSequence"], &eventSequence) != nil || eventSequence > maxSafeInteger {
		return nil, errors.New("missing status event sequence")
	}
	tabs, err := managedprotocol.ParseViewerTabs(f["tabs"], status.State == "running")
	if err != nil {
		return nil, err
	}
	pageVersion, err := managedprotocol.ParsePageSelectionVersion(f["pageSelectionVersion"])
	if err != nil {
		return nil, err
	}
	seenTabs := map[uint64]bool{}
	for _, t := range tabs {
		if t.Kind == "browser" && pageVersion != 1 {
			return nil, errors.New("browser pages lack their channel capability")
		}
		seenTabs[t.ID] = true
	}
	var selected *uint64
	if json.Unmarshal(f["selectedTabId"], &selected) != nil || selected != nil && (*selected == 0 || *selected > maxSafeInteger || !seenTabs[*selected]) {
		return nil, errors.New("invalid selection")
	}
	human, err := managedprotocol.ParseHumanState(f["human"])
	if err != nil {
		return nil, err
	}
	dialog, err := managedprotocol.ParsePendingDialog(f["pendingDialog"], human)
	if err != nil {
		return nil, err
	}
	chooser, err := managedprotocol.ParsePendingFileChooser(f["pendingFileChooser"], human)
	if err != nil {
		return nil, err
	}
	if human != nil && (status.State == "running" || !*status.InputBlocked) {
		return nil, errors.New("human control did not pause automation")
	}
	view, err := managedprotocol.ParseViewState(f["view"])
	if err != nil || human != nil && view != nil {
		return nil, errors.New("invalid independent viewing state")
	}
	if view != nil {
		if selected == nil || *selected != view.TabID {
			return nil, errors.New("view belongs to a different selected tab")
		}
		found := false
		for _, tab := range tabs {
			if tab.ID == view.TabID && tab.Kind == "result" {
				found = true
			}
		}
		if !found {
			return nil, errors.New("view has no original result page")
		}
	}
	cleanup, err := managedprotocol.ParseHumanCleanup(f["humanCleanup"])
	if err != nil {
		return nil, err
	}
	input, err := managedprotocol.ParseInputReceipt(envelope["inputReceipt"])
	if err != nil {
		return nil, err
	}
	dialogReceipt, err := managedprotocol.ParseDialogReceipt(envelope["dialogReceipt"])
	if err != nil {
		return nil, err
	}
	out := map[string]any{"status": status, "workerBootId": worker, "tabs": tabs, "selectedTabId": selected, "viewerCleanupComplete": viewerClean, "eventSequence": eventSequence, "human": human, "view": view}
	if pageVersion != 0 {
		out["pageSelectionVersion"] = pageVersion
	}
	selection, err := managedprotocol.ParsePageSelectionReceipt(envelope["pageSelectionReceipt"])
	if err != nil {
		return nil, err
	}
	if selection != nil {
		out["pageSelectionReceipt"] = selection
	}
	out["pendingDialog"] = dialog
	if f["pendingFileChooser"] != nil || human != nil && human.FileChooserVersion == 1 {
		out["pendingFileChooser"] = chooser
	}
	for _, key := range []string{"fileTransfer", "fileChunk", "fileChooserReceipt", "fileChooserCancellation"} {
		if raw := envelope[key]; raw != nil {
			value, err := managedprotocol.ParseFileResult(key, raw)
			if err != nil {
				return nil, err
			}
			out[key] = value
		}
	}
	if cleanup != nil {
		out["humanCleanup"] = cleanup
	}
	if input != nil {
		out["inputReceipt"] = input
	}
	if dialogReceipt != nil {
		out["dialogReceipt"] = dialogReceipt
	}
	return jsonBytes(out), nil
}

func publicEvent(data []byte) (string, json.RawMessage, error) {
	if len(data) > 8<<20 {
		return "", nil, errors.New("event too large")
	}
	f, err := object(data)
	if err != nil {
		return "", nil, err
	}
	var kind string
	_ = json.Unmarshal(f["type"], &kind)
	var eventSequence uint64
	if json.Unmarshal(f["sequence"], &eventSequence) != nil || eventSequence == 0 || eventSequence > maxSafeInteger {
		return "", nil, errors.New("invalid event sequence")
	}
	if kind == "status" {
		state, err := publicState(data)
		if err != nil {
			return "", nil, err
		}
		var out map[string]json.RawMessage
		_ = json.Unmarshal(state, &out)
		if string(out["eventSequence"]) != string(jsonBytes(eventSequence)) {
			return "", nil, errors.New("status event snapshot sequence mismatch")
		}
		out["type"] = jsonBytes("state")
		return "state", jsonBytes(out), nil
	}
	if kind == "clear" || kind == "error" {
		return "state", jsonBytes(map[string]any{"type": "clear", "message": "画面订阅已结束，可重新选择查看。", "eventSequence": eventSequence}), nil
	}
	if kind == "closed" {
		return "state", jsonBytes(map[string]any{"type": "unavailable", "message": "浏览器控制连接已断开；仍可停止会话。", "eventSequence": eventSequence}), nil
	}
	if kind != "frame" {
		return "", nil, errors.New("unsupported backend event")
	}
	var mime, image, stream string
	var tabID, sequence uint64
	if json.Unmarshal(f["mimeType"], &mime) != nil || mime != "image/png" || json.Unmarshal(f["data"], &image) != nil || len(image) == 0 || len(image) > maxFrameEncoding || json.Unmarshal(f["streamId"], &stream) != nil || stream == "" || len(stream) > 256 || json.Unmarshal(f["tabId"], &tabID) != nil || tabID == 0 || tabID > maxSafeInteger || json.Unmarshal(f["frameSequence"], &sequence) != nil || sequence == 0 || sequence > maxSafeInteger {
		return "", nil, errors.New("invalid backend frame")
	}
	if decoded, err := base64.StdEncoding.Strict().DecodeString(image); err != nil || len(decoded) > 4<<20 {
		return "", nil, errors.New("invalid frame encoding")
	}
	// Metadata is numeric CDP screencast geometry, never arbitrary HTML or URLs.
	metadata := map[string]float64{}
	if f["metadata"] != nil {
		source, err := object(f["metadata"])
		if err != nil {
			return "", nil, errors.New("invalid frame metadata")
		}
		for _, key := range []string{"timestamp", "monotonicTimestamp", "pageScaleFactor", "offsetTop", "deviceWidth", "deviceHeight", "scrollOffsetX", "scrollOffsetY"} {
			if raw, ok := source[key]; ok {
				var number float64
				if json.Unmarshal(raw, &number) != nil {
					return "", nil, errors.New("invalid frame geometry")
				}
				metadata[key] = number
			}
		}
	}
	out := map[string]any{"type": kind, "mimeType": mime, "data": image, "streamId": stream, "tabId": tabID, "sequence": sequence, "eventSequence": eventSequence, "metadata": metadata}
	mode, lease, generation, err := managedprotocol.ParseFrameIdentity(f)
	if err != nil {
		return "", nil, err
	}
	if mode == "human" {
		out["controlMode"], out["humanLeaseId"], out["generation"] = mode, lease, generation
	} else if mode == "user-view" {
		out["controlMode"], out["viewLeaseId"], out["generation"] = mode, lease, generation
	}
	return kind, jsonBytes(out), nil
}
