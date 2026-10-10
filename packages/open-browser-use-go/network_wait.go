package obu

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"
	"unicode/utf8"
)

type NetworkWaitMatch struct {
	URL      string
	URLMatch string // Empty means exact; the other accepted value is contains.
	Method   string
	Status   int // Zero omits the response-only status condition.
}
type NetworkWaitOptions struct{ Timeout time.Duration }
type NetworkWaitResult struct {
	Event          string `json:"event"`
	RequestID      string `json:"requestId"`
	URL            string `json:"url"`
	Method         string `json:"method"`
	ResourceType   string `json:"resourceType"`
	FrameURL       string `json:"frameUrl,omitempty"`
	RedirectedFrom string `json:"redirectedFrom,omitempty"`
	Status         int    `json:"status,omitempty"`
	StatusText     string `json:"statusText,omitempty"`
	Truncated      bool   `json:"truncated,omitempty"`
}

// NetworkWait is a ready listener with its original control binding. Trigger
// the page action before Result; synchronous clients cannot trigger while collecting.
type NetworkWait struct {
	WaiterID    string
	RemainingMS float64 // Budget at acknowledgement, not a renewable timeout.
	client      *Client
	params      Params
	event       string
}

func isNetworkWaitMethod(method string) bool {
	return method == "armNetworkWait" || method == "collectNetworkWait" || method == "cancelNetworkWait"
}
func networkTimeout(options []NetworkWaitOptions, fallback time.Duration) (time.Duration, error) {
	if len(options) > 1 {
		return 0, errors.New("at most one network wait options value is accepted")
	}
	timeout := fallback
	if len(options) == 1 && options[0].Timeout != 0 {
		timeout = options[0].Timeout
	}
	if timeout < time.Millisecond || timeout > 120*time.Second || timeout%time.Millisecond != 0 {
		return 0, errors.New("network wait timeout must be an integer number of milliseconds from 1 to 120000")
	}
	return timeout, nil
}
func networkString(value any, maximum int, empty bool) bool {
	text, ok := value.(string)
	return ok && (empty || text != "") && utf8.ValidString(text) && len(text) <= maximum
}
func (match NetworkWaitMatch) params(event string) (Params, error) {
	if !networkString(match.URL, 4096, false) || (match.URLMatch != "" && match.URLMatch != "exact" && match.URLMatch != "contains") ||
		(match.Method != "" && !networkString(match.Method, 128, false)) ||
		(match.Status != 0 && (event != "response" || match.Status < 100 || match.Status > 599)) {
		return nil, errors.New("invalid network wait match")
	}
	value := Params{"url": match.URL}
	if match.URLMatch != "" {
		value["urlMatch"] = match.URLMatch
	}
	if match.Method != "" {
		value["method"] = match.Method
	}
	if match.Status != 0 {
		value["status"] = match.Status
	}
	return value, nil
}
func (t *Tab) ExpectRequest(match NetworkWaitMatch, options ...NetworkWaitOptions) (*NetworkWait, error) {
	return t.expectNetwork("request", match, options)
}
func (t *Tab) ExpectResponse(match NetworkWaitMatch, options ...NetworkWaitOptions) (*NetworkWait, error) {
	return t.expectNetwork("response", match, options)
}
func (p *TabPlaywright) ExpectRequest(match NetworkWaitMatch, options ...NetworkWaitOptions) (*NetworkWait, error) {
	return p.tab.ExpectRequest(match, options...)
}
func (p *TabPlaywright) ExpectResponse(match NetworkWaitMatch, options ...NetworkWaitOptions) (*NetworkWait, error) {
	return p.tab.ExpectResponse(match, options...)
}
func (t *Tab) expectNetwork(event string, match NetworkWaitMatch, options []NetworkWaitOptions) (*NetworkWait, error) {
	timeout, err := networkTimeout(options, 10*time.Second)
	if err != nil {
		return nil, err
	}
	conditions, err := match.params(event)
	if err != nil {
		return nil, err
	}
	client := t.Browser.Client
	value, err := client.requestInScope("armNetworkWait", Params{"tabId": t.ID, "event": event, "match": conditions, "timeoutMs": timeout.Milliseconds()}, timeout+time.Second,
		func(metadata Params, deadline time.Time) (any, error) {
			epoch, ok := metadata["control_epoch"].(int64)
			if !ok || epoch < 1 {
				return nil, errors.New("network waits require an explicit control epoch")
			}
			binding := scopedParams(metadata, Params{"tabId": t.ID})
			ack, err := client.requestLocked("armNetworkWait", metadata, deadline)
			if err != nil {
				return nil, err
			}
			object, ok := ack.(map[string]any)
			if !ok || len(object) != 2 || !networkString(object["waiterId"], 128, false) {
				return nil, errors.New("invalid network wait ready acknowledgement")
			}
			remaining, ok := object["remainingMs"].(float64)
			if !ok || math.IsNaN(remaining) || remaining <= 0 || remaining > float64(timeout.Milliseconds()) {
				return nil, errors.New("invalid network wait ready acknowledgement")
			}
			id := object["waiterId"].(string)
			binding["waiterId"] = id
			return &NetworkWait{WaiterID: id, RemainingMS: remaining, client: client, params: binding, event: event}, nil
		})
	if err != nil {
		return nil, err
	}
	return value.(*NetworkWait), nil
}
func (w *NetworkWait) Result(options ...NetworkWaitOptions) (NetworkWaitResult, error) {
	timeout, err := networkTimeout(options, 120*time.Second)
	if err != nil {
		return NetworkWaitResult{}, err
	}
	value, err := w.client.requestWithTimeout("collectNetworkWait", w.params, timeout+time.Second)
	if err != nil {
		return NetworkWaitResult{}, err
	}
	return parseNetworkResult(value, w.event)
}
func (w *NetworkWait) Cancel(options ...NetworkWaitOptions) error {
	timeout, err := networkTimeout(options, 10*time.Second)
	if err != nil {
		return err
	}
	value, err := w.client.requestWithTimeout("cancelNetworkWait", w.params, timeout+time.Second)
	if err != nil {
		return err
	}
	object, ok := value.(map[string]any)
	if !ok || len(object) != 0 {
		return errors.New("invalid network wait cancellation acknowledgement")
	}
	return nil
}
func parseNetworkResult(value any, event string) (NetworkWaitResult, error) {
	fail := func() (NetworkWaitResult, error) {
		return NetworkWaitResult{}, errors.New("invalid network wait result")
	}
	object, ok := value.(map[string]any)
	if !ok {
		return fail()
	}
	for key := range object {
		switch key {
		case "event", "requestId", "url", "method", "resourceType", "frameUrl", "redirectedFrom", "status", "statusText", "truncated":
		default:
			return fail()
		}
	}
	if object["event"] != event || !networkString(object["requestId"], 128, false) || !networkString(object["url"], 4096, false) || !networkString(object["method"], 128, false) || !networkString(object["resourceType"], 128, false) {
		return fail()
	}
	for _, item := range []struct {
		key   string
		max   int
		empty bool
	}{{"frameUrl", 4096, true}, {"redirectedFrom", 128, false}, {"statusText", 1024, true}} {
		if v, exists := object[item.key]; exists && !networkString(v, item.max, item.empty) {
			return fail()
		}
	}
	if value, exists := object["truncated"]; exists {
		if _, ok := value.(bool); !ok {
			return fail()
		}
	}
	status, present := object["status"]
	if event == "response" {
		number, ok := status.(float64)
		if !ok || math.IsNaN(number) || number < 100 || number > 599 || math.Trunc(number) != number {
			return fail()
		}
	} else if _, hasText := object["statusText"]; present || hasText {
		return fail()
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return fail()
	}
	if buffer.Len()-1 > 16384 {
		return fail()
	}
	var result NetworkWaitResult
	if err := json.Unmarshal(buffer.Bytes(), &result); err != nil {
		return result, fmt.Errorf("invalid network wait result: %w", err)
	}
	return result, nil
}
