package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

// A stage is recorded before the original SDK call. Cleanup may add evidence,
// but cannot replace the original failed stage or its error.
func recordStage(record map[string]any, name string, operation func() error) error {
	record["currentStage"] = name
	if _, failed := record["originalError"]; !failed {
		record["stage"] = name
	}
	started := time.Now().UnixMilli()
	record[name+"StartedAt"] = started
	entry := map[string]any{"stage": name, "startedAt": started}
	stages, _ := record["stages"].([]map[string]any)
	record["stages"] = append(stages, entry)
	if err := operation(); err != nil {
		failed := time.Now().UnixMilli()
		record[name+"FailedAt"], entry["failedAt"], entry["error"] = failed, failed, err.Error()
		if _, exists := record["originalError"]; !exists {
			record["originalError"], record["failedAt"], record["failedStage"] = err.Error(), failed, name
		}
		return err
	}
	completed := time.Now().UnixMilli()
	record[name+"CompletedAt"], entry["completedAt"] = completed, completed
	return nil
}

type variantProgress struct {
	item          map[string]any
	hook          func(string, map[string]any) error
	failureCalled bool
	started       bool
}

func (progress *variantProgress) notify(kind string) error {
	if progress.hook == nil {
		return nil
	}
	if kind == "start" {
		progress.started = true
	}
	if !progress.started {
		progress.item["diagnosticNotStarted"] = true
		return nil
	}
	name := "diagnostic" + map[string]string{"start": "Start", "failure": "Failure", "finish": "Finish"}[kind]
	progress.item[name+"StartedAt"] = time.Now().UnixMilli()
	if err := progress.hook(kind, progress.item); err != nil {
		progress.item[name+"Error"], progress.item[name+"FailedAt"] = err.Error(), time.Now().UnixMilli()
		return err
	}
	progress.item[name+"CompletedAt"] = time.Now().UnixMilli()
	return nil
}

const maximumACKLine = 1024 * 1024

type diagnosticLine struct {
	bytes []byte
	err   error
}

type diagnosticProtocol struct {
	output    io.Writer
	lines     chan diagnosticLine
	stop      chan struct{}
	closeOnce sync.Once
	nextID    int
	timeouts  map[string]time.Duration
}

func newDiagnosticProtocol(input io.Reader, output io.Writer) *diagnosticProtocol {
	protocol := &diagnosticProtocol{output: output, lines: make(chan diagnosticLine, 1), stop: make(chan struct{}),
		timeouts: map[string]time.Duration{"start": 6 * time.Second, "failure": 5 * time.Second, "finish": 4 * time.Second}}
	go func() {
		reader := bufio.NewReaderSize(input, maximumACKLine+2)
		for {
			line, err := reader.ReadSlice('\n')
			if len(line) > maximumACKLine+1 {
				err = errors.New("diagnostic ACK line exceeds 1 MiB")
			}
			if err == bufio.ErrBufferFull {
				err = errors.New("diagnostic ACK line exceeds 1 MiB")
			}
			value := diagnosticLine{bytes: append([]byte(nil), line...), err: err}
			select {
			case protocol.lines <- value:
			case <-protocol.stop:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	return protocol
}

func (protocol *diagnosticProtocol) close() { protocol.closeOnce.Do(func() { close(protocol.stop) }) }

func validateACK(line []byte, expectedID int) error {
	if len(line) == 0 || line[len(line)-1] != '\n' || len(line)-1 > maximumACKLine {
		return errors.New("invalid diagnostic ACK line")
	}
	decoder := json.NewDecoder(bytes.NewReader(line))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return errors.New("diagnostic ACK must be an object")
	}
	fields := map[string]json.RawMessage{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		key, ok := token.(string)
		if !ok {
			return errors.New("invalid diagnostic ACK key")
		}
		if _, duplicate := fields[key]; duplicate {
			return fmt.Errorf("duplicate diagnostic ACK field %q", key)
		}
		if key != "type" && key != "version" && key != "id" && key != "ok" && key != "error" {
			return fmt.Errorf("unknown diagnostic ACK field %q", key)
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return err
		}
		fields[key] = value
	}
	if _, err := decoder.Token(); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("trailing diagnostic ACK value")
	}
	var kind string
	var version, id int
	var ok bool
	if json.Unmarshal(fields["type"], &kind) != nil || kind != "ack" || json.Unmarshal(fields["version"], &version) != nil || version != 1 ||
		json.Unmarshal(fields["id"], &id) != nil || id != expectedID || json.Unmarshal(fields["ok"], &ok) != nil || bytes.Equal(fields["ok"], []byte("null")) {
		return errors.New("diagnostic ACK type/version/id/ok mismatch")
	}
	if ok {
		if len(fields) != 4 {
			return errors.New("successful diagnostic ACK must not include error")
		}
		return nil
	}
	var message string
	if len(fields) != 5 || json.Unmarshal(fields["error"], &message) != nil || bytes.Equal(fields["error"], []byte("null")) {
		return errors.New("failed diagnostic ACK requires a string error")
	}
	return fmt.Errorf("diagnostic hook rejected: %s", message)
}

func (protocol *diagnosticProtocol) hook(kind string, item map[string]any) error {
	budget, valid := protocol.timeouts[kind]
	if !valid {
		return errors.New("invalid diagnostic hook kind")
	}
	protocol.nextID++
	id := protocol.nextID
	encoded, err := json.Marshal(map[string]any{"type": "hook", "version": 1, "id": id, "kind": kind,
		"item": map[string]any{"key": item["key"], "variant": item["variant"], "tabId": item["tabId"]}})
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	if n, err := protocol.output.Write(encoded); err != nil {
		return err
	} else if n != len(encoded) {
		return io.ErrShortWrite
	}
	timer := time.NewTimer(budget)
	defer timer.Stop()
	select {
	case line := <-protocol.lines:
		if line.err != nil {
			return fmt.Errorf("diagnostic ACK read failed: %w", line.err)
		}
		return validateACK(line.bytes, id)
	case <-timer.C:
		return fmt.Errorf("diagnostic %s ACK timed out after %s", kind, budget)
	case <-protocol.stop:
		return errors.New("diagnostic protocol closed")
	}
}

func (progress *variantProgress) failure(err error, record map[string]any) {
	if err == nil || progress.failureCalled {
		return
	}
	progress.failureCalled = true
	progress.item["originalError"], progress.item["error"] = err.Error(), err.Error()
	progress.item["failedAt"], progress.item["failedStage"] = time.Now().UnixMilli(), record["failedStage"]
	if failedStage, ok := record["failedStage"].(string); ok {
		progress.item["stage"] = failedStage
	}
	_ = progress.notify("failure") // A diagnostic must not replace the business error.
}

func (progress *variantProgress) step(record map[string]any, name string, operation func() error) error {
	progress.item["currentStage"] = name
	if !progress.failureCalled {
		progress.item["stage"] = name
	}
	err := recordStage(record, name, operation)
	progress.failure(err, record)
	return err
}

func withChooserCancellation(progress *variantProgress, event map[string]any, cancel func() error, operation func() error) (err error) {
	defer func() {
		if cancelErr := recordStage(event, "cancel", cancel); cancelErr != nil {
			event["cancelError"] = cancelErr.Error()
			if err == nil {
				err = cancelErr
				progress.failure(err, event)
			}
		}
	}()
	err = operation()
	progress.failure(err, event) // Normally already recorded by the failed stage.
	return err
}

func withVariant(item map[string]any, hook func(string, map[string]any) error, operation func(*variantProgress) error) (err error) {
	progress := &variantProgress{item: item, hook: hook}
	defer func() {
		// All acquired waiters have passed through cancellation before finish.
		if finishErr := progress.notify("finish"); err == nil && finishErr != nil {
			err = finishErr
		}
		item["completedAt"], item["passed"] = time.Now().UnixMilli(), err == nil
		if err != nil {
			item["error"] = err.Error()
		}
	}()
	return operation(progress)
}
