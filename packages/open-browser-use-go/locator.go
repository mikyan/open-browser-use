package obu

import (
	"errors"
	"fmt"
	"time"
)

// Locator is an immutable chain evaluated by the extension's Playwright engine.
// Tab and Selector remain available for compatibility with CSS locator literals.
// Invalid chains and unsupported action options fail before browser execution.
type Locator struct {
	Tab      *Tab
	Selector string
	steps    []Params
	err      error
}

type TextOptions struct{ Exact bool }
type RoleOptions struct {
	Name  string
	Exact bool
}
type FilterOptions struct {
	HasText    string
	HasNotText string
	Has        *Locator
	HasNot     *Locator
	Visible    *bool
}

// Action exposes the finite engine protocol and unwraps its value. Use
// Client.BrowserAction when engine version metadata is also needed.
func (t *Tab) Action(action string, options BrowserActionOptions) (any, error) {
	result, err := t.Browser.Client.BrowserAction(t.ID, action, options)
	return result.Value, err
}

func (t *Tab) FrameLocator(selector string) *Locator {
	return (&Locator{Tab: t}).FrameLocator(selector)
}
func (t *Tab) GetByRole(role string, options ...RoleOptions) *Locator {
	return (&Locator{Tab: t}).GetByRole(role, options...)
}
func (t *Tab) GetByText(value string, options ...TextOptions) *Locator {
	return (&Locator{Tab: t}).GetByText(value, options...)
}
func (t *Tab) GetByLabel(value string, options ...TextOptions) *Locator {
	return (&Locator{Tab: t}).GetByLabel(value, options...)
}
func (t *Tab) GetByPlaceholder(value string, options ...TextOptions) *Locator {
	return (&Locator{Tab: t}).GetByPlaceholder(value, options...)
}
func (t *Tab) GetByAltText(value string, options ...TextOptions) *Locator {
	return (&Locator{Tab: t}).GetByAltText(value, options...)
}
func (t *Tab) GetByTitle(value string, options ...TextOptions) *Locator {
	return (&Locator{Tab: t}).GetByTitle(value, options...)
}
func (t *Tab) GetByTestID(value string) *Locator { return (&Locator{Tab: t}).GetByTestID(value) }

func (p *TabPlaywright) FrameLocator(selector string) *Locator { return p.tab.FrameLocator(selector) }
func (p *TabPlaywright) GetByRole(role string, options ...RoleOptions) *Locator {
	return p.tab.GetByRole(role, options...)
}
func (p *TabPlaywright) GetByText(value string, options ...TextOptions) *Locator {
	return p.tab.GetByText(value, options...)
}
func (p *TabPlaywright) GetByLabel(value string, options ...TextOptions) *Locator {
	return p.tab.GetByLabel(value, options...)
}
func (p *TabPlaywright) GetByPlaceholder(value string, options ...TextOptions) *Locator {
	return p.tab.GetByPlaceholder(value, options...)
}
func (p *TabPlaywright) GetByAltText(value string, options ...TextOptions) *Locator {
	return p.tab.GetByAltText(value, options...)
}
func (p *TabPlaywright) GetByTitle(value string, options ...TextOptions) *Locator {
	return p.tab.GetByTitle(value, options...)
}
func (p *TabPlaywright) GetByTestID(value string) *Locator { return p.tab.GetByTestID(value) }

func (l *Locator) chain(step Params) *Locator {
	if l.err != nil {
		return &Locator{Tab: l.Tab, err: l.err}
	}
	for _, existing := range l.locatorSteps() {
		if existing["kind"] == "ref" {
			return &Locator{Tab: l.Tab, err: errors.New("ref locators cannot be chained")}
		}
	}
	steps, err := copyLocatorSteps(append(append([]Params(nil), l.locatorSteps()...), step), false)
	return &Locator{Tab: l.Tab, steps: steps, err: err}
}
func (l *Locator) locatorSteps() []Params {
	if l.steps != nil {
		return l.steps
	}
	if l.Selector != "" {
		return []Params{{"kind": "css", "selector": l.Selector}}
	}
	return nil
}
func (l *Locator) Locator(selector string) *Locator {
	return l.chain(Params{"kind": "css", "selector": selector})
}
func (l *Locator) FrameLocator(selector string) *Locator {
	return l.chain(Params{"kind": "frame", "selector": selector})
}
func (l *Locator) GetByRole(role string, options ...RoleOptions) *Locator {
	step := Params{"kind": "role", "role": role}
	if len(options) > 0 {
		step["name"] = options[0].Name
		step["exact"] = options[0].Exact
	}
	return l.chain(step)
}
func (l *Locator) textLocator(kind, value string, options []TextOptions) *Locator {
	step := Params{"kind": kind, "value": value}
	if len(options) > 0 {
		step["exact"] = options[0].Exact
	}
	return l.chain(step)
}
func (l *Locator) GetByText(value string, options ...TextOptions) *Locator {
	return l.textLocator("text", value, options)
}
func (l *Locator) GetByLabel(value string, options ...TextOptions) *Locator {
	return l.textLocator("label", value, options)
}
func (l *Locator) GetByPlaceholder(value string, options ...TextOptions) *Locator {
	return l.textLocator("placeholder", value, options)
}
func (l *Locator) GetByAltText(value string, options ...TextOptions) *Locator {
	return l.textLocator("altText", value, options)
}
func (l *Locator) GetByTitle(value string, options ...TextOptions) *Locator {
	return l.textLocator("title", value, options)
}
func (l *Locator) GetByTestID(value string) *Locator { return l.textLocator("testId", value, nil) }
func (l *Locator) First() *Locator                   { return l.chain(Params{"kind": "first"}) }
func (l *Locator) Last() *Locator                    { return l.chain(Params{"kind": "last"}) }
func (l *Locator) Nth(index int) *Locator            { return l.chain(Params{"kind": "nth", "index": index}) }
func (l *Locator) Filter(options FilterOptions) *Locator {
	step := Params{"kind": "filter"}
	if options.HasText != "" {
		step["hasText"] = options.HasText
	}
	if options.HasNotText != "" {
		step["hasNotText"] = options.HasNotText
	}
	if options.Visible != nil {
		step["visible"] = *options.Visible
	}
	for key, other := range map[string]*Locator{"has": options.Has, "hasNot": options.HasNot} {
		if other == nil {
			continue
		}
		steps, err := l.operand(other, true)
		if err != nil {
			return &Locator{Tab: l.Tab, err: err}
		}
		step[key] = steps
	}
	return l.chain(step)
}

func (l *Locator) Action(action string, options BrowserActionOptions) (any, error) {
	if l.err != nil {
		return nil, l.err
	}
	if l.Tab == nil {
		return nil, errors.New("locator requires a tab")
	}
	var err error
	options.Locator, err = copyLocatorSteps(l.locatorSteps(), false)
	if err != nil {
		return nil, err
	}
	if len(options.Locator) == 0 {
		return nil, errors.New("locator requires a selector or semantic chain")
	}
	return l.Tab.Action(action, options)
}

func actionOptions(options []BrowserActionOptions, required Params) BrowserActionOptions {
	result := BrowserActionOptions{}
	if len(options) > 0 {
		result = options[0]
	}
	if required != nil {
		args := Params{}
		for key, value := range result.Args {
			args[key] = value
		}
		for key, value := range required {
			args[key] = value
		}
		result.Args = args
	}
	return result
}
func (l *Locator) perform(action string, args Params, options []BrowserActionOptions) error {
	_, err := l.Action(action, actionOptions(options, args))
	return err
}
func (l *Locator) Click(options ...BrowserActionOptions) error {
	return l.perform("click", nil, options)
}
func (l *Locator) Dblclick(options ...BrowserActionOptions) error {
	return l.perform("dblclick", nil, options)
}
func (l *Locator) Hover(options ...BrowserActionOptions) error {
	return l.perform("hover", nil, options)
}

func (l *Locator) DragTo(target *Locator, options ...BrowserActionOptions) error {
	if target == nil || l.Tab == nil || target.Tab == nil || l.Tab.ID != target.Tab.ID || l.Tab.Browser.Client != target.Tab.Browser.Client {
		return errors.New("drag target must belong to the same tab and client")
	}
	if target.err != nil {
		return target.err
	}
	if err := combinedLocatorBudget(l.locatorSteps(), target.locatorSteps()); err != nil {
		return err
	}
	return l.perform("dragTo", Params{"target": target.locatorSteps()}, options)
}
func (l *Locator) Focus(options ...BrowserActionOptions) error {
	return l.perform("focus", nil, options)
}
func (l *Locator) ScrollIntoViewIfNeeded(options ...BrowserActionOptions) error {
	return l.perform("scrollIntoViewIfNeeded", nil, options)
}
func (l *Locator) PressSequentially(text string, options ...BrowserActionOptions) error {
	return l.perform("pressSequentially", Params{"text": text}, options)
}

func (t *Tab) navigateHistory(action string, options []GotoOptions) (any, error) {
	option := GotoOptions{}
	if len(options) > 0 {
		option = options[0]
	}
	args := Params{}
	if option.WaitUntil != "" {
		args["waitUntil"] = option.WaitUntil
	}
	return t.Action(action, BrowserActionOptions{Args: args, Timeout: option.Timeout})
}
func (t *Tab) GoBack(options ...GotoOptions) (any, error) {
	return t.navigateHistory("goBack", options)
}
func (t *Tab) GoForward(options ...GotoOptions) (any, error) {
	return t.navigateHistory("goForward", options)
}
func (t *Tab) Reload(options ...GotoOptions) (any, error) {
	return t.navigateHistory("reload", options)
}

type BrowserMouse struct{ tab *Tab }

func (m *BrowserMouse) Move(x, y float64, options ...BrowserActionOptions) error {
	_, err := m.tab.Action("mouse.move", actionOptions(options, Params{"x": x, "y": y}))
	return err
}
func (m *BrowserMouse) Click(x, y float64, options ...BrowserActionOptions) error {
	_, err := m.tab.Action("mouse.click", actionOptions(options, Params{"x": x, "y": y}))
	return err
}
func (m *BrowserMouse) Wheel(deltaX, deltaY float64, options ...BrowserActionOptions) error {
	_, err := m.tab.Action("mouse.wheel", actionOptions(options, Params{"deltaX": deltaX, "deltaY": deltaY}))
	return err
}
func (m *BrowserMouse) Down(options ...BrowserActionOptions) error {
	_, err := m.tab.Action("mouse.down", actionOptions(options, nil))
	return err
}
func (m *BrowserMouse) Up(options ...BrowserActionOptions) error {
	_, err := m.tab.Action("mouse.up", actionOptions(options, nil))
	return err
}

type BrowserKeyboard struct{ tab *Tab }

func (k *BrowserKeyboard) Press(key string, options ...BrowserActionOptions) error {
	_, err := k.tab.Action("keyboard.press", actionOptions(options, Params{"key": key}))
	return err
}
func (k *BrowserKeyboard) Type(text string, options ...BrowserActionOptions) error {
	_, err := k.tab.Action("keyboard.type", actionOptions(options, Params{"text": text}))
	return err
}
func (k *BrowserKeyboard) InsertText(text string, options ...BrowserActionOptions) error {
	_, err := k.tab.Action("keyboard.insertText", actionOptions(options, Params{"text": text}))
	return err
}
func (l *Locator) Fill(value string, options ...BrowserActionOptions) error {
	return l.perform("fill", Params{"value": value}, options)
}
func (l *Locator) Press(key string, options ...BrowserActionOptions) error {
	return l.perform("press", Params{"key": key}, options)
}
func (l *Locator) Check(options ...BrowserActionOptions) error {
	return l.perform("check", nil, options)
}
func (l *Locator) Uncheck(options ...BrowserActionOptions) error {
	return l.perform("uncheck", nil, options)
}
func (l *Locator) SetChecked(checked bool, options ...BrowserActionOptions) error {
	return l.perform("setChecked", Params{"checked": checked}, options)
}
func (l *Locator) WaitFor(state string, options ...BrowserActionOptions) error {
	return l.perform("waitFor", Params{"state": state}, options)
}
func (l *Locator) SelectOption(values any, options ...BrowserActionOptions) ([]string, error) {
	return actionStrings(l.Action("selectOption", actionOptions(options, Params{"values": values})))
}

// InnerText retains its original duration argument and now uses strict,
// auto-waiting engine semantics rather than document.querySelector polling.
func (l *Locator) InnerText(timeout time.Duration) (string, error) {
	return actionString(l.Action("innerText", BrowserActionOptions{Timeout: timeout}))
}
func (l *Locator) InputValue(options ...BrowserActionOptions) (string, error) {
	return actionString(l.Action("inputValue", actionOptions(options, nil)))
}
func (l *Locator) ARIASnapshot(options ...BrowserActionOptions) (string, error) {
	return actionString(l.Action("snapshot", actionOptions(options, nil)))
}
func (l *Locator) TextContent(options ...BrowserActionOptions) (*string, error) {
	return actionNullableString(l.Action("textContent", actionOptions(options, nil)))
}
func (l *Locator) GetAttribute(name string, options ...BrowserActionOptions) (*string, error) {
	return actionNullableString(l.Action("getAttribute", actionOptions(options, Params{"name": name})))
}
func (l *Locator) IsVisible(options ...BrowserActionOptions) (bool, error) {
	return actionBool(l.Action("isVisible", actionOptions(options, nil)))
}
func (l *Locator) IsEnabled(options ...BrowserActionOptions) (bool, error) {
	return actionBool(l.Action("isEnabled", actionOptions(options, nil)))
}
func (l *Locator) IsChecked(options ...BrowserActionOptions) (bool, error) {
	return actionBool(l.Action("isChecked", actionOptions(options, nil)))
}
func (l *Locator) Count() (int, error) {
	value, err := l.Action("count", BrowserActionOptions{})
	if err != nil {
		return 0, err
	}
	n, ok := value.(float64)
	if !ok || n < 0 || n != float64(int(n)) {
		return 0, fmt.Errorf("invalid browser action count: %v", value)
	}
	return int(n), nil
}
func (l *Locator) AllInnerTexts() ([]string, error) {
	return actionStrings(l.Action("allInnerTexts", BrowserActionOptions{}))
}
func (l *Locator) AllTextContents() ([]string, error) {
	return actionStrings(l.Action("allTextContents", BrowserActionOptions{}))
}

type Screenshot struct {
	Base64   string
	MimeType string
}

func actionScreenshot(value any, err error) (Screenshot, error) {
	if err != nil {
		return Screenshot{}, err
	}
	object, ok := value.(map[string]any)
	if !ok {
		return Screenshot{}, errors.New("invalid screenshot response")
	}
	base64, bOK := object["base64"].(string)
	mime, mOK := object["mimeType"].(string)
	if !bOK || !mOK {
		return Screenshot{}, errors.New("invalid screenshot response")
	}
	return Screenshot{Base64: base64, MimeType: mime}, nil
}
func (t *Tab) Screenshot(options ...BrowserActionOptions) (Screenshot, error) {
	return actionScreenshot(t.Action("screenshot", actionOptions(options, nil)))
}
func (l *Locator) Screenshot(options ...BrowserActionOptions) (Screenshot, error) {
	return actionScreenshot(l.Action("screenshot", actionOptions(options, nil)))
}
func (t *Tab) WaitForURL(url string, options ...GotoOptions) error {
	option := GotoOptions{}
	if len(options) > 0 {
		option = options[0]
	}
	args := Params{"url": url}
	if option.WaitUntil != "" {
		args["waitUntil"] = option.WaitUntil
	}
	_, err := t.Action("waitForURL", BrowserActionOptions{Args: args, Timeout: option.Timeout})
	return err
}

func actionString(value any, err error) (string, error) {
	if err != nil {
		return "", err
	}
	text, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("expected string browser action result, got %T", value)
	}
	return text, nil
}
func actionNullableString(value any, err error) (*string, error) {
	if err != nil || value == nil {
		return nil, err
	}
	text, err := actionString(value, nil)
	if err != nil {
		return nil, err
	}
	return &text, nil
}
func actionBool(value any, err error) (bool, error) {
	if err != nil {
		return false, err
	}
	result, ok := value.(bool)
	if !ok {
		return false, fmt.Errorf("expected boolean browser action result, got %T", value)
	}
	return result, nil
}
func actionStrings(value any, err error) ([]string, error) {
	if err != nil {
		return nil, err
	}
	values, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("expected string array browser action result, got %T", value)
	}
	result := make([]string, len(values))
	for i, item := range values {
		text, err := actionString(item, nil)
		if err != nil {
			return nil, err
		}
		result[i] = text
	}
	return result, nil
}
