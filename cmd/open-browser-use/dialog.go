package main

import (
	"errors"
	"io"

	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
	"github.com/spf13/cobra"
)

func cliDialogMethod(method string) bool {
	return method == "armDialog" || method == "collectDialog" || method == "cancelDialog"
}

type dialogFlags struct {
	tabID                         int
	kind, message, promptText, id string
	turnID                        string
	controlEpoch                  int64
	accept                        bool
	timeoutMS                     int
}

func (f *dialogFlags) add(command *cobra.Command, method string) {
	command.Flags().IntVar(&f.tabID, "tab-id", -1, "Original managed tab id")
	command.Flags().StringVar(&f.turnID, "turn-id", "", "Original turn id; required for standalone dialog commands")
	command.Flags().Int64Var(&f.controlEpoch, "control-epoch", 0, "Original control epoch, when already known")
	if method == "armDialog" {
		command.Flags().StringVar(&f.kind, "type", "", "Dialog type: alert, confirm, prompt, beforeunload")
		command.Flags().BoolVar(&f.accept, "accept", false, "Explicit native decision (--accept=true or --accept=false)")
		command.Flags().Lookup("accept").NoOptDefVal = ""
		command.Flags().StringVar(&f.message, "message", "", "Optional exact message, including an empty string")
		command.Flags().StringVar(&f.promptText, "prompt-text", "", "Reply text for an accepted prompt")
		command.Flags().IntVar(&f.timeoutMS, "timeout-ms", 10000, "Original dialog deadline in milliseconds (1..120000)")
	} else {
		command.Flags().StringVar(&f.id, "dialog-id", "", "Original dialog id returned by arm-dialog")
	}
}
func (f *dialogFlags) params(command *cobra.Command, method string) (map[string]any, error) {
	if !command.Flags().Changed("tab-id") {
		return nil, errors.New("dialog command requires --tab-id")
	}
	p := map[string]any{"tabId": float64(f.tabID)}
	if command.Flags().Changed("turn-id") {
		p["turn_id"] = f.turnID
	}
	if command.Flags().Changed("control-epoch") {
		p["control_epoch"] = float64(f.controlEpoch)
	}
	if method == "armDialog" {
		if !command.Flags().Changed("accept") {
			return nil, errors.New("arm-dialog requires explicit --accept=true or --accept=false")
		}
		p["type"], p["accept"], p["timeoutMs"] = f.kind, f.accept, float64(f.timeoutMS)
		if command.Flags().Changed("message") {
			p["message"] = f.message
		}
		if command.Flags().Changed("prompt-text") {
			p["promptText"] = f.promptText
		}
	} else {
		p["dialogId"] = f.id
	}
	if err := obu.ValidateDialogInputUnicode(obu.Params(p)); err != nil {
		return nil, err
	}
	if err := obu.ValidateDialogParams(method, obu.Params(p)); err != nil {
		return nil, err
	}
	return p, nil
}
func newDialogCommand(name, method string) *cobra.Command {
	var options socketOptions
	var flags dialogFlags
	command := &cobra.Command{Use: name, Short: "Arm, collect or cancel one native JavaScript dialog decision", Args: cobra.NoArgs}
	flags.add(command, method)
	addSocketFlags(command, &options)
	command.RunE = func(cmd *cobra.Command, _ []string) error {
		if flags.turnID == "" {
			return errors.New("standalone dialog commands require the original --turn-id")
		}
		params, err := flags.params(cmd, method)
		if err != nil {
			return err
		}
		options.control = newCLIControl(options.sessionID, flags.turnID)
		response, err := invokeWithOptions(options, method, params)
		if err != nil {
			return err
		}
		return writeJSON(response)
	}
	return command
}
func buildDialogCommand(name string, args []string) (string, map[string]any, error) {
	method := map[string]string{"arm-dialog": "armDialog", "collect-dialog": "collectDialog", "cancel-dialog": "cancelDialog"}[name]
	if method == "" {
		return "", nil, errors.New("unknown dialog command")
	}
	var flags dialogFlags
	command := &cobra.Command{Use: name}
	command.SetOut(io.Discard)
	command.SetErr(io.Discard)
	flags.add(command, method)
	if err := command.ParseFlags(args); err != nil {
		return "", nil, err
	}
	if len(command.Flags().Args()) != 0 {
		return "", nil, errors.New("dialog commands do not accept positional arguments")
	}
	params, err := flags.params(command, method)
	return method, params, err
}
func dialogTools() []mcpTool {
	scope := func() map[string]any { return map[string]any{"tab_id": integerSchema("Original managed tab id")} }
	arm := scope()
	arm["type"] = map[string]any{"type": "string", "enum": []string{"alert", "confirm", "prompt", "beforeunload"}}
	arm["accept"] = map[string]any{"type": "boolean", "description": "Explicit native decision"}
	arm["message"] = stringSchema("Optional exact message, including empty")
	arm["prompt_text"] = stringSchema("Reply text only for an accepted prompt")
	arm["timeout_ms"] = map[string]any{"type": "integer", "minimum": 1, "maximum": 120000, "default": 10000}
	tools := []mcpTool{{Name: "arm_dialog", Title: "Arm Native Dialog", Description: "Register one explicit native JavaScript dialog decision before triggering the page once.", InputSchema: objectSchema(arm, []string{"tab_id", "type", "accept"})}}
	for _, name := range []string{"collect_dialog", "cancel_dialog"} {
		p := scope()
		p["dialog_id"] = stringSchema("Original dialog id returned by arm_dialog")
		tools = append(tools, mcpTool{Name: name, Description: "Collect or cancel the original native dialog decision; never replay the page trigger.", InputSchema: objectSchema(p, []string{"tab_id", "dialog_id"})})
	}
	return tools
}
func (server *mcpServer) runDialogTool(name string, arguments map[string]any) (any, error) {
	method := map[string]string{"arm_dialog": "armDialog", "collect_dialog": "collectDialog", "cancel_dialog": "cancelDialog"}[name]
	mapping := map[string]string{"tab_id": "tabId", "dialog_id": "dialogId", "type": "type", "accept": "accept", "message": "message", "prompt_text": "promptText", "timeout_ms": "timeoutMs"}
	params := map[string]any{}
	for key, value := range arguments {
		mapped, ok := mapping[key]
		if !ok {
			return nil, errors.New("invalid dialog tool arguments")
		}
		params[mapped] = value
	}
	if err := obu.ValidateDialogInputUnicode(obu.Params(params)); err != nil {
		return nil, err
	}
	if err := obu.ValidateDialogParams(method, obu.Params(params)); err != nil {
		return nil, err
	}
	return server.invoke(method, params)
}
func dialogToolName(name string) bool {
	return name == "arm_dialog" || name == "collect_dialog" || name == "cancel_dialog"
}
