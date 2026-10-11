package obu

import (
	"errors"
	"fmt"
	"strconv"
	"time"
)

type Browser struct {
	Client *Client
	CDP    *CDP
}

func NewBrowser(client *Client) *Browser {
	return &Browser{Client: client, CDP: NewCDP(client)}
}

func (b *Browser) Connect() error {
	return b.Client.Connect()
}

func (b *Browser) Close() error {
	return b.Client.Close()
}

func (b *Browser) NewTab(options ...GotoOptions) (*Tab, error) {
	option := GotoOptions{}
	if len(options) > 0 {
		option = options[0]
	}
	return b.NewTabWithOptions(NewTabOptions{URL: option.URL, WaitUntil: option.WaitUntil, Timeout: option.Timeout})
}

func (b *Browser) NewTabWithOptions(option NewTabOptions) (*Tab, error) {
	timeout := option.Timeout
	if timeout == 0 {
		timeout = DefaultNavigationTimeout
	}
	if option.URL != "" && (timeout < time.Millisecond || timeout > 120*time.Second) {
		return nil, errors.New("navigation timeout must be between 1ms and 120s")
	}
	budget := b.Client.options.Timeout
	if option.URL != "" {
		budget = timeout + time.Second
	}
	result, err := b.Client.requestInScope("createTab", createTabParams(option.BackgroundWindow), budget, func(metadata Params, deadline time.Time) (any, error) {
		reserve := time.Duration(0)
		if option.URL != "" {
			reserve = time.Second
		}
		created, err := b.Client.requestLocked("createTab", metadata, deadline, reserve)
		if err != nil || option.URL == "" {
			return created, err
		}
		tabID, err := tabIDFromValue(created, "createTab response")
		if err != nil {
			return nil, err
		}
		args := Params{"url": option.URL}
		if option.WaitUntil != "" {
			args["waitUntil"] = option.WaitUntil
		}
		navigated, err := b.Client.requestLocked("browserAction", scopedParams(metadata, Params{
			"tabId": tabID, "action": "goto", "args": args, "timeoutMs": timeout.Milliseconds(),
		}), deadline)
		if err != nil {
			return nil, err
		}
		if _, err := decodeBrowserActionResult(navigated); err != nil {
			return nil, err
		}
		return created, nil
	})
	if err != nil {
		return nil, err
	}
	tabID, err := tabIDFromValue(result, "createTab response")
	if err != nil {
		return nil, err
	}
	return b.Tab(tabID), nil
}

func (b *Browser) Tab(tabID int) *Tab {
	tab := &Tab{Browser: b, ID: tabID}
	tab.initPlaywright()
	return tab
}

func (b *Browser) GetTabs() (any, error) {
	return b.Client.GetTabs()
}

type Tab struct {
	Browser    *Browser
	ID         int
	Playwright *TabPlaywright
	Mouse      *BrowserMouse
	Keyboard   *BrowserKeyboard
}

func (t *Tab) Goto(url string, options ...GotoOptions) (any, error) {
	option := GotoOptions{}
	if len(options) > 0 {
		option = options[0]
	}
	args := Params{"url": url}
	if option.WaitUntil != "" {
		args["waitUntil"] = option.WaitUntil
	}
	return t.Action("goto", BrowserActionOptions{Args: args, Timeout: option.Timeout})
}

func (t *Tab) WaitForLoadState(options ...WaitForLoadStateOptions) error {
	option := WaitForLoadStateOptions{}
	if len(options) > 0 {
		option = options[0]
	}
	args := Params{}
	if option.State != "" {
		args["state"] = option.State
	}
	_, err := t.Action("waitForLoadState", BrowserActionOptions{Args: args, Timeout: option.Timeout})
	return err
}

func (t *Tab) DOMSnapshot() (string, error) {
	return actionString(t.Action("snapshot", BrowserActionOptions{}))
}

func (t *Tab) Evaluate(expression string, awaitPromise ...bool) (any, error) {
	option := EvaluateOptions{}
	if len(awaitPromise) > 0 {
		option.AwaitPromise = &awaitPromise[0]
	}
	return t.Browser.CDP.Evaluate(t.ID, expression, option)
}

func (t *Tab) Title() (string, error) {
	value, err := t.Evaluate("document.title ?? ''")
	if err != nil {
		return "", err
	}
	return fmt.Sprint(value), nil
}

func (t *Tab) URL() (string, error) {
	value, err := t.Evaluate("location.href")
	if err != nil {
		return "", err
	}
	return fmt.Sprint(value), nil
}

func (t *Tab) WaitForTimeout(timeout time.Duration) error {
	if timeout < 0 {
		return errors.New("timeout must be non-negative")
	}
	time.Sleep(timeout)
	return nil
}

func (t *Tab) Locator(selector string) *Locator {
	return &Locator{Tab: t, Selector: selector}
}

func (t *Tab) Close() (any, error) {
	return t.Browser.CDP.Call(t.ID, "Page.close", nil, CDPCallOptions{})
}

type TabPlaywright struct {
	tab *Tab
}

func (t *Tab) initPlaywright() {
	if t.Playwright == nil {
		t.Playwright = &TabPlaywright{}
	}
	t.Playwright.tab = t
	t.Mouse = &BrowserMouse{tab: t}
	t.Keyboard = &BrowserKeyboard{tab: t}
}

func (p *TabPlaywright) WaitForLoadState(options ...WaitForLoadStateOptions) error {
	return p.tab.WaitForLoadState(options...)
}

func (p *TabPlaywright) DOMSnapshot() (string, error) {
	return p.tab.DOMSnapshot()
}

func (p *TabPlaywright) Title() (string, error) {
	return p.tab.Title()
}

func (p *TabPlaywright) URL() (string, error) {
	return p.tab.URL()
}

func (p *TabPlaywright) WaitForTimeout(timeout time.Duration) error {
	return p.tab.WaitForTimeout(timeout)
}

func (p *TabPlaywright) Locator(selector string) *Locator {
	return p.tab.Locator(selector)
}

type CDP struct {
	client *Client
}

func NewCDP(client *Client) *CDP {
	return &CDP{client: client}
}

type CDPCallOptions struct {
	Timeout time.Duration
}

type EvaluateOptions struct {
	AwaitPromise *bool
}

type GotoOptions struct {
	URL       string
	WaitUntil string
	Timeout   time.Duration
}

type WaitForLoadStateOptions struct {
	State   string
	Timeout time.Duration
}

func (c *CDP) Call(tabID int, method string, commandParams Params, options CDPCallOptions) (any, error) {
	params := Params{
		"target":        Params{"tabId": tabID},
		"method":        method,
		"commandParams": commandParams,
	}
	if options.Timeout > 0 {
		params["timeoutMs"] = int(options.Timeout / time.Millisecond)
	}
	return c.client.requestWithPreparation("executeCdp", params, c.client.options.Timeout, func(metadata Params, deadline time.Time) error {
		// Timeouts and browser/user actions can detach behind this client. Keep
		// idempotent attach and the command in the same captured turn and gate;
		// do not retry executeCdp if attachment changes again.
		attach := Params{"tabId": tabID, "session_id": metadata["session_id"], "turn_id": metadata["turn_id"]}
		if epoch, ok := metadata["control_epoch"]; ok {
			attach["control_epoch"] = epoch
		}
		_, err := c.client.requestLocked("attach", attach, deadline)
		return err
	})
}

func (c *CDP) Evaluate(tabID int, expression string, options EvaluateOptions) (any, error) {
	commandParams := Params{
		"expression":    expression,
		"returnByValue": true,
	}
	if options.AwaitPromise != nil {
		commandParams["awaitPromise"] = *options.AwaitPromise
	}
	result, err := c.Call(tabID, "Runtime.evaluate", commandParams, CDPCallOptions{})
	if err != nil {
		return nil, err
	}
	resultMap, ok := result.(map[string]any)
	if !ok {
		return nil, nil
	}
	if exception, ok := resultMap["exceptionDetails"].(map[string]any); ok {
		if text, ok := exception["text"].(string); ok && text != "" {
			return nil, errors.New(text)
		}
		return nil, errors.New("Open Browser Use evaluation failed")
	}
	remoteObject, ok := resultMap["result"].(map[string]any)
	if !ok {
		return nil, nil
	}
	return remoteObject["value"], nil
}

func (c *CDP) Navigate(tabID int, url string, options GotoOptions) (any, error) {
	if url == "" {
		return nil, errors.New("goto requires a URL")
	}
	waitUntil := options.WaitUntil
	if waitUntil == "" {
		waitUntil = LoadStateLoad
	}
	if err := assertSupportedLoadState(waitUntil); err != nil {
		return nil, err
	}
	timeout := options.Timeout
	if timeout == 0 {
		timeout = DefaultNavigationTimeout
	}
	return c.client.requestInScope("executeCdp", nil, timeout, func(metadata Params, deadline time.Time) (any, error) {
		if _, err := c.client.requestLocked("attach", scopedParams(metadata, Params{"tabId": tabID}), deadline); err != nil {
			return nil, err
		}
		if _, err := c.callScoped(tabID, "Page.enable", nil, metadata, deadline); err != nil {
			return nil, err
		}
		result, err := c.callScoped(tabID, "Page.navigate", Params{"url": url}, metadata, deadline)
		if err != nil {
			return nil, err
		}
		loaderID := ""
		if resultMap, ok := result.(map[string]any); ok {
			if errorText, ok := resultMap["errorText"].(string); ok && errorText != "" {
				return nil, fmt.Errorf("browser failed to navigate tab %d: %s", tabID, errorText)
			}
			loaderID, _ = resultMap["loaderId"].(string)
		}
		if err := c.waitForLoadStateScoped(tabID, waitUntil, loaderID, metadata, deadline); err != nil {
			return nil, err
		}
		return result, nil
	})
}

func (c *CDP) WaitForLoadState(tabID int, options WaitForLoadStateOptions) error {
	state := options.State
	if state == "" {
		state = LoadStateLoad
	}
	if err := assertSupportedLoadState(state); err != nil {
		return err
	}
	timeout := options.Timeout
	if timeout == 0 {
		timeout = DefaultNavigationTimeout
	}
	_, err := c.client.requestInScope("executeCdp", nil, timeout, func(metadata Params, deadline time.Time) (any, error) {
		if _, err := c.client.requestLocked("attach", scopedParams(metadata, Params{"tabId": tabID}), deadline); err != nil {
			return nil, err
		}
		return nil, c.waitForLoadStateScoped(tabID, state, "", metadata, deadline)
	})
	return err
}

func (c *CDP) callScoped(tabID int, method string, params Params, metadata Params, deadline time.Time) (any, error) {
	return c.client.requestLocked("executeCdp", scopedParams(metadata, Params{
		"target": Params{"tabId": tabID}, "method": method, "commandParams": params,
	}), deadline)
}

func (c *CDP) waitForLoadStateScoped(tabID int, state, loaderID string, metadata Params, deadline time.Time) error {
	sameLoader := func() (bool, error) {
		if loaderID == "" {
			return true, nil
		}
		tree, err := c.callScoped(tabID, "Page.getFrameTree", nil, metadata, deadline)
		if err != nil {
			return false, err
		}
		result, _ := tree.(map[string]any)
		frameTree, _ := result["frameTree"].(map[string]any)
		frame, _ := frameTree["frame"].(map[string]any)
		return frame["loaderId"] == loaderID, nil
	}
	pause := func() error {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return fmt.Errorf("timed out waiting for %s in tab %d", state, tabID)
		}
		if remaining > 100*time.Millisecond {
			remaining = 100 * time.Millisecond
		}
		time.Sleep(remaining)
		return nil
	}
	for {
		matched, err := sameLoader()
		if err != nil {
			return err
		}
		if !matched {
			if err := pause(); err != nil {
				return err
			}
			continue
		}
		result, err := c.callScoped(tabID, "Runtime.evaluate", Params{
			"expression": "({ href: window.location.href, readyState: document.readyState })", "returnByValue": true,
		}, metadata, deadline)
		if err != nil {
			return err
		}
		response, _ := result.(map[string]any)
		remote, _ := response["result"].(map[string]any)
		documentState, _ := remote["value"].(map[string]any)
		loaded := documentStateMatches(documentState, state)
		if loaded && loaderID != "" {
			// A complete old document must not satisfy a newly issued navigation.
			loaded, err = sameLoader()
			if err != nil {
				return err
			}
		}
		if loaded {
			return nil
		}
		if err := pause(); err != nil {
			return err
		}
	}
}

func (c *CDP) ReadDocumentState(tabID int) (map[string]any, error) {
	value, err := c.Evaluate(tabID, "({ href: window.location.href, readyState: document.readyState })", EvaluateOptions{})
	if err != nil {
		return nil, err
	}
	if result, ok := value.(map[string]any); ok {
		return result, nil
	}
	return nil, nil
}

func (c *CDP) EnsureAttached(tabID int) error {
	if _, err := c.client.Attach(tabID); err != nil {
		return err
	}
	return nil
}

func tabIDFromValue(value any, label string) (int, error) {
	result, ok := value.(map[string]any)
	if !ok {
		return 0, fmt.Errorf("%s did not include a tab object", label)
	}
	switch id := result["id"].(type) {
	case float64:
		if id > 0 && id == float64(int(id)) {
			return int(id), nil
		}
	case int:
		if id > 0 {
			return id, nil
		}
	case string:
		parsed, err := strconv.Atoi(id)
		if err == nil && parsed > 0 {
			return parsed, nil
		}
	}
	return 0, fmt.Errorf("%s did not include a numeric tab id", label)
}

func assertSupportedLoadState(state string) error {
	if state != LoadStateDOMContentLoaded && state != LoadStateLoad {
		return fmt.Errorf("unsupported load state %q. Use %q or %q", state, LoadStateDOMContentLoaded, LoadStateLoad)
	}
	return nil
}

func documentStateMatches(documentState map[string]any, state string) bool {
	readyState, _ := documentState["readyState"].(string)
	return readyState == "complete" || (state == LoadStateDOMContentLoaded && readyState == "interactive")
}
