package obu

import (
	"errors"
	"math"
	"os"
	"sync"
	"time"
)

// DownloadWaitOptions includes setup, triggering and collection in one deadline.
// Zero selects 10 seconds; other values must be whole milliseconds.
type DownloadWaitOptions struct{ Timeout time.Duration }

// DownloadWait observes a page-triggered download after explicit readiness.
// Cancelling this observer never cancels the actual browser transfer.
type DownloadWait struct {
	WaiterID    string
	RemainingMS float64
	client      *Client
	params      Params
	deadline    time.Time
	mu          sync.Mutex
	collecting  bool
	consumed    bool
	cancelled   bool
}

func isDownloadWaitMethod(method string) bool {
	return method == "armDownloadWait" || method == "collectDownloadWait" || method == "cancelDownloadWait"
}

func (t *Tab) ExpectDownload(options ...DownloadWaitOptions) (*DownloadWait, error) {
	if len(options) > 1 {
		return nil, errors.New("at most one download wait options value is accepted")
	}
	timeout := 10 * time.Second
	if len(options) == 1 && options[0].Timeout != 0 {
		timeout = options[0].Timeout
	}
	if timeout < time.Millisecond || timeout > 120*time.Second || timeout%time.Millisecond != 0 {
		return nil, errors.New("download wait timeout must be whole milliseconds from 1 to 120000")
	}
	originalDeadline := time.Now().Add(timeout)
	tabID := t.ID
	client := t.Browser.Client
	value, err := client.requestInScope("armDownloadWait", Params{"tabId": tabID, "timeoutMs": timeout.Milliseconds()}, timeout+time.Second, func(metadata Params, deadline time.Time) (any, error) {
		epoch, ok := metadata["control_epoch"].(int64)
		if !ok || epoch < 1 {
			return nil, errors.New("download waits require an explicit control epoch")
		}
		if limit := originalDeadline.Add(time.Second); limit.Before(deadline) {
			deadline = limit
		}
		binding := scopedParams(metadata, Params{"tabId": tabID})
		ack, err := client.requestLocked("armDownloadWait", metadata, deadline)
		if err != nil {
			return nil, err
		}
		object := ack.(map[string]any) // raw and typed responses share wire validation
		remaining := object["remainingMs"].(float64)
		if ackDeadline := time.Now().Add(time.Duration(remaining * float64(time.Millisecond))); ackDeadline.Before(originalDeadline) {
			originalDeadline = ackDeadline
		}
		if !time.Now().Before(originalDeadline) {
			return nil, os.ErrDeadlineExceeded
		}
		id := object["waiterId"].(string)
		binding["waiterId"] = id
		return &DownloadWait{WaiterID: id, RemainingMS: remaining, client: client, params: binding, deadline: originalDeadline}, nil
	})
	if err != nil {
		return nil, err
	}
	return value.(*DownloadWait), nil
}

func (p *TabPlaywright) ExpectDownload(options ...DownloadWaitOptions) (*DownloadWait, error) {
	return p.tab.ExpectDownload(options...)
}

// Result consumes one page-native GUID. Its Download retains the original scope;
// page GUID path and transfer cancellation keep their explicit platform errors.
func (w *DownloadWait) Result() (*Download, error) {
	w.mu.Lock()
	if w.collecting || w.consumed || w.cancelled {
		w.mu.Unlock()
		return nil, errors.New("download wait result is already being collected, consumed or cancelled")
	}
	if !time.Now().Before(w.deadline) {
		w.mu.Unlock()
		return nil, os.ErrDeadlineExceeded
	}
	w.collecting = true
	w.mu.Unlock()
	defer func() { w.mu.Lock(); w.collecting = false; w.mu.Unlock() }()
	value, err := w.client.requestInScope("collectDownloadWait", w.params, time.Until(w.deadline)+time.Second, func(params Params, deadline time.Time) (any, error) {
		if !time.Now().Before(w.deadline) {
			return nil, os.ErrDeadlineExceeded
		}
		if limit := w.deadline.Add(time.Second); limit.Before(deadline) {
			deadline = limit
		}
		return w.client.requestLocked("collectDownloadWait", params, deadline, time.Second)
	})
	if err != nil {
		return nil, err
	}
	w.mu.Lock()
	w.consumed = true
	w.mu.Unlock()
	id := value.(map[string]any)["downloadId"].(string)
	// Observer identity and timeout must not leak into the transfer API.
	binding := scopedParams(w.params, Params{"tabId": w.params["tabId"], "downloadId": id})
	return &Download{DownloadID: id, client: w.client, params: binding}, nil
}

// Cancel is allowed after expiry and only retires this observer. It does not
// renew the wait, replay a trigger, or cancel an already started transfer.
func (w *DownloadWait) Cancel() error {
	_, err := w.client.requestWithTimeout("cancelDownloadWait", w.params, 10*time.Second)
	if err == nil {
		w.mu.Lock()
		w.cancelled = true
		w.mu.Unlock()
	}
	return err
}

// ValidateDownloadWaitParams checks JSON-normalized parameters before transport.
// Missing control fields may be populated by the normal client handshake.
func ValidateDownloadWaitParams(method string, params Params) error {
	invalid := errors.New("invalid download wait parameters")
	if !isDownloadWaitMethod(method) {
		return invalid
	}
	allowed := map[string]bool{"session_id": true, "turn_id": true, "control_epoch": true, "tabId": true}
	if method == "armDownloadWait" {
		allowed["timeoutMs"] = true
	} else {
		allowed["waiterId"] = true
		if !networkString(params["waiterId"], 128, false) {
			return invalid
		}
	}
	for key := range params {
		if !allowed[key] {
			return invalid
		}
	}
	integer := func(value any, min, max float64) bool {
		n, ok := value.(float64)
		return ok && !math.IsNaN(n) && !math.IsInf(n, 0) && n >= min && n <= max && n == math.Trunc(n)
	}
	if !integer(params["tabId"], 0, 9007199254740991) {
		return invalid
	}
	for _, key := range []string{"session_id", "turn_id"} {
		if value, exists := params[key]; exists && !networkString(value, 4096, false) {
			return invalid
		}
	}
	if value, exists := params["control_epoch"]; exists && !integer(value, 1, 9007199254740991) {
		return invalid
	}
	if value, exists := params["timeoutMs"]; exists && !integer(value, 1, 120000) {
		return invalid
	}
	return nil
}

// ValidateDownloadWaitResult also protects raw SDK and generic CLI/MCP calls.
func ValidateDownloadWaitResult(method string, value any, sentTimeoutMS float64) error {
	object, ok := value.(map[string]any)
	if !ok {
		return errors.New("invalid download wait acknowledgement")
	}
	switch method {
	case "armDownloadWait":
		remaining, valid := object["remainingMs"].(float64)
		if len(object) != 2 || !networkString(object["waiterId"], 128, false) || !valid || math.IsNaN(remaining) || math.IsInf(remaining, 0) || remaining <= 0 || remaining > sentTimeoutMS {
			return errors.New("invalid download wait ready acknowledgement")
		}
	case "collectDownloadWait":
		if len(object) != 1 || !networkString(object["downloadId"], 256, false) {
			return errors.New("invalid download wait result")
		}
	case "cancelDownloadWait":
		if len(object) != 0 {
			return errors.New("invalid download wait cancellation acknowledgement")
		}
	}
	return nil
}
