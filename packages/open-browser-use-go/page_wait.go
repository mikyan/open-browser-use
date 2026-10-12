package obu

import (
	"errors"
	"math"
	"os"
	"sync"
	"time"
)

// PageWaitOptions includes setup, triggering and collection in one deadline.
// Zero selects 10 seconds; other values must be whole milliseconds.
type PageWaitOptions struct{ Timeout time.Duration }

// PageWait observes a native created page after explicit readiness.
// Cancelling this observer never closes a native child page.
type PageWait struct {
	WaiterID    string
	RemainingMS float64
	client      *Client
	generation  uint64
	params      Params
	deadline    time.Time
	mu          sync.Mutex
	collecting  bool
	consumed    bool
	cancelled   bool
}

func isPageWaitMethod(method string) bool {
	return method == "armPageWait" || method == "collectPageWait" || method == "cancelPageWait"
}

func (t *Tab) ExpectPage(options ...PageWaitOptions) (*PageWait, error) {
	if len(options) > 1 {
		return nil, errors.New("at most one page wait options value is accepted")
	}
	timeout := 10 * time.Second
	if len(options) == 1 && options[0].Timeout != 0 {
		timeout = options[0].Timeout
	}
	if timeout < time.Millisecond || timeout > 120*time.Second || timeout%time.Millisecond != 0 {
		return nil, errors.New("page wait timeout must be whole milliseconds from 1 to 120000")
	}
	originalDeadline := time.Now().Add(timeout)
	tabID := t.ID
	client := t.Browser.Client
	value, err := client.requestInScope("armPageWait", Params{"tabId": tabID, "timeoutMs": timeout.Milliseconds()}, timeout, func(metadata Params, deadline time.Time) (any, error) {
		epoch, ok := pageEpoch(metadata["control_epoch"])
		if !ok || epoch < 1 {
			return nil, errors.New("page waits require an explicit control epoch")
		}
		if limit := originalDeadline; limit.Before(deadline) {
			deadline = limit
		}
		binding := scopedParams(metadata, Params{"tabId": tabID})
		ack, err := client.requestLocked("armPageWait", metadata, deadline)
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
		origin := client
		for origin.scopeParent != nil {
			origin = origin.scopeParent
		}
		origin.controlMu.Lock()
		generation := origin.control.generation
		origin.controlMu.Unlock()
		return &PageWait{generation: generation, WaiterID: id, RemainingMS: math.Min(remaining, float64(time.Until(originalDeadline))/float64(time.Millisecond)), client: origin, params: binding, deadline: originalDeadline}, nil
	})
	if err != nil {
		return nil, err
	}
	return value.(*PageWait), nil
}

func (p *TabPlaywright) ExpectPage(options ...PageWaitOptions) (*PageWait, error) {
	return p.tab.ExpectPage(options...)
}

// Result returns a child tab bound to the original control scope.
func (w *PageWait) Result() (*Tab, error) {
	w.mu.Lock()
	if w.collecting || w.consumed || w.cancelled {
		w.mu.Unlock()
		return nil, errors.New("page wait result is already being collected, consumed or cancelled")
	}
	if !time.Now().Before(w.deadline) {
		w.mu.Unlock()
		return nil, os.ErrDeadlineExceeded
	}
	w.collecting = true
	w.mu.Unlock()
	defer func() { w.mu.Lock(); w.collecting = false; w.mu.Unlock() }()
	value, err := w.client.requestInScope("collectPageWait", w.params, time.Until(w.deadline), func(params Params, deadline time.Time) (any, error) {
		if !time.Now().Before(w.deadline) {
			return nil, os.ErrDeadlineExceeded
		}
		if limit := w.deadline; limit.Before(deadline) {
			deadline = limit
		}
		return w.client.requestLocked("collectPageWait", params, deadline)
	})
	if err != nil {
		return nil, err
	}
	w.mu.Lock()
	w.consumed = true
	w.mu.Unlock()
	if !time.Now().Before(w.deadline) {
		return nil, os.ErrDeadlineExceeded
	}
	id := int(value.(map[string]any)["tabId"].(float64))
	if id == w.params["tabId"].(int) {
		return nil, errors.New("invalid page wait result: child equals source")
	}
	view := NewClient(w.client.options)
	view.scopeParent, view.boundScope, view.boundGeneration = w.client, scopedParams(w.params, nil), w.generation
	if err := view.checkBoundScope(); err != nil {
		return nil, err
	}
	return NewBrowser(view).Tab(id), nil
}

// Cancel is allowed after expiry and only retires this observer. It does not
// renew the wait, replay a trigger, or close a native child page.
func (w *PageWait) Cancel() error {
	_, err := w.client.requestWithTimeout("cancelPageWait", w.params, 10*time.Second)
	if err == nil {
		w.mu.Lock()
		w.cancelled = true
		w.mu.Unlock()
	}
	return err
}

// ValidatePageWaitParams checks JSON-normalized parameters before transport.
// Missing control fields may be populated by the normal client handshake.
func ValidatePageWaitParams(method string, params Params) error {
	invalid := errors.New("invalid page wait parameters")
	if !isPageWaitMethod(method) {
		return invalid
	}
	allowed := map[string]bool{"session_id": true, "turn_id": true, "control_epoch": true, "tabId": true}
	if method == "armPageWait" {
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

// ValidatePageWaitResult also protects raw SDK and generic CLI/MCP calls.
func ValidatePageWaitResult(method string, value any, sentTimeoutMS float64) error {
	object, ok := value.(map[string]any)
	if !ok || !isPageWaitMethod(method) {
		return errors.New("invalid page wait acknowledgement")
	}
	switch method {
	case "armPageWait":
		remaining, valid := object["remainingMs"].(float64)
		if len(object) != 2 || !networkString(object["waiterId"], 128, false) || !valid || math.IsNaN(remaining) || math.IsInf(remaining, 0) || remaining <= 0 || remaining > sentTimeoutMS {
			return errors.New("invalid page wait ready acknowledgement")
		}
	case "collectPageWait":
		id, valid := object["tabId"].(float64)
		if len(object) != 1 || !valid || math.IsNaN(id) || math.IsInf(id, 0) || id < 0 || id > 9007199254740991 || id != math.Trunc(id) || id > float64(int(^uint(0)>>1)) {
			return errors.New("invalid page wait result")
		}
	case "cancelPageWait":
		if len(object) != 0 {
			return errors.New("invalid page wait cancellation acknowledgement")
		}
	}
	return nil
}

func pageEpoch(value any) (int64, bool) {
	switch v := value.(type) {
	case int64:
		return v, v > 0
	case float64:
		return int64(v), v >= 1 && v <= 9007199254740991 && v == math.Trunc(v)
	}
	return 0, false
}

// A created-page client view shares the original transport, never a new connection.
func (c *Client) checkBoundScope() error {
	if c.scopeParent == nil {
		return nil
	}
	p := c.scopeParent
	if err := p.checkBoundScope(); err != nil {
		return err
	}
	p.controlMu.Lock()
	state := p.control
	p.controlMu.Unlock()
	epoch, ok := pageEpoch(c.boundScope["control_epoch"])
	if !ok || state.generation != c.boundGeneration || state.epoch != epoch || state.turnID != c.boundScope["turn_id"] || p.options.SessionID != c.boundScope["session_id"] {
		return errors.New("OBU_STALE_CONTROL_EPOCH: created page belongs to an earlier control scope")
	}
	return nil
}
