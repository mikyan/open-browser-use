//go:build windows

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
)

// The lifecycle seam allows failure tests without registering desktop hooks.
// next dispatches native callbacks on the same thread that installed the hook.
type observerPlatform interface {
	createQueue()
	installHook(func(uintptr, uint32)) uintptr
	startTimer(uint) uintptr
	post(uint32) bool
	next() (message, int32)
	foreground() foreground
	identify(uintptr) foreground
	cursor() (point, bool)
	stopTimer(uintptr) bool
	removeHook(uintptr) bool
}

func readStop(input io.Reader) stopRequest {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 1024), 1024)
	if scanner.Scan() {
		// Only this one field is accepted, once. Unknown or duplicate fields
		// cannot silently become a valid stop receipt.
		decoder := json.NewDecoder(strings.NewReader(scanner.Text()))
		opening, err := decoder.Token()
		if err != nil || opening != json.Delim('{') {
			return stopRequest{"invalid-command", "INVALID_COMMAND"}
		}
		name, err := decoder.Token()
		if err != nil || name != "operation" {
			return stopRequest{"invalid-command", "INVALID_COMMAND"}
		}
		var operation string
		if decoder.Decode(&operation) != nil || operation != "stop" || decoder.More() {
			return stopRequest{"invalid-command", "INVALID_COMMAND"}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim('}') || !errors.Is(decoder.Decode(new(any)), io.EOF) {
			return stopRequest{"invalid-command", "INVALID_COMMAND"}
		}
		return stopRequest{reason: "stop"}
	}
	if scanner.Err() != nil {
		return stopRequest{"stdin-error", "STDIN_FAILED"}
	}
	return stopRequest{reason: "eof"}
}

func observe(platform observerPlatform, input io.ReadCloser, output io.Writer, runID string, observerPID int, sampleMS uint) int {
	started := time.Now()
	encoder := json.NewEncoder(output)
	sequence, sampleCount, eventCount := uint64(0), uint64(0), uint64(0)
	failures := []string{}
	fail := func(code string) {
		for _, previous := range failures {
			if previous == code {
				return
			}
		}
		failures = append(failures, code)
	}
	emit := func(kind string, fields map[string]any) bool {
		if sequence >= 1000000 {
			fail("RECORD_LIMIT")
			return false
		}
		sequence++
		fields["version"], fields["type"], fields["runId"], fields["observerPID"] = 1, kind, runID, observerPID
		fields["sequence"], fields["at"], fields["elapsedUs"] = sequence, time.Now().UTC().Format(time.RFC3339Nano), time.Since(started).Microseconds()
		if encoder.Encode(fields) != nil {
			fail("OUTPUT_FAILED")
			return false
		}
		return true
	}
	sample := func(kind string, extra map[string]any) bool {
		cursor, ok := platform.cursor()
		if !ok {
			fail("CURSOR_SAMPLE_FAILED")
			return false
		}
		extra["foreground"], extra["cursor"] = platform.foreground(), map[string]int32{"x": cursor.X, "y": cursor.Y}
		if kind == "sample" {
			sampleCount++
		}
		return emit(kind, extra)
	}
	platform.createQueue()
	requests := make(chan stopRequest, 1)
	ready, preReadyEvents := false, uint64(0)
	hook := platform.installHook(func(hwnd uintptr, eventTime uint32) {
		if !ready {
			preReadyEvents++
			return
		}
		if len(failures) == 0 {
			eventCount++
			emit("foreground", map[string]any{"foreground": platform.identify(hwnd), "nativeEventTimeMs": eventTime})
		}
	})
	if hook == 0 {
		emit("error", map[string]any{"code": "HOOK_INSTALL_FAILED"})
		input.Close()
		return 1
	}
	timer := platform.startTimer(sampleMS)
	if timer == 0 {
		fail("TIMER_INSTALL_FAILED")
	}
	if len(failures) == 0 && !platform.post(wmReady) {
		fail("READY_POST_FAILED")
	}
	reason := "failure"
	var readerDone chan struct{}
	for len(failures) == 0 {
		select {
		case request := <-requests:
			reason = request.reason
			if request.failure != "" {
				fail(request.failure)
			}
			goto cleanup
		default:
		}
		msg, result := platform.next()
		if result == -1 {
			fail("MESSAGE_LOOP_FAILED")
			break
		}
		if result == 0 {
			fail("UNEXPECTED_QUIT")
			break
		}
		if len(failures) != 0 {
			break
		}
		switch msg.Message {
		case wmReady:
			if ready {
				fail("DUPLICATE_READY")
				break
			}
			ready = sample("ready", map[string]any{"sampleMs": sampleMS, "foregroundSource": "EVENT_SYSTEM_FOREGROUND", "cursorSource": "GetCursorPos-samples", "preReadyEvents": preReadyEvents})
			if ready {
				readerDone = make(chan struct{})
				go func() {
					defer close(readerDone)
					requests <- readStop(input)
					// A failed post is still observed by the real sample timer.
					platform.post(wmStop)
				}()
			}
		case wmTimer:
			if ready && msg.WParam == timer {
				sample("sample", map[string]any{})
			}
		}
	}
cleanup:
	// Release and join the stdin reader before this registering thread exits.
	input.Close()
	if readerDone != nil {
		<-readerDone
	}
	timerKilled := timer == 0 || platform.stopTimer(timer)
	hookRemoved := platform.removeHook(hook)
	if !timerKilled {
		fail("TIMER_CLEANUP_FAILED")
	}
	if !hookRemoved {
		fail("HOOK_CLEANUP_FAILED")
	}
	// Preserve the first failure as well as cleanup failures. Neither an output
	// error nor later release can transform partial coverage into success.
	for _, code := range append([]string(nil), failures...) {
		emit("error", map[string]any{"code": code})
	}
	if ready {
		emit("stopped", map[string]any{"reason": reason, "hookRemoved": hookRemoved, "timerKilled": timerKilled, "samples": sampleCount, "foregroundEvents": eventCount, "complete": len(failures) == 0})
	}
	if len(failures) != 0 {
		return 1
	}
	return 0
}
