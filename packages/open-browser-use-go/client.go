package obu

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"os"
	"sync"
	"time"

	"github.com/ifuryst/open-browser-use/internal/host"
	"github.com/ifuryst/open-browser-use/internal/transport"
	"github.com/ifuryst/open-browser-use/internal/wire"
)

const (
	DefaultSessionID          = "open-browser-use-go"
	DefaultTimeout            = 10 * time.Second
	DefaultNavigationTimeout  = 10 * time.Second
	LoadStateDOMContentLoaded = "domcontentloaded"
	LoadStateLoad             = "load"
)

type Params map[string]any

type Options struct {
	SocketPath string
	SocketDir  string
	SessionID  string
	TurnID     string
	Timeout    time.Duration
}

type Notification struct {
	Method string `json:"method"`
	Params any    `json:"params,omitempty"`
}

type NotificationHandler func(Notification)

type notificationSubscription struct {
	id      uint64
	handler NotificationHandler
}

type Client struct {
	options Options

	mu                   requestLock
	conn                 net.Conn
	nextID               int64
	controlMu            sync.Mutex
	control              clientControlState
	networkWaitKnown     bool
	networkWaitVersion   any
	notificationMu       sync.Mutex
	nextHandlerID        uint64
	notificationHandlers []notificationSubscription
}

func NewClient(options Options) *Client {
	if options.SessionID == "" {
		options.SessionID = DefaultSessionID
	}
	if options.TurnID == "" {
		options.TurnID = fmt.Sprintf("turn-%d", time.Now().UnixNano())
	}
	if options.Timeout == 0 {
		options.Timeout = DefaultTimeout
	}
	return &Client{options: options, mu: requestLock{gate: make(chan struct{}, 1)}, control: clientControlState{version: -1, turnID: options.TurnID}}
}

func (c *Client) Connect() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.connectLocked()
}

func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return nil
	}
	err := c.conn.Close()
	c.conn = nil
	return err
}

func (c *Client) OnNotification(handler NotificationHandler) func() {
	c.notificationMu.Lock()
	c.nextHandlerID++
	id := c.nextHandlerID
	c.notificationHandlers = append(c.notificationHandlers, notificationSubscription{id: id, handler: handler})
	c.notificationMu.Unlock()
	return func() {
		c.notificationMu.Lock()
		defer c.notificationMu.Unlock()
		for i, candidate := range c.notificationHandlers {
			if candidate.id == id {
				c.notificationHandlers = append(c.notificationHandlers[:i], c.notificationHandlers[i+1:]...)
				return
			}
		}
	}
}

func (c *Client) Request(method string, params Params) (any, error) {
	return c.requestWithTimeout(method, params, c.options.Timeout)
}

func (c *Client) requestWithTimeout(method string, params Params, timeout time.Duration) (any, error) {
	return c.requestWithPreparation(method, params, timeout, nil)
}

func (c *Client) requestWithPreparation(method string, params Params, timeout time.Duration, prepare func(Params, time.Time) error) (any, error) {
	return c.requestInScope(method, params, timeout, func(merged Params, deadline time.Time) (any, error) {
		if prepare != nil {
			if err := prepare(merged, deadline); err != nil {
				return nil, err
			}
		}
		return c.requestLocked(method, merged, deadline)
	})
}

// Multi-stage helpers hold one request gate, captured turn and original deadline.
// Every stage sends that binding; no subsequent stage adopts a newer turn.
func (c *Client) requestInScope(method string, params Params, timeout time.Duration, execute func(Params, time.Time) (any, error)) (any, error) {
	if timeout <= 0 {
		return nil, errors.New("request timeout must be positive")
	}
	submittedAt := time.Now()
	deadline := submittedAt.Add(timeout)
	c.controlMu.Lock()
	control := c.control
	c.controlMu.Unlock()
	// Freeze nested locator/argument values at invocation, before waiting for
	// discovery or another request. Mutating a caller map cannot retarget input.
	encodedParams, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	var frozenParams Params
	if err := json.Unmarshal(encodedParams, &frozenParams); err != nil {
		return nil, err
	}
	if method == "browserAction" || method == "waitForFileChooser" || method == "waitForDownload" || method == "armNetworkWait" {
		requested := float64(10000)
		valid := true
		if value, exists := frozenParams["timeoutMs"]; exists {
			requested, valid = value.(float64)
		}
		if valid && requested >= 1 && requested <= 120000 {
			operationDeadline := submittedAt.Add(time.Duration(requested*float64(time.Millisecond)) + time.Second)
			if operationDeadline.Before(deadline) {
				deadline = operationDeadline
			}
		}
	}
	merged := Params{"session_id": c.options.SessionID, "turn_id": control.turnID}
	for key, value := range frozenParams {
		merged[key] = value
	}
	if err := c.mu.lockUntil(deadline); err != nil {
		return nil, err
	}
	defer c.mu.Unlock()
	_, manualEpoch := merged["control_epoch"]
	if !controlDiscoveryMethod(method) && !manualEpoch {
		if merged["session_id"] != c.options.SessionID || merged["turn_id"] != control.turnID {
			return nil, errors.New("use a separate client or explicit control_epoch for another session or turn")
		}
		c.controlMu.Lock()
		current := c.control
		c.controlMu.Unlock()
		if current.generation != control.generation {
			return nil, errors.New("request belonged to an ended turn; submit new work explicitly")
		}
		// Another queued request may have completed the initial handshake. It
		// cannot rebind this request across an end or explicit BeginTurn.
		control = current
		if control.version < 0 {
			info, err := c.requestLocked("getInfo", Params{"session_id": c.options.SessionID, "turn_id": control.turnID}, deadline)
			if err != nil {
				return nil, err
			}
			if err := c.observeControlSupport(info); err != nil {
				return nil, err
			}
			c.controlMu.Lock()
			control = c.control
			c.controlMu.Unlock()
		}
		if control.version == 1 {
			if control.epoch == 0 {
				state, err := c.requestLocked("getControlState", Params{"session_id": c.options.SessionID, "turn_id": control.turnID}, deadline)
				if err != nil {
					return nil, err
				}
				epoch, _, err := validateControlState(state)
				if err != nil {
					return nil, err
				}
				control.epoch = epoch
				c.controlMu.Lock()
				c.control.epoch = epoch
				c.controlMu.Unlock()
			}
			merged["control_epoch"] = control.epoch
		}
	}
	if isNetworkWaitMethod(method) {
		c.controlMu.Lock()
		known := c.networkWaitKnown
		c.controlMu.Unlock()
		if !known {
			info, err := c.requestLocked("getInfo", scopedParams(merged, nil), deadline)
			if err != nil {
				return nil, err
			}
			if err := c.observeControlSupport(info); err != nil {
				return nil, err
			}
		}
		c.controlMu.Lock()
		supported := c.networkWaitVersion == float64(1)
		c.controlMu.Unlock()
		if !supported {
			return nil, errors.New("OBU_NETWORK_WAIT_UNSUPPORTED: extension does not advertise networkWaitVersion 1")
		}
	}
	result, err := execute(merged, deadline)
	if err != nil {
		return nil, err
	}
	if method == "getInfo" {
		if err := c.observeControlSupport(result); err != nil {
			return nil, err
		}
	}
	if (method == "turnEnded" || method == "finalizeTabs") && !manualEpoch && control.version == 1 {
		epoch, turnID, err := validateControlState(result)
		if err != nil {
			return nil, err
		}
		if epoch <= control.epoch {
			return nil, errors.New("end response did not advance the control epoch; explicitly begin a new turn")
		}
		c.controlMu.Lock()
		if c.control.generation == control.generation && c.control.epoch == control.epoch {
			c.control.epoch, c.control.turnID = epoch, turnID
			c.control.generation++
		}
		c.controlMu.Unlock()
	}
	return result, nil
}

func scopedParams(metadata Params, params Params) Params {
	result := Params{}
	for key, value := range params {
		result[key] = value
	}
	for _, key := range []string{"session_id", "turn_id", "control_epoch"} {
		if value, ok := metadata[key]; ok {
			result[key] = value
		}
	}
	return result
}

// requestLocked performs one wire exchange under c.mu. Discovery shares the
// original request deadline, and no failing operation is replayed.
func (c *Client) requestLocked(method string, merged Params, deadline time.Time, responseReserve ...time.Duration) (any, error) {
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return nil, os.ErrDeadlineExceeded
	}
	if err := c.connectWithTimeoutLocked(remaining); err != nil {
		return nil, err
	}
	if len(responseReserve) > 0 && time.Until(deadline) <= responseReserve[0] {
		return nil, fmt.Errorf("%s deadline expired during discovery or connection; request was not sent", method)
	}
	if method == "browserAction" || method == "waitForFileChooser" || method == "waitForDownload" || method == "armNetworkWait" {
		requested := int64(10000)
		valid := true
		switch value := merged["timeoutMs"].(type) {
		case nil:
			if _, exists := merged["timeoutMs"]; method == "armNetworkWait" && exists {
				valid = false
			}
		case int64:
			requested = value
		case int:
			requested = int64(value)
		case float64:
			valid = value >= 1 && value <= 120000
			if method == "armNetworkWait" {
				valid = valid && value == math.Trunc(value)
			}
			if valid {
				requested = int64(value)
			}
		default:
			valid = false
		}
		if method == "armNetworkWait" && (!valid || requested < 1 || requested > 120000) {
			return nil, errors.New("armNetworkWait timeoutMs must be an integer from 1 to 120000")
		}
		if valid && requested >= 1 && requested <= 120000 {
			available := (time.Until(deadline) - time.Second).Milliseconds()
			if available < 1 {
				return nil, fmt.Errorf("%s deadline expired during discovery or connection; request was not sent", method)
			}
			if available < requested {
				merged["timeoutMs"] = available
			}
		}
	}
	responseComplete := false
	defer func() {
		if !responseComplete {
			// A partial frame or late response cannot be reused safely. Never
			// replay the request: the browser may already have acted on it.
			_ = c.conn.Close()
			c.conn = nil
		}
	}()
	c.nextID++
	requestID := c.nextID
	request := map[string]any{
		"jsonrpc": "2.0",
		"id":      requestID,
		"method":  method,
		"params":  merged,
	}
	if err := c.conn.SetDeadline(deadline); err != nil {
		return nil, err
	}
	if err := wire.WriteJSON(c.conn, request); err != nil {
		return nil, err
	}
	for {
		var response rpcMessage
		if err := wire.ReadJSON(c.conn, &response); err != nil {
			return nil, err
		}
		if response.ID != nil && idMatches(response.ID, requestID) {
			responseComplete = true
			if response.Error != nil {
				if response.Error.Message != "" {
					return nil, errors.New(response.Error.Message)
				}
				return nil, errors.New("Open Browser Use request failed")
			}
			return response.Result, nil
		}
		if response.ID == nil && response.Method != "" {
			c.dispatchNotificationLocked(Notification{
				Method: response.Method,
				Params: response.Params,
			})
			continue
		}
		return nil, fmt.Errorf("unexpected response id: %v", response.ID)
	}
}

func (c *Client) GetInfo() (any, error) {
	return c.Request("getInfo", nil)
}

func (c *Client) CreateTab() (any, error) {
	return c.Request("createTab", nil)
}

func (c *Client) GetTabs() (any, error) {
	return c.Request("getTabs", nil)
}

func (c *Client) GetUserTabs() (any, error) {
	return c.Request("getUserTabs", nil)
}

func (c *Client) GetUserHistory(params Params) (any, error) {
	return c.Request("getUserHistory", params)
}

func (c *Client) ClaimUserTab(tabID int) (any, error) {
	return c.Request("claimUserTab", Params{"tabId": tabID})
}

func (c *Client) FinalizeTabs(keep []Params) (any, error) {
	if keep == nil {
		keep = []Params{}
	}
	return c.Request("finalizeTabs", Params{"keep": keep})
}

func (c *Client) NameSession(name string) (any, error) {
	return c.Request("nameSession", Params{"name": name})
}

func (c *Client) Attach(tabID int) (any, error) {
	return c.Request("attach", Params{"tabId": tabID})
}

func (c *Client) Detach(tabID int) (any, error) {
	return c.Request("detach", Params{"tabId": tabID})
}

func (c *Client) ExecuteCDP(tabID int, method string, commandParams Params) (any, error) {
	return c.Request("executeCdp", Params{
		"target":        Params{"tabId": tabID},
		"method":        method,
		"commandParams": commandParams,
	})
}

func (c *Client) MoveMouse(tabID int, x float64, y float64, waitForArrival bool) (any, error) {
	return c.Request("moveMouse", Params{
		"tabId":          tabID,
		"x":              x,
		"y":              y,
		"waitForArrival": waitForArrival,
	})
}

func (c *Client) WaitForFileChooser(tabID int, timeoutMs int) (any, error) {
	return c.waitForTabEvent("waitForFileChooser", tabID, timeoutMs)
}

// A zero timeout selects the default 10s wait. Discovery and queue time count
// toward the same deadline; the transport allows another second for the reply.
func (c *Client) waitForTabEvent(method string, tabID int, timeoutMs int) (any, error) {
	if timeoutMs == 0 {
		timeoutMs = 10000
	}
	if timeoutMs < 1 || timeoutMs > 120000 {
		return nil, errors.New("event wait timeout must be between 1 and 120000 milliseconds")
	}
	budget := time.Duration(timeoutMs)*time.Millisecond + time.Second
	return c.requestWithTimeout(method, Params{"tabId": tabID, "timeoutMs": timeoutMs}, budget)
}

func (c *Client) SetFileChooserFiles(fileChooserID string, files []string) (any, error) {
	if files == nil {
		files = []string{}
	}
	return c.Request("setFileChooserFiles", Params{"fileChooserId": fileChooserID, "files": files})
}

func (c *Client) WaitForDownload(tabID int, timeoutMs int) (any, error) {
	return c.waitForTabEvent("waitForDownload", tabID, timeoutMs)
}

func (c *Client) DownloadPath(downloadID string, timeoutMs int) (any, error) {
	params := Params{"downloadId": downloadID}
	if timeoutMs > 0 {
		params["timeoutMs"] = timeoutMs
	}
	return c.Request("downloadPath", params)
}

func (c *Client) BrowserUserHistory(params Params) (any, error) {
	return c.GetUserHistory(params)
}

func (c *Client) ReadClipboardText(tabID int) (any, error) {
	return c.Request("readClipboardText", Params{"tabId": tabID})
}

func (c *Client) WriteClipboardText(tabID int, text string) (any, error) {
	return c.Request("writeClipboardText", Params{"tabId": tabID, "text": text})
}

func (c *Client) ReadClipboard(tabID int) (any, error) {
	return c.Request("readClipboard", Params{"tabId": tabID})
}

func (c *Client) WriteClipboard(tabID int, items []Params) (any, error) {
	return c.Request("writeClipboard", Params{"tabId": tabID, "items": items})
}

func (c *Client) TurnEnded() (any, error) {
	return c.Request("turnEnded", nil)
}

func ActiveSocketPath(socketDir string) (string, error) {
	record, err := host.ReadActiveSocketRecord(socketDir)
	if err != nil {
		return "", err
	}
	return record.SocketPath, nil
}

func ConnectOpenBrowserUse(options Options) (*Browser, error) {
	browser := NewBrowser(NewClient(options))
	if err := browser.Connect(); err != nil {
		return nil, err
	}
	return browser, nil
}

func ConnectActive(options Options) (*Browser, error) {
	if options.SocketPath == "" {
		socketPath, err := ActiveSocketPath(options.SocketDir)
		if err != nil {
			return nil, err
		}
		options.SocketPath = socketPath
	}
	return ConnectOpenBrowserUse(options)
}

func EncodeFrame(value any) ([]byte, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	frame := make([]byte, wire.HeaderBytes+len(payload))
	wire.NativeEndian().PutUint32(frame[:wire.HeaderBytes], uint32(len(payload)))
	copy(frame[wire.HeaderBytes:], payload)
	return frame, nil
}

func (c *Client) connectLocked() error {
	return c.connectWithTimeoutLocked(c.options.Timeout)
}

func (c *Client) connectWithTimeoutLocked(timeout time.Duration) error {
	if c.conn != nil {
		return nil
	}
	socketPath := c.options.SocketPath
	if socketPath == "" {
		record, err := host.ReadActiveSocketRecord(c.options.SocketDir)
		if err != nil {
			return err
		}
		socketPath = record.SocketPath
	}
	conn, err := transport.DialTimeout(socketPath, timeout)
	if err != nil {
		return err
	}
	c.conn = conn
	return nil
}

func (c *Client) dispatchNotificationLocked(notification Notification) {
	c.notificationMu.Lock()
	handlers := append([]notificationSubscription(nil), c.notificationHandlers...)
	c.notificationMu.Unlock()
	for _, subscription := range handlers {
		subscription.handler(notification)
	}
}

type rpcMessage struct {
	ID     any       `json:"id,omitempty"`
	Method string    `json:"method,omitempty"`
	Params any       `json:"params,omitempty"`
	Result any       `json:"result,omitempty"`
	Error  *rpcError `json:"error,omitempty"`
}

type rpcError struct {
	Message string `json:"message,omitempty"`
}

func idMatches(id any, expected int64) bool {
	switch value := id.(type) {
	case float64:
		return int64(value) == expected
	case string:
		return value == fmt.Sprintf("%d", expected)
	default:
		return false
	}
}
