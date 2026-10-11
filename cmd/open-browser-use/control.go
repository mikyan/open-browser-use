package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"sync"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
	"github.com/spf13/cobra"
)

func newBeginTurnCommand() *cobra.Command {
	var options socketOptions
	command := &cobra.Command{Use: "begin-turn", Short: "Explicitly recover browser control and start a new turn", Args: cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			response, err := newCLIControl(options.sessionID, "").begin(options, nil)
			if err != nil {
				return err
			}
			return writeJSON(response)
		}}
	addSocketFlags(command, &options)
	return command
}

// A submission owns its turn and epoch before waiting for the transport. Ends
// invalidate queued submissions; they never silently move to the next turn.
type cliControlSnapshot struct {
	session, turn            string
	version                  int // -1: unknown, 0: legacy, 1: epoch protocol
	epoch                    int64
	generation               uint64
	deadline                 time.Time // populated only on queued MCP submissions
	networkWaitSupported     bool
	navigationWaitSupported  bool
	downloadWaitSupported    bool
	fileChooserWaitSupported bool
	directDownloadsSupported bool
	mediaDownloadsSupported  bool
	pageExportSupported      bool
	clipboardSupported       bool
}

type cliControl struct {
	mu    sync.Mutex
	gate  chan struct{}
	state cliControlSnapshot
}

func newCLIControl(session, turn string) *cliControl {
	if session == "" {
		session = defaultCLISessionID
	}
	if turn == "" {
		turn = fmt.Sprintf("%s-%d", session, time.Now().UnixNano())
	}
	return &cliControl{gate: make(chan struct{}, 1), state: cliControlSnapshot{session: session, turn: turn, version: -1}}
}

func (control *cliControl) snapshot() cliControlSnapshot {
	control.mu.Lock()
	defer control.mu.Unlock()
	return control.state
}

func cliControlExempt(method string) bool {
	return method == "ping" || method == "getInfo" || method == "getControlState"
}

func copyCLIParams(params map[string]any) (map[string]any, error) {
	if params == nil {
		return map[string]any{}, nil
	}
	bytes, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	var copy map[string]any
	if err := json.Unmarshal(bytes, &copy); err != nil {
		return nil, err
	}
	return copy, nil
}

func (control *cliControl) invoke(options socketOptions, method string, params map[string]any, submitted *cliControlSnapshot) (map[string]any, error) {
	deadline := time.Now().Add(options.timeout)
	captured := control.snapshot()
	if submitted != nil {
		captured = *submitted
	}
	if !captured.deadline.IsZero() {
		deadline = captured.deadline
	}
	if cliClipboardMethod(method) {
		if err := validateClipboardValueUnicode(params); err != nil {
			return nil, err
		}
	}
	if method == "createTab" {
		if err := obu.ValidateCreateTabParams(obu.Params(params)); err != nil {
			return nil, err
		}
	}
	params, err := copyCLIParams(params)
	if err != nil {
		return nil, err
	}
	if method == "exportPage" {
		params, err = validateCLIPageExportParams(params)
		if err != nil {
			return nil, err
		}
	}
	if cliClipboardMethod(method) {
		params, err = validateCLIClipboardParams(method, params)
		if err != nil {
			return nil, err
		}
	}
	if cliActionBudget(method) {
		requested := float64(10_000)
		if value, exists := params["timeoutMs"]; exists {
			requested, _ = value.(float64)
		}
		if requested >= 1 && requested <= 120_000 && math.Trunc(requested) == requested {
			// MCP's captured deadline includes time spent waiting in its stdin
			// queue. Derive the original submission time, not this dispatch time.
			operationDeadline := deadline.Add(-options.timeout).Add(time.Duration(requested)*time.Millisecond + time.Second)
			if operationDeadline.Before(deadline) {
				deadline = operationDeadline
			}
		}
	}
	if _, ok := params["session_id"]; !ok {
		params["session_id"] = captured.session
	}
	if _, ok := params["turn_id"]; !ok {
		params["turn_id"] = captured.turn
	}
	if cliDownloadWaitMethod(method) {
		if err := obu.ValidateDownloadWaitParams(method, obu.Params(params)); err != nil {
			return nil, err
		}
	}
	_, manual := params["control_epoch"]
	if manual {
		if _, ok := cliEpoch(params["control_epoch"]); !ok {
			return nil, errors.New("control_epoch must be a non-negative safe integer")
		}
	} else if !cliControlExempt(method) && (params["session_id"] != captured.session || params["turn_id"] != captured.turn) {
		return nil, errors.New("use a separate client or explicit control_epoch when overriding session_id or turn_id")
	}
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	select {
	case control.gate <- struct{}{}:
	case <-timer.C:
		return nil, errors.New("request timed out waiting for control transport")
	}
	defer func() { <-control.gate }()
	current := control.snapshot()
	if !manual && !cliControlExempt(method) && current.generation != captured.generation {
		return nil, errors.New("OBU_STALE_CONTROL_EPOCH: submitted work belongs to an ended turn; explicitly submit new work")
	}
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return nil, errors.New("request timed out before connecting")
	}
	conn, err := dialCLIControl(options, deadline)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if err := conn.SetDeadline(deadline); err != nil {
		return nil, err
	}
	if !manual && !cliControlExempt(method) {
		// Only initial negotiation can be adopted by concurrent submissions. An
		// end or explicit refresh changes generation and was rejected above.
		if current.version == -1 {
			current, err = negotiateCLIControl(conn, current)
			if err != nil {
				return nil, err
			}
			control.mu.Lock()
			control.state = current
			control.mu.Unlock()
		}
		captured = current
		if captured.version == 1 {
			params["control_epoch"] = captured.epoch
		}
	}
	if method == "createTab" && params["backgroundWindow"] == true {
		response, err := sendCLIRequest(conn, "cli-background-window-info", "getInfo", map[string]any{"session_id": params["session_id"], "turn_id": params["turn_id"]})
		if err != nil {
			return nil, err
		}
		info, err := cliResult(response)
		if err != nil {
			return nil, err
		}
		metadata, _ := info["metadata"].(map[string]any)
		if metadata["backgroundWindowVersion"] != float64(1) {
			return nil, errors.New("OBU_BACKGROUND_WINDOW_UNSUPPORTED: extension does not advertise backgroundWindowVersion 1")
		}
	}
	if cliNetworkWaitMethod(method) {
		if manual {
			// A raw CLI handle supplies its original session/turn/epoch across
			// processes, but still negotiates this extension's network contract.
			infoResponse, err := sendCLIRequest(conn, "cli-network-info", "getInfo", map[string]any{})
			if err != nil {
				return nil, err
			}
			info, err := cliResult(infoResponse)
			if err != nil {
				return nil, err
			}
			metadata, _ := info["metadata"].(map[string]any)
			captured.networkWaitSupported = metadata["networkWaitVersion"] == float64(1)
		}
		if !captured.networkWaitSupported {
			return nil, errors.New("OBU_NETWORK_WAIT_UNSUPPORTED: extension requires networkWaitVersion 1")
		}
	}
	if cliNavigationWaitMethod(method) {
		if manual {
			// A raw CLI handle supplies its original session/turn/epoch across
			// processes, but still negotiates this extension's navigation contract.
			infoResponse, err := sendCLIRequest(conn, "cli-navigation-info", "getInfo", map[string]any{})
			if err != nil {
				return nil, err
			}
			info, err := cliResult(infoResponse)
			if err != nil {
				return nil, err
			}
			metadata, _ := info["metadata"].(map[string]any)
			captured.navigationWaitSupported = metadata["navigationWaitVersion"] == float64(1)
		}
		if !captured.navigationWaitSupported {
			return nil, errors.New("OBU_NAVIGATION_WAIT_UNSUPPORTED: extension requires navigationWaitVersion 1")
		}
	}
	if cliFileChooserWaitMethod(method) {
		if manual {
			// A raw CLI handle supplies its original session/turn/epoch across
			// processes, but still negotiates this extension's fileChooser contract.
			infoResponse, err := sendCLIRequest(conn, "cli-file-chooser-info", "getInfo", map[string]any{})
			if err != nil {
				return nil, err
			}
			info, err := cliResult(infoResponse)
			if err != nil {
				return nil, err
			}
			metadata, _ := info["metadata"].(map[string]any)
			captured.fileChooserWaitSupported = metadata["fileChooserWaitVersion"] == float64(1)
		}
		if !captured.fileChooserWaitSupported {
			return nil, errors.New("OBU_FILE_CHOOSER_WAIT_UNSUPPORTED: extension requires fileChooserWaitVersion 1")
		}
	}
	if cliDownloadWaitMethod(method) {
		if manual {
			// A raw CLI handle supplies its original session/turn/epoch across
			// processes, but still negotiates this extension's download contract.
			infoResponse, err := sendCLIRequest(conn, "cli-download-wait-info", "getInfo", map[string]any{})
			if err != nil {
				return nil, err
			}
			info, err := cliResult(infoResponse)
			if err != nil {
				return nil, err
			}
			metadata, _ := info["metadata"].(map[string]any)
			captured.downloadWaitSupported = metadata["downloadWaitVersion"] == float64(1)
		}
		if !captured.downloadWaitSupported {
			return nil, errors.New("OBU_DOWNLOAD_WAIT_UNSUPPORTED: extension requires downloadWaitVersion 1")
		}
	}
	if method == "downloadURL" || method == "cancelDownload" {
		if manual {
			infoResponse, err := sendCLIRequest(conn, "cli-download-info", "getInfo", map[string]any{})
			if err != nil {
				return nil, err
			}
			info, err := cliResult(infoResponse)
			if err != nil {
				return nil, err
			}
			metadata, _ := info["metadata"].(map[string]any)
			captured.directDownloadsSupported = metadata["directDownloadsVersion"] == float64(1)
		}
		if !captured.directDownloadsSupported {
			return nil, errors.New("OBU_DIRECT_DOWNLOADS_UNSUPPORTED: extension requires directDownloadsVersion 1")
		}
	}
	if method == "downloadMedia" {
		if manual {
			infoResponse, err := sendCLIRequest(conn, "cli-media-info", "getInfo", map[string]any{})
			if err != nil {
				return nil, err
			}
			info, err := cliResult(infoResponse)
			if err != nil {
				return nil, err
			}
			metadata, _ := info["metadata"].(map[string]any)
			captured.mediaDownloadsSupported = metadata["mediaDownloadsVersion"] == float64(1)
		}
		if !captured.mediaDownloadsSupported {
			return nil, errors.New("OBU_MEDIA_DOWNLOADS_UNSUPPORTED: extension requires mediaDownloadsVersion 1")
		}
	}
	if method == "exportPage" {
		if manual {
			infoResponse, err := sendCLIRequest(conn, "cli-export-info", "getInfo", map[string]any{})
			if err != nil {
				return nil, err
			}
			info, err := cliResult(infoResponse)
			if err != nil {
				return nil, err
			}
			metadata, _ := info["metadata"].(map[string]any)
			captured.pageExportSupported = metadata["pageExportVersion"] == float64(1)
		}
		if !captured.pageExportSupported {
			return nil, errors.New("OBU_PAGE_EXPORT_UNSUPPORTED: extension requires pageExportVersion 1")
		}
	}
	if cliClipboardMethod(method) {
		if manual {
			infoResponse, err := sendCLIRequest(conn, "cli-clipboard-info", "getInfo", map[string]any{})
			if err != nil {
				return nil, err
			}
			info, err := cliResult(infoResponse)
			if err != nil {
				return nil, err
			}
			metadata, _ := info["metadata"].(map[string]any)
			captured.clipboardSupported = metadata["clipboardVersion"] == float64(1)
		}
		if !captured.clipboardSupported {
			return nil, errors.New("OBU_CLIPBOARD_UNSUPPORTED: extension requires clipboardVersion 1")
		}
	}
	if err := boundCLIActionDeadline(method, params, deadline); err != nil {
		return nil, err
	}
	response, err := sendCLIRequest(conn, "cli-1", method, params)
	if err != nil {
		return nil, err
	}
	if cliFileChooserWaitMethod(method) && response["error"] == nil {
		budget, _ := params["timeoutMs"].(float64)
		if err := obu.ValidateFileChooserWaitResult(method, response["result"], budget); err != nil {
			return nil, err
		}
	}
	if cliDownloadWaitMethod(method) && response["error"] == nil {
		budget, _ := params["timeoutMs"].(float64)
		if err := obu.ValidateDownloadWaitResult(method, response["result"], budget); err != nil {
			return nil, err
		}
	}
	if cliClipboardMethod(method) && response["error"] == nil {
		value, err := obu.ValidateClipboardResult(method, response["result"], int(params["maxBytes"].(float64)))
		if err != nil {
			return nil, err
		}
		response["result"] = value
	}
	if !manual && (method == "turnEnded" || method == "finalizeTabs") && response["error"] == nil {
		next := captured
		if captured.version == 1 {
			result, ok := response["result"].(map[string]any)
			if !ok {
				return nil, errors.New("invalid control-end acknowledgement; use begin-turn to recover")
			}
			next, err = parseCLIControlState(result, captured, false)
			if err != nil || next.epoch <= captured.epoch || result["endedTurnId"] != captured.turn {
				return nil, errors.New("invalid control-end acknowledgement; use begin-turn to recover")
			}
		} else {
			next.turn = fmt.Sprintf("%s-%d", captured.session, time.Now().UnixNano())
		}
		next.generation++
		control.mu.Lock()
		control.state = next
		control.mu.Unlock()
	}
	return response, nil
}

func cliNetworkWaitMethod(method string) bool {
	return method == "armNetworkWait" || method == "collectNetworkWait" || method == "cancelNetworkWait"
}

func cliNavigationWaitMethod(method string) bool {
	return method == "armNavigationWait" || method == "collectNavigationWait" || method == "cancelNavigationWait"
}

func cliFileChooserWaitMethod(method string) bool {
	return method == "armFileChooserWait" || method == "collectFileChooserWait" || method == "cancelFileChooserWait"
}

func cliDownloadWaitMethod(method string) bool {
	return method == "armDownloadWait" || method == "collectDownloadWait" || method == "cancelDownloadWait"
}

func cliActionBudget(method string) bool {
	return method == "browserAction" || method == "waitForFileChooser" || method == "waitForDownload" || method == "armNetworkWait" || method == "armNavigationWait" || method == "armFileChooserWait" || method == "armDownloadWait" || method == "downloadURL" || method == "downloadMedia" || method == "downloadPath" || method == "cancelDownload" || method == "exportPage" || cliClipboardMethod(method)
}

func boundCLIActionDeadline(method string, params map[string]any, deadline time.Time) error {
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return errors.New("request timed out before sending")
	}
	if !cliActionBudget(method) {
		return nil
	}
	requested := float64(10_000)
	if value, ok := params["timeoutMs"]; ok {
		var valid bool
		requested, valid = value.(float64)
		if !valid || math.IsNaN(requested) || math.IsInf(requested, 0) || math.Trunc(requested) != requested || requested < 1 || requested > 120_000 {
			return fmt.Errorf("%s timeoutMs must be an integer between 1 and 120000", method)
		}
	}
	available := (remaining - time.Second).Milliseconds()
	if available < 1 {
		return fmt.Errorf("request timed out before %s could start", method)
	}
	params["timeoutMs"] = math.Min(requested, float64(available))
	return nil
}

func sendCLIRequest(conn net.Conn, id, method string, params map[string]any) (map[string]any, error) {
	if peer, ok := conn.(*mcpBoundConn); ok {
		return peer.request(id, method, params)
	}
	if err := wire.WriteJSON(conn, map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		return nil, err
	}
	return readResponseForID(conn, id, cliClipboardMethod(method))
}

func cliResult(response map[string]any) (map[string]any, error) {
	if failure, ok := response["error"].(map[string]any); ok {
		return nil, fmt.Errorf("%v", failure["message"])
	}
	result, ok := response["result"].(map[string]any)
	if !ok {
		return nil, errors.New("invalid lifecycle response")
	}
	return result, nil
}

func negotiateCLIControl(conn net.Conn, captured cliControlSnapshot) (cliControlSnapshot, error) {
	params := map[string]any{"session_id": captured.session, "turn_id": captured.turn}
	response, err := sendCLIRequest(conn, "cli-control-info", "getInfo", params)
	if err != nil {
		return captured, err
	}
	info, err := cliResult(response)
	if err != nil {
		return captured, err
	}
	metadata, _ := info["metadata"].(map[string]any)
	captured.networkWaitSupported = metadata["networkWaitVersion"] == float64(1)
	captured.navigationWaitSupported = metadata["navigationWaitVersion"] == float64(1)
	captured.fileChooserWaitSupported = metadata["fileChooserWaitVersion"] == float64(1)
	captured.downloadWaitSupported = metadata["downloadWaitVersion"] == float64(1)
	captured.directDownloadsSupported = metadata["directDownloadsVersion"] == float64(1)
	captured.mediaDownloadsSupported = metadata["mediaDownloadsVersion"] == float64(1)
	captured.pageExportSupported = metadata["pageExportVersion"] == float64(1)
	captured.clipboardSupported = metadata["clipboardVersion"] == float64(1)
	version, exists := metadata["turnLifecycleVersion"]
	if !exists {
		captured.version = 0
		return captured, nil
	}
	if version != float64(1) {
		return captured, fmt.Errorf("unsupported turn lifecycle version: %v", version)
	}
	response, err = sendCLIRequest(conn, "cli-control-state", "getControlState", params)
	if err != nil {
		return captured, err
	}
	result, err := cliResult(response)
	if err != nil {
		return captured, err
	}
	return parseCLIControlState(result, captured, true)
}

func parseCLIControlState(result map[string]any, captured cliControlSnapshot, bootstrap bool) (cliControlSnapshot, error) {
	epoch, ok := cliEpoch(result["controlEpoch"])
	nextTurn, hasTurn := result["nextTurnId"].(string)
	if !ok || !hasTurn || nextTurn == "" || result["lifecycleVersion"] != float64(1) {
		return captured, errors.New("invalid control state response")
	}
	if bootstrap {
		closing, ok := result["closing"].(bool)
		if !ok {
			return captured, errors.New("invalid control state response")
		}
		if closing {
			return captured, errors.New("OBU_CONTROL_ENDING: control is still ending")
		}
	} else {
		captured.turn = nextTurn
	}
	captured.version, captured.epoch = 1, epoch
	return captured, nil
}

func cliEpoch(value any) (int64, bool) {
	number, ok := value.(float64)
	return int64(number), ok && number >= 0 && number <= 9007199254740991 && math.Trunc(number) == number
}

// begin explicitly re-queries the extension after a stale epoch, lost end
// acknowledgement, or extension restart. It never replays an action.
func (control *cliControl) begin(options socketOptions, submitted *cliControlSnapshot) (map[string]any, error) {
	deadline := time.Now().Add(options.timeout)
	captured := control.snapshot()
	if submitted != nil {
		captured = *submitted
	}
	if !captured.deadline.IsZero() {
		deadline = captured.deadline
	}
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	select {
	case control.gate <- struct{}{}:
	case <-timer.C:
		return nil, errors.New("begin-turn timed out")
	}
	defer func() { <-control.gate }()
	if control.snapshot().generation != captured.generation {
		return nil, errors.New("OBU_STALE_CONTROL_EPOCH: begin-turn was submitted before control changed")
	}
	conn, err := dialCLIControl(options, deadline)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if err := conn.SetDeadline(deadline); err != nil {
		return nil, err
	}
	next, err := negotiateCLIControl(conn, captured)
	if err != nil {
		return nil, err
	}
	next.turn = fmt.Sprintf("%s-%d", next.session, time.Now().UnixNano())
	next.generation++
	next.deadline = time.Time{}
	control.mu.Lock()
	control.state = next
	control.mu.Unlock()
	result := map[string]any{"nextTurnId": next.turn, "lifecycleVersion": next.version}
	if next.version == 1 {
		result["controlEpoch"], result["closing"] = next.epoch, false
	}
	return map[string]any{"jsonrpc": "2.0", "id": "cli-1", "result": result}, nil
}
