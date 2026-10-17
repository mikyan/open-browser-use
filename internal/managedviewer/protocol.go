package managedviewer

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
)

const maxSafeInteger = uint64(1<<53 - 1)
const maxFrameEncoding = 4 * ((4<<20 + 2) / 3)

type command struct {
	id        uint64
	operation string
	payload   json.RawMessage
}

// object rejects duplicate keys as well as trailing JSON. Silent last-key wins
// would make the authorization check and command consumer disagree.
func object(data []byte) (map[string]json.RawMessage, error) {
	d := json.NewDecoder(bytes.NewReader(data))
	first, err := d.Token()
	if err != nil || first != json.Delim('{') {
		return nil, errors.New("expected object")
	}
	fields := map[string]json.RawMessage{}
	for d.More() {
		key, err := d.Token()
		if err != nil {
			return nil, err
		}
		name, ok := key.(string)
		if !ok || fields[name] != nil {
			return nil, errors.New("duplicate field")
		}
		var value json.RawMessage
		if err := d.Decode(&value); err != nil {
			return nil, err
		}
		fields[name] = value
	}
	if _, err := d.Token(); err != nil {
		return nil, err
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, errors.New("trailing JSON")
	}
	return fields, nil
}

func parseCommand(data []byte) (command, error) {
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
		if !bytes.Equal(f["tabId"], []byte("null")) {
			var id uint64
			if json.Unmarshal(f["tabId"], &id) != nil || id == 0 || id > maxSafeInteger {
				return c, errors.New("invalid tab")
			}
		}
	case "resume":
		allowed["expectedRevision"], allowed["expectedWorkerBootId"] = true, true
		var revision uint64
		var worker string
		if json.Unmarshal(f["expectedRevision"], &revision) != nil || revision > maxSafeInteger || json.Unmarshal(f["expectedWorkerBootId"], &worker) != nil || worker == "" || len(worker) > 256 {
			return c, errors.New("invalid resume identity")
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
	if statusErr != nil || statusFields["revision"] == nil || json.Unmarshal(f["automation"], &status) != nil || status.InputBlocked == nil || status.CleanupComplete == nil || status.Revision > maxSafeInteger {
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
	if json.Unmarshal(f["cleanupPending"], &cleanupPending) != nil || cleanupPending > maxSafeInteger {
		return nil, errors.New("missing viewer cleanup state")
	}
	viewerClean := cleanupPending == 0 && f["cleanupError"] == nil
	var eventSequence uint64
	if json.Unmarshal(f["eventSequence"], &eventSequence) != nil || eventSequence > maxSafeInteger {
		return nil, errors.New("missing status event sequence")
	}
	type tab struct {
		ID    uint64 `json:"id"`
		Title string `json:"title"`
		URL   string `json:"url"`
	}
	tabs := []tab{}
	if json.Unmarshal(f["tabs"], &tabs) != nil || len(tabs) > 4096 {
		return nil, errors.New("invalid tab list")
	}
	seenTabs := map[uint64]bool{}
	for _, t := range tabs {
		if t.ID == 0 || t.ID > maxSafeInteger || seenTabs[t.ID] || len(t.Title) > 4096 || len(t.URL) > 16384 {
			return nil, errors.New("invalid tab")
		}
		seenTabs[t.ID] = true
	}
	var selected *uint64
	if json.Unmarshal(f["selectedTabId"], &selected) != nil || selected != nil && (*selected == 0 || *selected > maxSafeInteger || !seenTabs[*selected]) {
		return nil, errors.New("invalid selection")
	}
	return jsonBytes(map[string]any{"status": status, "workerBootId": worker, "tabs": tabs, "selectedTabId": selected, "viewerCleanupComplete": viewerClean, "eventSequence": eventSequence}), nil
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
		var source map[string]json.RawMessage
		if json.Unmarshal(f["metadata"], &source) != nil {
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
	return kind, jsonBytes(map[string]any{"type": kind, "mimeType": mime, "data": image, "streamId": stream, "tabId": tabID, "sequence": sequence, "eventSequence": eventSequence, "metadata": metadata}), nil
}
