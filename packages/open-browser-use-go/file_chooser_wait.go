package obu

import (
	"errors"
	"math"
	"os"
	"sync"
	"time"
)

// FileChooserWaitOptions includes preparation, triggering and collection in one
// deadline. Zero selects 10 seconds; other values must be whole milliseconds.
type FileChooserWaitOptions struct{ Timeout time.Duration }

type FileChooserResult struct {
	FileChooserID string `json:"fileChooserId"`
	IsMultiple    bool   `json:"isMultiple"`
}

// FileChooserWait acknowledges that interception is ready before another
// connection clicks. Its public fields are informational, never mutable scope.
type FileChooserWait struct {
	WaiterID    string
	RemainingMS float64
	client      *Client
	params      Params
	deadline    time.Time
	mu          sync.Mutex
	collecting  bool
	consumed    bool
}

func isFileChooserWaitMethod(method string) bool {
	return method == "armFileChooserWait" || method == "collectFileChooserWait" || method == "cancelFileChooserWait"
}

func (t *Tab) ExpectFileChooser(options ...FileChooserWaitOptions) (*FileChooserWait, error) {
	if len(options) > 1 {
		return nil, errors.New("at most one file chooser wait options value is accepted")
	}
	timeout := 10 * time.Second
	if len(options) == 1 && options[0].Timeout != 0 {
		timeout = options[0].Timeout
	}
	if timeout < time.Millisecond || timeout > 120*time.Second || timeout%time.Millisecond != 0 {
		return nil, errors.New("file chooser wait timeout must be whole milliseconds from 1 to 120000")
	}
	originalDeadline := time.Now().Add(timeout)
	tabID := t.ID
	client := t.Browser.Client
	value, err := client.requestInScope("armFileChooserWait", Params{"tabId": tabID, "timeoutMs": timeout.Milliseconds()}, timeout+time.Second, func(metadata Params, deadline time.Time) (any, error) {
		epoch, ok := metadata["control_epoch"].(int64)
		if !ok || epoch < 1 {
			return nil, errors.New("file chooser waits require an explicit control epoch")
		}
		// The helper's own setup is part of the budget too.
		if limit := originalDeadline.Add(time.Second); limit.Before(deadline) {
			deadline = limit
		}
		binding := scopedParams(metadata, Params{"tabId": tabID})
		ack, err := client.requestLocked("armFileChooserWait", metadata, deadline)
		if err != nil {
			return nil, err
		}
		object := ack.(map[string]any) // validated at the wire boundary, including raw calls
		remaining := object["remainingMs"].(float64)
		// remainingMs may shorten, but cannot renew the caller's original budget.
		if ackDeadline := time.Now().Add(time.Duration(remaining * float64(time.Millisecond))); ackDeadline.Before(originalDeadline) {
			originalDeadline = ackDeadline
		}
		if !time.Now().Before(originalDeadline) {
			return nil, os.ErrDeadlineExceeded
		}
		id := object["waiterId"].(string)
		binding["waiterId"] = id
		return &FileChooserWait{WaiterID: id, RemainingMS: remaining, client: client, params: binding, deadline: originalDeadline}, nil
	})
	if err != nil {
		return nil, err
	}
	return value.(*FileChooserWait), nil
}

func (p *TabPlaywright) ExpectFileChooser(options ...FileChooserWaitOptions) (*FileChooserWait, error) {
	return p.tab.ExpectFileChooser(options...)
}

func (w *FileChooserWait) Result() (FileChooserResult, error) {
	w.mu.Lock()
	if w.collecting || w.consumed {
		w.mu.Unlock()
		return FileChooserResult{}, errors.New("file chooser wait result is already being collected or consumed")
	}
	if !time.Now().Before(w.deadline) {
		w.mu.Unlock()
		return FileChooserResult{}, os.ErrDeadlineExceeded
	}
	w.collecting = true
	w.mu.Unlock()
	defer func() { w.mu.Lock(); w.collecting = false; w.mu.Unlock() }()
	value, err := w.client.requestInScope("collectFileChooserWait", w.params, time.Until(w.deadline)+time.Second, func(params Params, deadline time.Time) (any, error) {
		if !time.Now().Before(w.deadline) {
			return nil, os.ErrDeadlineExceeded
		}
		if limit := w.deadline.Add(time.Second); limit.Before(deadline) {
			deadline = limit
		}
		// Recheck after lazy connection as well as after queue/bootstrap.
		return w.client.requestLocked("collectFileChooserWait", params, deadline, time.Second)
	})
	if err != nil {
		return FileChooserResult{}, err
	}
	w.mu.Lock()
	w.consumed = true
	w.mu.Unlock()
	object := value.(map[string]any)
	return FileChooserResult{FileChooserID: object["fileChooserId"].(string), IsMultiple: object["isMultiple"].(bool)}, nil
}

// Cancel keeps the original scope and is allowed after expiry to retry actual
// native cleanup. Its transport budget does not extend the observer deadline.
func (w *FileChooserWait) Cancel() error {
	_, err := w.client.requestWithTimeout("cancelFileChooserWait", w.params, 10*time.Second)
	return err
}

// ValidateFileChooserWaitResult also protects generic CLI/MCP and raw SDK calls.
// sentTimeoutMS is the arm budget after discovery/queue time was deducted.
func ValidateFileChooserWaitResult(method string, value any, sentTimeoutMS float64) error {
	object, ok := value.(map[string]any)
	if !ok {
		return errors.New("invalid file chooser wait acknowledgement")
	}
	switch method {
	case "armFileChooserWait":
		remaining, valid := object["remainingMs"].(float64)
		if len(object) != 2 || !networkString(object["waiterId"], 128, false) || !valid || math.IsNaN(remaining) || math.IsInf(remaining, 0) || remaining <= 0 || remaining > sentTimeoutMS {
			return errors.New("invalid file chooser wait ready acknowledgement")
		}
	case "collectFileChooserWait":
		_, valid := object["isMultiple"].(bool)
		if len(object) != 2 || !networkString(object["fileChooserId"], 128, false) || !valid {
			return errors.New("invalid file chooser wait result")
		}
	case "cancelFileChooserWait":
		if len(object) != 0 {
			return errors.New("invalid file chooser wait cancellation acknowledgement")
		}
	}
	return nil
}
