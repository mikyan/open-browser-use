package main

import (
	"errors"
	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
	"github.com/spf13/cobra"
	"io"
)

func cliResponseBody(method string, params map[string]any) bool {
	return method == "browserAction" && params["action"] == "responseBody"
}

type responseBodyFlags struct {
	tabID, maxBytes, timeoutMS   int
	captureID, requestID, turnID string
	controlEpoch                 int64
}

func (f *responseBodyFlags) add(command *cobra.Command) {
	command.Flags().IntVar(&f.tabID, "tab-id", -1, "Original managed tab id")
	command.Flags().StringVar(&f.captureID, "capture-id", "", "Original diagnostics capture id")
	command.Flags().StringVar(&f.requestID, "request-id", "", "Original diagnostics request id")
	command.Flags().IntVar(&f.maxBytes, "max-bytes", obu.DefaultResponseBodyBytes, "Maximum Chrome-decoded body bytes (1..8388608)")
	command.Flags().IntVar(&f.timeoutMS, "timeout-ms", 10000, "Original action deadline in milliseconds (1..120000)")
	command.Flags().StringVar(&f.turnID, "turn-id", "", "Original turn id; required for standalone response-body")
	command.Flags().Int64Var(&f.controlEpoch, "control-epoch", 0, "Original control epoch, when already known")
}
func (f *responseBodyFlags) params(command *cobra.Command) (map[string]any, error) {
	p := map[string]any{"tabId": f.tabID, "action": "responseBody", "args": map[string]any{"captureId": f.captureID, "requestId": f.requestID, "maxBytes": f.maxBytes}, "timeoutMs": f.timeoutMS}
	if command.Flags().Changed("turn-id") {
		p["turn_id"] = f.turnID
	}
	if command.Flags().Changed("control-epoch") {
		p["control_epoch"] = f.controlEpoch
	}
	if err := obu.ValidateResponseBodyParams(obu.Params(p)); err != nil {
		return nil, err
	}
	return p, nil
}
func newResponseBodyCommand() *cobra.Command {
	var options socketOptions
	var flags responseBodyFlags
	command := &cobra.Command{Use: "response-body", Short: "Read original response bytes from a diagnostics reference", Args: cobra.NoArgs}
	flags.add(command)
	addSocketFlags(command, &options)
	command.RunE = func(cmd *cobra.Command, _ []string) error {
		if flags.turnID == "" {
			return errors.New("standalone response-body requires the original --turn-id")
		}
		params, err := flags.params(cmd)
		if err != nil {
			return err
		}
		options.control = newCLIControl(options.sessionID, flags.turnID)
		response, err := invokeWithOptions(options, "browserAction", params)
		if err != nil {
			return err
		}
		return writeJSON(response)
	}
	return command
}
func buildResponseBodyCommand(args []string) (string, map[string]any, error) {
	var flags responseBodyFlags
	command := &cobra.Command{Use: "response-body"}
	command.SetOut(io.Discard)
	command.SetErr(io.Discard)
	flags.add(command)
	if err := command.ParseFlags(args); err != nil {
		return "", nil, err
	}
	if len(command.Flags().Args()) != 0 {
		return "", nil, errors.New("response-body does not accept positional arguments")
	}
	params, err := flags.params(command)
	return "browserAction", params, err
}
func responseBodyTools() []mcpTool {
	return []mcpTool{{Name: "response_body", Title: "Read Original Response Body", Description: "Read bounded original response bytes using diagnostics capture_id and request_id; never fetch a URL again.", InputSchema: objectSchema(map[string]any{
		"tab_id": integerSchema("Original managed tab id"), "capture_id": stringSchema("Original diagnostics capture id"), "request_id": stringSchema("Original diagnostics request id"),
		"max_bytes":  map[string]any{"type": "integer", "minimum": 1, "maximum": obu.MaxResponseBodyBytes, "default": obu.DefaultResponseBodyBytes},
		"timeout_ms": map[string]any{"type": "integer", "minimum": 1, "maximum": 120000, "default": 10000},
	}, []string{"tab_id", "capture_id", "request_id"})}}
}
func (server *mcpServer) runResponseBodyTool(arguments map[string]any) (any, error) {
	params := map[string]any{"action": "responseBody"}
	args := map[string]any{}
	params["args"] = args
	for key, value := range arguments {
		switch key {
		case "tab_id":
			params["tabId"] = value
		case "timeout_ms":
			params["timeoutMs"] = value
		case "capture_id":
			args["captureId"] = value
		case "request_id":
			args["requestId"] = value
		case "max_bytes":
			args["maxBytes"] = value
		default:
			return nil, errors.New("OBU_RESPONSE_BODY_INVALID: unknown response_body argument")
		}
	}
	if err := obu.ValidateResponseBodyParams(obu.Params(params)); err != nil {
		return nil, err
	}
	return server.invoke("browserAction", params)
}
func responseBodyToolCall(name string, arguments map[string]any) bool {
	if name == "response_body" {
		return true
	}
	p, _ := arguments["params"].(map[string]any)
	return name == "call" && arguments["method"] == "browserAction" && p["action"] == "responseBody"
}
