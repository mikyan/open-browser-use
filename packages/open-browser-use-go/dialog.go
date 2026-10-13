package obu

import (
	"errors"
	"math"
	"os"
	"sync"
	"time"
	"unicode/utf8"
)

// DialogDecision selects one native dialog. Nil Message matches any message.
// PromptText is allowed only for an accepted prompt; nil means an empty reply.
type DialogDecision struct {
	Type       string  `json:"type"`
	Accept     bool    `json:"accept"`
	Message    *string `json:"message,omitempty"`
	PromptText *string `json:"promptText,omitempty"`
}
type DialogWaitOptions struct{ Timeout time.Duration }
type DialogResult struct {
	Type         string  `json:"type"`
	Message      string  `json:"message"`
	DefaultValue string  `json:"defaultValue"`
	Accepted     bool    `json:"accepted"`
	PromptText   *string `json:"promptText,omitempty"`
}

// DialogWait keeps the original connection, control scope and deadline. A failed
// result never replays the page trigger or the native dialog response.
type DialogWait struct {
	DialogID                        string
	RemainingMS                     float64
	client                          *Client
	params                          Params
	deadline                        time.Time
	decision                        DialogDecision
	mu                              sync.Mutex
	collecting, consumed, cancelled bool
}

func isDialogMethod(method string) bool {
	return method == "armDialog" || method == "collectDialog" || method == "cancelDialog"
}
func dialogString(value any, maximum int, empty bool) bool {
	s, ok := value.(string)
	return ok && utf8.ValidString(s) && len(s) <= maximum && (empty || s != "")
}
func dialogType(value any) bool {
	s, ok := value.(string)
	return ok && (s == "alert" || s == "confirm" || s == "prompt" || s == "beforeunload")
}

// ValidateDialogInputUnicode must run before JSON normalization, which would
// otherwise replace invalid UTF-8 with a different string.
func ValidateDialogInputUnicode(params Params) error {
	for key, value := range params {
		if !utf8.ValidString(key) {
			return errors.New("invalid dialog Unicode")
		}
		if s, ok := value.(string); ok && !utf8.ValidString(s) {
			return errors.New("invalid dialog Unicode")
		}
	}
	return nil
}

// ValidateDialogParams validates JSON-normalized public wire parameters.
func ValidateDialogParams(method string, params Params) error {
	invalid := errors.New("invalid dialog parameters")
	if !isDialogMethod(method) {
		return invalid
	}
	allowed := map[string]bool{"session_id": true, "turn_id": true, "control_epoch": true, "tabId": true}
	integer := func(v any, min, max float64) bool {
		n, ok := v.(float64)
		return ok && !math.IsNaN(n) && !math.IsInf(n, 0) && n >= min && n <= max && n == math.Trunc(n)
	}
	if method == "armDialog" {
		for _, key := range []string{"type", "accept", "message", "promptText", "timeoutMs"} {
			allowed[key] = true
		}
		if !dialogType(params["type"]) {
			return invalid
		}
		if _, ok := params["accept"].(bool); !ok {
			return invalid
		}
		if v, ok := params["message"]; ok && !dialogString(v, 8192, true) {
			return invalid
		}
		if v, ok := params["promptText"]; ok && (params["type"] != "prompt" || params["accept"] != true || !dialogString(v, 8192, true)) {
			return invalid
		}
		if v, ok := params["timeoutMs"]; ok && !integer(v, 1, 120000) {
			return invalid
		}
	} else {
		allowed["dialogId"] = true
		if !dialogString(params["dialogId"], 128, false) {
			return invalid
		}
	}
	for key := range params {
		if !allowed[key] {
			return invalid
		}
	}
	if !integer(params["tabId"], 0, 9007199254740991) {
		return invalid
	}
	for _, key := range []string{"session_id", "turn_id"} {
		if v, ok := params[key]; ok && !dialogString(v, 4096, false) {
			return invalid
		}
	}
	if v, ok := params["control_epoch"]; ok && !integer(v, 1, 9007199254740991) {
		return invalid
	}
	return nil
}

func ValidateDialogResult(method string, value any, sentTimeoutMS float64) error {
	invalid := errors.New("invalid dialog acknowledgement")
	p, ok := value.(map[string]any)
	if !ok {
		return invalid
	}
	switch method {
	case "armDialog":
		n, ok := p["remainingMs"].(float64)
		if len(p) != 2 || !dialogString(p["dialogId"], 128, false) || !ok || math.IsNaN(n) || math.IsInf(n, 0) || n <= 0 || n > sentTimeoutMS {
			return invalid
		}
	case "cancelDialog":
		if len(p) != 0 {
			return invalid
		}
	case "collectDialog":
		if !dialogType(p["type"]) || !dialogString(p["message"], 8192, true) || !dialogString(p["defaultValue"], 8192, true) {
			return invalid
		}
		if _, ok := p["accepted"].(bool); !ok {
			return invalid
		}
		if p["type"] == "prompt" && p["accepted"] == true {
			if len(p) != 5 || !dialogString(p["promptText"], 8192, true) {
				return invalid
			}
		} else if len(p) != 4 {
			return invalid
		}
		for key := range p {
			if key != "type" && key != "message" && key != "defaultValue" && key != "accepted" && (key != "promptText" || p["type"] != "prompt" || p["accepted"] != true) {
				return invalid
			}
		}
	default:
		return invalid
	}
	return nil
}

func (c *Client) ArmDialog(params Params) (any, error)     { return c.Request("armDialog", params) }
func (c *Client) CollectDialog(params Params) (any, error) { return c.Request("collectDialog", params) }
func (c *Client) CancelDialog(params Params) (any, error)  { return c.Request("cancelDialog", params) }

func (t *Tab) ExpectDialog(decision DialogDecision, options ...DialogWaitOptions) (*DialogWait, error) {
	if len(options) > 1 {
		return nil, errors.New("at most one dialog wait options value is accepted")
	}
	timeout := 10 * time.Second
	if len(options) == 1 && options[0].Timeout != 0 {
		timeout = options[0].Timeout
	}
	if timeout < time.Millisecond || timeout > 120*time.Second || timeout%time.Millisecond != 0 {
		return nil, errors.New("dialog timeout must be whole milliseconds from 1 to 120000")
	}
	deadline := time.Now().Add(timeout)
	p := Params{"tabId": t.ID, "type": decision.Type, "accept": decision.Accept, "timeoutMs": timeout.Milliseconds()}
	if decision.Message != nil {
		value := *decision.Message
		decision.Message = &value
		p["message"] = value
	}
	if decision.PromptText != nil {
		value := *decision.PromptText
		decision.PromptText = &value
		p["promptText"] = value
	}
	client := t.Browser.Client
	result, err := client.requestInScope("armDialog", p, timeout, func(params Params, budget time.Time) (any, error) {
		if deadline.Before(budget) {
			budget = deadline
		}
		value, err := client.requestLocked("armDialog", params, budget)
		if err != nil {
			return nil, err
		}
		ack := value.(map[string]any)
		remaining := ack["remainingMs"].(float64)
		if limit := time.Now().Add(time.Duration(remaining * float64(time.Millisecond))); limit.Before(deadline) {
			deadline = limit
		}
		if !time.Now().Before(deadline) {
			return nil, os.ErrDeadlineExceeded
		}
		origin := client
		for origin.scopeParent != nil {
			origin = origin.scopeParent
		}
		id := ack["dialogId"].(string)
		return &DialogWait{DialogID: id, RemainingMS: math.Min(remaining, float64(time.Until(deadline))/float64(time.Millisecond)), client: origin, params: scopedParams(params, Params{"tabId": params["tabId"], "dialogId": id}), deadline: deadline, decision: decision}, nil
	})
	if err != nil {
		return nil, err
	}
	return result.(*DialogWait), nil
}
func (p *TabPlaywright) ExpectDialog(decision DialogDecision, options ...DialogWaitOptions) (*DialogWait, error) {
	return p.tab.ExpectDialog(decision, options...)
}
func (w *DialogWait) Result() (*DialogResult, error) {
	w.mu.Lock()
	if w.collecting || w.consumed || w.cancelled {
		w.mu.Unlock()
		return nil, errors.New("dialog result is already being collected, consumed or cancelled")
	}
	if !time.Now().Before(w.deadline) {
		w.mu.Unlock()
		return nil, os.ErrDeadlineExceeded
	}
	w.collecting = true
	w.mu.Unlock()
	defer func() { w.mu.Lock(); w.collecting = false; w.mu.Unlock() }()
	value, err := w.client.requestInScope("collectDialog", w.params, time.Until(w.deadline), func(params Params, budget time.Time) (any, error) {
		if w.deadline.Before(budget) {
			budget = w.deadline
		}
		return w.client.requestLocked("collectDialog", params, budget)
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
	p := value.(map[string]any)
	result := &DialogResult{Type: p["type"].(string), Message: p["message"].(string), DefaultValue: p["defaultValue"].(string), Accepted: p["accepted"].(bool)}
	if text, ok := p["promptText"].(string); ok {
		result.PromptText = &text
	}
	if result.Type != w.decision.Type || result.Accepted != w.decision.Accept || (w.decision.Message != nil && result.Message != *w.decision.Message) {
		return nil, errors.New("dialog result does not match the original decision")
	}
	if result.PromptText != nil {
		expected := ""
		if w.decision.PromptText != nil {
			expected = *w.decision.PromptText
		}
		if *result.PromptText != expected {
			return nil, errors.New("dialog result does not match the original prompt text")
		}
	}
	return result, nil
}

// Cancel can retire an expired observer; it cannot undo an already sent response.
func (w *DialogWait) Cancel() error {
	_, err := w.client.requestWithTimeout("cancelDialog", w.params, 10*time.Second)
	if err == nil {
		w.mu.Lock()
		w.cancelled = true
		w.mu.Unlock()
	}
	return err
}
