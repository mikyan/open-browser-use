package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"reflect"
	"strconv"
	"time"
	"unicode/utf8"

	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
	"github.com/spf13/cobra"
)

func cliClipboardMethod(method string) bool {
	switch method {
	case "readClipboardText", "writeClipboardText", "readClipboard", "writeClipboard":
		return true
	}
	return false
}

func validateClipboardValueUnicode(value any) error {
	var visit func(reflect.Value, int) error
	visit = func(value reflect.Value, depth int) error {
		if depth > 64 {
			return errors.New("clipboard input nesting exceeds supported depth")
		}
		if !value.IsValid() {
			return nil
		}
		switch value.Kind() {
		case reflect.String:
			if !utf8.ValidString(value.String()) {
				return errors.New("clipboard input must contain valid Unicode")
			}
		case reflect.Interface, reflect.Pointer:
			if !value.IsNil() {
				return visit(value.Elem(), depth+1)
			}
		case reflect.Map:
			iterator := value.MapRange()
			for iterator.Next() {
				if err := visit(iterator.Key(), depth+1); err != nil {
					return err
				}
				if err := visit(iterator.Value(), depth+1); err != nil {
					return err
				}
			}
		case reflect.Array, reflect.Slice:
			for i := 0; i < value.Len(); i++ {
				if err := visit(value.Index(i), depth+1); err != nil {
					return err
				}
			}
		case reflect.Struct:
			for i := 0; i < value.NumField(); i++ {
				if value.Type().Field(i).IsExported() {
					if err := visit(value.Field(i), depth+1); err != nil {
						return err
					}
				}
			}
		}
		return nil
	}
	return visit(reflect.ValueOf(value), 0)
}

func validateCLIClipboardParams(method string, params map[string]any) (map[string]any, error) {
	for key := range params {
		switch key {
		case "tabId", "maxBytes", "timeoutMs", "session_id", "turn_id", "control_epoch":
		case "text":
			if method != "writeClipboardText" {
				return nil, fmt.Errorf("%s does not accept text", method)
			}
		case "items":
			if method != "writeClipboard" {
				return nil, fmt.Errorf("%s does not accept items", method)
			}
		default:
			return nil, fmt.Errorf("%s does not support parameter %s", method, key)
		}
	}
	tabID, err := exportInteger(params["tabId"], "tabId", 1, 9007199254740991)
	if err != nil {
		return nil, err
	}
	maximum, timeout := obu.MaxClipboardBytes, 10000
	if raw, exists := params["maxBytes"]; exists {
		maximum, err = exportInteger(raw, "maxBytes", 1, obu.MaxClipboardBytes)
		if err != nil {
			return nil, err
		}
	}
	if raw, exists := params["timeoutMs"]; exists {
		timeout, err = exportInteger(raw, "timeoutMs", 1, 120000)
		if err != nil {
			return nil, err
		}
	}
	payload := obu.Params{}
	for _, key := range []string{"text", "items"} {
		if value, exists := params[key]; exists {
			payload[key] = value
		}
	}
	validated, err := obu.ClipboardParams(method, tabID, payload, obu.ClipboardOptions{MaxBytes: maximum, Timeout: time.Duration(timeout) * time.Millisecond})
	if err != nil {
		return nil, err
	}
	result := map[string]any(validated)
	result["tabId"], result["maxBytes"], result["timeoutMs"] = float64(tabID), float64(maximum), float64(timeout)
	for _, key := range []string{"session_id", "turn_id", "control_epoch"} {
		if value, exists := params[key]; exists {
			result[key] = value
		}
	}
	return result, nil
}

// Rich clipboard files contain the public {items:[...]} JSON envelope. The
// encoded input cap bounds the file read before the decoded MIME byte checks.
func readClipboardFile(input string) (map[string]any, error) {
	info, err := os.Stat(input)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("clipboard input must be a regular JSON file")
	}
	file, err := os.Open(input)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	const maximum = 64 * 1024 * 1024
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maximum {
		return nil, errors.New("clipboard JSON file exceeds 64 MiB")
	}
	if err := validateClipboardJSONUnicode(data); err != nil {
		return nil, err
	}
	var value map[string]any
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("invalid clipboard JSON: %w", err)
	}
	if value == nil || len(value) != 1 {
		return nil, errors.New("clipboard JSON must contain only items")
	}
	if _, exists := value["items"]; !exists {
		return nil, errors.New("clipboard JSON requires items")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, errors.New("clipboard JSON contains trailing data")
	}
	return value, nil
}

// encoding/json replaces invalid UTF-8 and lone escaped surrogates with U+FFFD.
// Reject those before decoding clipboard input instead of silently writing
// different text. Other JSON syntax is checked by the ordinary decoder.
func validateClipboardJSONUnicode(data []byte) error {
	invalid := errors.New("clipboard JSON must contain valid Unicode without lone surrogates")
	if !utf8.Valid(data) {
		return invalid
	}
	inString := false
	for i := 0; i < len(data); i++ {
		if data[i] == '"' {
			inString = !inString
			continue
		}
		if !inString || data[i] != '\\' {
			continue
		}
		i++
		if i >= len(data) || data[i] != 'u' {
			continue
		}
		if i+4 >= len(data) {
			return invalid
		}
		unit, err := strconv.ParseUint(string(data[i+1:i+5]), 16, 16)
		if err != nil {
			return invalid
		}
		i += 4
		if unit >= 0xdc00 && unit <= 0xdfff {
			return invalid
		}
		if unit < 0xd800 || unit > 0xdbff {
			continue
		}
		if i+6 >= len(data) || data[i+1] != '\\' || data[i+2] != 'u' {
			return invalid
		}
		low, err := strconv.ParseUint(string(data[i+3:i+7]), 16, 16)
		if err != nil || low < 0xdc00 || low > 0xdfff {
			return invalid
		}
		i += 6
	}
	return nil
}

func clipboardToFile(options socketOptions, submitted *cliControlSnapshot, params map[string]any, output string) (map[string]any, error) {
	control := initializedCLIControl(options, params)
	captured := control.snapshot()
	if submitted != nil {
		captured = *submitted
	}
	if captured.deadline.IsZero() {
		captured.deadline = time.Now().Add(options.timeout)
	}
	copy, err := copyCLIParams(params)
	if err != nil {
		return nil, err
	}
	validated, err := validateCLIClipboardParams("readClipboard", copy)
	if err != nil {
		return nil, err
	}
	target, err := exportOutputPath(output)
	if err != nil {
		return nil, err
	}
	deadline := captured.deadline
	operationDeadline := deadline.Add(-options.timeout).Add(time.Duration(validated["timeoutMs"].(float64))*time.Millisecond + time.Second)
	if operationDeadline.Before(deadline) {
		deadline = operationDeadline
	}
	response, err := control.invoke(options, "readClipboard", validated, &captured)
	if err != nil {
		return nil, err
	}
	value, err := cliResult(response)
	if err != nil {
		return nil, err
	}
	// invoke validates the response before any file or tool output is produced.
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	data = append(data, '\n')
	if err := publishPageExport(target, data, deadline, os.Link); err != nil {
		return nil, err
	}
	return map[string]any{"path": target, "mimeType": "application/json", "encoding": "utf-8", "byteLength": len(data)}, nil
}

func newClipboardCommand() *cobra.Command {
	root := &cobra.Command{Use: "clipboard", Short: "Read or write the shared clipboard through an owned tab"}
	for _, mode := range []string{"read-text", "write-text", "read", "write"} {
		var options socketOptions
		var tabID, maximum int
		var text, input, output string
		method := map[string]string{"read-text": "readClipboardText", "write-text": "writeClipboardText", "read": "readClipboard", "write": "writeClipboard"}[mode]
		command := &cobra.Command{Use: mode, Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
			started := time.Now()
			params := map[string]any{"tabId": float64(tabID), "maxBytes": float64(maximum), "timeoutMs": float64(options.timeout) / float64(time.Millisecond)}
			if method == "writeClipboardText" {
				params["text"] = text
			}
			if method == "writeClipboard" {
				payload, err := readClipboardFile(input)
				if err != nil {
					return err
				}
				params["items"] = payload["items"]
			}
			var result any
			var err error
			if method == "readClipboard" {
				result, err = clipboardToFile(options, nil, params, output)
			} else {
				var response map[string]any
				control := initializedCLIControl(options, params)
				captured := control.snapshot()
				captured.deadline = started.Add(options.timeout)
				response, err = control.invoke(options, method, params, &captured)
				if err == nil {
					result, err = cliResult(response)
				}
			}
			if err != nil {
				return err
			}
			return writeJSONTo(cmd.OutOrStdout(), result)
		}}
		addSocketFlags(command, &options)
		command.Flags().IntVar(&tabID, "tab-id", 0, "owned browser tab id")
		command.Flags().IntVar(&maximum, "max-bytes", obu.MaxClipboardBytes, "maximum total decoded clipboard bytes")
		_ = command.MarkFlagRequired("tab-id")
		switch mode {
		case "write-text":
			command.Flags().StringVar(&text, "text", "", "text to write; empty text is allowed")
			_ = command.MarkFlagRequired("text")
		case "write":
			command.Flags().StringVar(&input, "input", "", "JSON file containing the items envelope")
			_ = command.MarkFlagRequired("input")
		case "read":
			command.Flags().StringVar(&output, "output", "", "new JSON file path (never overwritten)")
			_ = command.MarkFlagRequired("output")
		}
		root.AddCommand(command)
	}
	return root
}

func (server *mcpServer) runClipboardTool(name string, arguments map[string]any) (any, error) {
	method := map[string]string{"read_clipboard_text": "readClipboardText", "write_clipboard_text": "writeClipboardText", "read_clipboard": "readClipboard", "write_clipboard": "writeClipboard"}[name]
	params := map[string]any{"tabId": arguments["tab_id"]}
	for key, value := range arguments {
		switch key {
		case "tab_id":
		case "max_bytes":
			params["maxBytes"] = value
		case "timeout_ms":
			params["timeoutMs"] = value
		case "text":
			if method != "writeClipboardText" {
				return nil, fmt.Errorf("%s does not accept text", name)
			}
			params["text"] = value
		case "output_path":
			if method != "readClipboard" {
				return nil, fmt.Errorf("%s does not accept output_path", name)
			}
		case "input_path":
			if method != "writeClipboard" {
				return nil, fmt.Errorf("%s does not accept input_path", name)
			}
		default:
			return nil, fmt.Errorf("%s does not support argument %s", name, key)
		}
	}
	if method == "readClipboard" {
		output, err := requiredStringArg(arguments, "output_path")
		if err != nil {
			return nil, err
		}
		return clipboardToFile(server.runner.options, server.runner.submitted, params, output)
	}
	if method == "writeClipboard" {
		input, err := requiredStringArg(arguments, "input_path")
		if err != nil {
			return nil, err
		}
		payload, err := readClipboardFile(input)
		if err != nil {
			return nil, err
		}
		params["items"] = payload["items"]
	}
	response, _, err := server.runner.invoke(method, params)
	if err != nil {
		return nil, err
	}
	return cliResult(response)
}

func clipboardTools() []mcpTool {
	var tools []mcpTool
	for _, name := range []string{"read_clipboard_text", "write_clipboard_text", "read_clipboard", "write_clipboard"} {
		properties := map[string]any{
			"tab_id":     integerSchema("Owned tab id"),
			"max_bytes":  map[string]any{"type": "integer", "minimum": 1, "maximum": obu.MaxClipboardBytes, "default": obu.MaxClipboardBytes},
			"timeout_ms": map[string]any{"type": "integer", "minimum": 1, "maximum": 120000, "default": 10000},
		}
		required := []string{"tab_id"}
		description := "Use the shared clipboard in the background. Requires unrestricted website mode and clipboard capability v1. Writes are never automatically retried; a submitted write may finish after cancellation."
		switch name {
		case "write_clipboard_text":
			properties["text"] = stringSchema("Text to write, including empty text")
			required = append(required, "text")
		case "read_clipboard":
			properties["output_path"] = stringSchema("New local JSON file containing items; never overwritten")
			required = append(required, "output_path")
			description += " Reads supported text/plain, text/html and image/png representations to a new file; returns file metadata."
		case "write_clipboard":
			properties["input_path"] = stringSchema("Local JSON file containing the items envelope")
			required = append(required, "input_path")
			description += " Reads an explicit local JSON file containing items. Empty items is a no-op."
		}
		tools = append(tools, mcpTool{Name: name, Description: description, InputSchema: objectSchema(properties, required)})
	}
	return tools
}
