package obu

import (
	"errors"
	"math"
	"time"
)

// NavigationWaitOptions uses WaitUntil for ExpectURL or State for ExpectLoadState.
// Timeout zero selects the default; other values must be whole milliseconds.
type NavigationWaitOptions struct {
	Timeout   time.Duration
	WaitUntil string
	State     string
}
type NavigationWait struct {
	WaiterID    string
	RemainingMS float64 // Remaining observer budget at readiness, never a renewable deadline.
	client      *Client
	params      Params
}

func isNavigationWaitMethod(method string) bool {
	return method == "armNavigationWait" || method == "collectNavigationWait" || method == "cancelNavigationWait"
}
func navigationOptions(options []NavigationWaitOptions, fallback time.Duration) (NavigationWaitOptions, error) {
	if len(options) > 1 {
		return NavigationWaitOptions{}, errors.New("at most one navigation wait options value is accepted")
	}
	option := NavigationWaitOptions{}
	if len(options) == 1 {
		option = options[0]
	}
	if option.Timeout == 0 {
		option.Timeout = fallback
	}
	if option.Timeout < time.Millisecond || option.Timeout > 120*time.Second || option.Timeout%time.Millisecond != 0 {
		return option, errors.New("navigation wait timeout must be whole milliseconds from 1 to 120000")
	}
	return option, nil
}
func (t *Tab) ExpectURL(url string, options ...NavigationWaitOptions) (*NavigationWait, error) {
	return t.expectNavigation("url", url, options)
}
func (t *Tab) ExpectLoadState(options ...NavigationWaitOptions) (*NavigationWait, error) {
	return t.expectNavigation("loadstate", "", options)
}
func (p *TabPlaywright) ExpectURL(url string, options ...NavigationWaitOptions) (*NavigationWait, error) {
	return p.tab.ExpectURL(url, options...)
}
func (p *TabPlaywright) ExpectLoadState(options ...NavigationWaitOptions) (*NavigationWait, error) {
	return p.tab.ExpectLoadState(options...)
}
func (t *Tab) expectNavigation(event, url string, options []NavigationWaitOptions) (*NavigationWait, error) {
	option, err := navigationOptions(options, 10*time.Second)
	if err != nil {
		return nil, err
	}
	params := Params{"tabId": t.ID, "event": event, "timeoutMs": option.Timeout.Milliseconds()}
	if event == "url" {
		if option.WaitUntil == "" {
			option.WaitUntil = "load"
		}
		if !networkString(url, 4096, false) || option.State != "" || (option.WaitUntil != "load" && option.WaitUntil != "domcontentloaded" && option.WaitUntil != "networkidle" && option.WaitUntil != "commit") {
			return nil, errors.New("invalid navigation URL or WaitUntil")
		}
		params["url"] = url
		params["waitUntil"] = option.WaitUntil
	} else {
		if option.State == "" {
			option.State = "load"
		}
		if option.WaitUntil != "" || (option.State != "load" && option.State != "domcontentloaded" && option.State != "networkidle") {
			return nil, errors.New("invalid navigation load State")
		}
		params["state"] = option.State
	}
	client := t.Browser.Client
	value, err := client.requestInScope("armNavigationWait", params, option.Timeout+time.Second, func(metadata Params, deadline time.Time) (any, error) {
		epoch, ok := metadata["control_epoch"].(int64)
		if !ok || epoch < 1 {
			return nil, errors.New("navigation waits require an explicit control epoch")
		}
		binding := scopedParams(metadata, Params{"tabId": t.ID})
		ack, err := client.requestLocked("armNavigationWait", metadata, deadline)
		if err != nil {
			return nil, err
		}
		object, ok := ack.(map[string]any)
		if !ok || len(object) != 2 || !networkString(object["waiterId"], 128, false) {
			return nil, errors.New("invalid navigation wait ready acknowledgement")
		}
		remaining, ok := object["remainingMs"].(float64)
		if !ok || math.IsNaN(remaining) || remaining <= 0 || remaining > float64(option.Timeout.Milliseconds()) {
			return nil, errors.New("invalid navigation wait ready acknowledgement")
		}
		id := object["waiterId"].(string)
		binding["waiterId"] = id
		return &NavigationWait{WaiterID: id, RemainingMS: remaining, client: client, params: binding}, nil
	})
	if err != nil {
		return nil, err
	}
	return value.(*NavigationWait), nil
}
func (w *NavigationWait) call(method string, fallback time.Duration, options []NavigationWaitOptions) error {
	option, err := navigationOptions(options, fallback)
	if err != nil {
		return err
	}
	if option.State != "" || option.WaitUntil != "" {
		return errors.New("navigation result/cancel options only accept Timeout")
	}
	value, err := w.client.requestWithTimeout(method, w.params, option.Timeout+time.Second)
	if err != nil {
		return err
	}
	object, ok := value.(map[string]any)
	if !ok || len(object) != 0 {
		return errors.New("invalid navigation wait acknowledgement")
	}
	return nil
}
func (w *NavigationWait) Result(options ...NavigationWaitOptions) error {
	return w.call("collectNavigationWait", 120*time.Second, options)
}
func (w *NavigationWait) Cancel(options ...NavigationWaitOptions) error {
	return w.call("cancelNavigationWait", 10*time.Second, options)
}
