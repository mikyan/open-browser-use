package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
	"github.com/spf13/cobra"
)

func newExportPageCommand() *cobra.Command {
	var options socketOptions
	var tabID, maximum int
	var format, output, pdfJSON string
	command := &cobra.Command{Use: "export-page", Short: "Export an owned page to a new PDF or MHTML file", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			params := map[string]any{"tabId": float64(tabID), "format": format, "maxBytes": float64(maximum), "timeoutMs": float64(options.timeout) / float64(time.Millisecond)}
			if cmd.Flags().Changed("pdf-options") {
				var pdf any
				if err := json.Unmarshal([]byte(pdfJSON), &pdf); err != nil {
					return fmt.Errorf("invalid --pdf-options JSON: %w", err)
				}
				params["pdf"] = pdf
			}
			result, err := exportPageToFile(options, nil, params, output)
			if err != nil {
				return err
			}
			return writeJSONTo(cmd.OutOrStdout(), result)
		}}
	addSocketFlags(command, &options)
	command.Flags().IntVar(&tabID, "tab-id", 0, "owned browser tab id")
	command.Flags().StringVar(&format, "format", "", "export format: pdf or mhtml")
	command.Flags().StringVar(&output, "output", "", "new output file path (never overwritten)")
	command.Flags().IntVar(&maximum, "max-bytes", obu.MaxPageExportBytes, "maximum exported bytes (1..16777216)")
	command.Flags().StringVar(&pdfJSON, "pdf-options", "", "finite PDF options JSON object; pdf format only")
	for _, name := range []string{"tab-id", "format", "output"} {
		_ = command.MarkFlagRequired(name)
	}
	return command
}

// Validate even generic `call exportPage` before connecting. The SDK validator
// owns the shared finite PDF options; the CLI rejects unknown JSON and nulls.
func validateCLIPageExportParams(params map[string]any) (map[string]any, error) {
	for key := range params {
		switch key {
		case "tabId", "format", "maxBytes", "timeoutMs", "pdf", "session_id", "turn_id", "control_epoch":
		default:
			return nil, fmt.Errorf("exportPage does not support parameter %s", key)
		}
	}
	tabID, err := exportInteger(params["tabId"], "tabId", 1, 9007199254740991)
	if err != nil {
		return nil, err
	}
	format, ok := params["format"].(string)
	if !ok {
		return nil, errors.New("exportPage format must be pdf or mhtml")
	}
	maximum, timeout := obu.MaxPageExportBytes, 10_000
	if raw, exists := params["maxBytes"]; exists {
		maximum, err = exportInteger(raw, "maxBytes", 1, obu.MaxPageExportBytes)
		if err != nil {
			return nil, err
		}
	}
	if raw, exists := params["timeoutMs"]; exists {
		timeout, err = exportInteger(raw, "timeoutMs", 1, 120_000)
		if err != nil {
			return nil, err
		}
	}
	options := obu.ExportPageOptions{MaxBytes: maximum, Timeout: time.Duration(timeout) * time.Millisecond}
	if raw, exists := params["pdf"]; exists {
		pdf, valid := raw.(map[string]any)
		if !valid {
			return nil, errors.New("exportPage pdf must be an object")
		}
		for key, value := range pdf {
			switch key {
			case "landscape", "printBackground", "preferCSSPageSize", "generateTaggedPDF", "generateDocumentOutline", "scale", "paperWidth", "paperHeight", "marginTop", "marginBottom", "marginLeft", "marginRight", "pageRanges":
			default:
				return nil, fmt.Errorf("unsupported PDF option %s", key)
			}
			if value == nil {
				return nil, fmt.Errorf("PDF option %s cannot be null", key)
			}
		}
		payload, err := json.Marshal(pdf)
		if err != nil {
			return nil, err
		}
		decoder := json.NewDecoder(bytes.NewReader(payload))
		decoder.DisallowUnknownFields()
		options.PDF = &obu.PDFOptions{}
		if err := decoder.Decode(options.PDF); err != nil {
			return nil, fmt.Errorf("invalid PDF options: %w", err)
		}
	}
	validated, err := obu.ExportPageParams(format, options)
	if err != nil {
		return nil, err
	}
	result := map[string]any(validated)
	result["tabId"] = float64(tabID)
	result["timeoutMs"] = float64(timeout)
	for _, key := range []string{"session_id", "turn_id", "control_epoch"} {
		if value, exists := params[key]; exists {
			result[key] = value
		}
	}
	return result, nil
}

func exportInteger(value any, name string, minimum, maximum int) (int, error) {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number || number < float64(minimum) || number > float64(maximum) {
		return 0, fmt.Errorf("%s must be an integer between %d and %d", name, minimum, maximum)
	}
	return int(number), nil
}

func exportOutputPath(output string) (string, error) {
	if strings.TrimSpace(output) == "" {
		return "", errors.New("output path is required")
	}
	target, err := filepath.Abs(output)
	if err != nil {
		return "", err
	}
	if _, err := os.Lstat(target); err == nil {
		return "", fmt.Errorf("export output already exists: %s", target)
	} else if !os.IsNotExist(err) {
		return "", err
	}
	parent, err := os.Stat(filepath.Dir(target))
	if err != nil {
		return "", fmt.Errorf("export output parent: %w", err)
	}
	if !parent.IsDir() {
		return "", errors.New("export output parent must be a directory")
	}
	return target, nil
}

func exportPageToFile(options socketOptions, submitted *cliControlSnapshot, params map[string]any, output string) (map[string]any, error) {
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
	validated, err := validateCLIPageExportParams(copy)
	if err != nil {
		return nil, err
	}
	deadline := captured.deadline
	operationDeadline := deadline.Add(-options.timeout).Add(time.Duration(validated["timeoutMs"].(float64))*time.Millisecond + time.Second)
	if operationDeadline.Before(deadline) {
		deadline = operationDeadline
	}
	target, err := exportOutputPath(output)
	if err != nil {
		return nil, err
	}
	response, err := control.invoke(options, "exportPage", validated, &captured)
	if err != nil {
		return nil, err
	}
	value, err := cliResult(response)
	if err != nil {
		return nil, err
	}
	result, err := obu.ValidatePageExport(value, validated["format"].(string), validated["maxBytes"].(int))
	if err != nil {
		return nil, err
	}
	data, err := base64.StdEncoding.DecodeString(result.Data)
	if err != nil {
		return nil, errors.New("invalid exportPage base64")
	}
	if err := publishPageExport(target, data, deadline, os.Link); err != nil {
		return nil, err
	}
	return map[string]any{"path": target, "format": result.Format, "mimeType": result.MimeType, "byteLength": result.ByteLength}, nil
}

// Link publishes an already synced file atomically and never replaces a target.
// There is deliberately no rename/copy fallback on filesystems without links.
func publishPageExport(target string, data []byte, deadline time.Time, link func(string, string) error) error {
	if !time.Now().Before(deadline) {
		return errors.New("page export timed out before writing output")
	}
	temporary, err := os.CreateTemp(filepath.Dir(target), ".obu-export-*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	defer temporary.Close()
	if n, err := temporary.Write(data); err != nil {
		return err
	} else if n != len(data) {
		return io.ErrShortWrite
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if !time.Now().Before(deadline) {
		return errors.New("page export timed out before publishing output")
	}
	if err := link(temporary.Name(), target); err != nil {
		return fmt.Errorf("cannot publish export without overwriting (hard links required): %w", err)
	}
	return nil
}

func (server *mcpServer) runExportPageTool(arguments map[string]any) (any, error) {
	for key := range arguments {
		switch key {
		case "tab_id", "format", "output_path", "max_bytes", "timeout_ms", "pdf":
		default:
			return nil, fmt.Errorf("export_page does not support argument %s", key)
		}
	}
	output, err := requiredStringArg(arguments, "output_path")
	if err != nil {
		return nil, err
	}
	params := map[string]any{"tabId": arguments["tab_id"], "format": arguments["format"]}
	for input, wire := range map[string]string{"max_bytes": "maxBytes", "timeout_ms": "timeoutMs", "pdf": "pdf"} {
		if value, exists := arguments[input]; exists {
			params[wire] = value
		}
	}
	return exportPageToFile(server.runner.options, server.runner.submitted, params, output)
}

func pageExportTool() mcpTool {
	return mcpTool{Name: "export_page", Title: "Export Page to File", Description: "Export an owned page as PDF or MHTML to a new local file. Never overwrites; requires filesystem hard-link support. Returns file metadata, not base64. Website restrictions permit PDF only after checking all frames; MHTML requires unrestricted mode.",
		InputSchema: objectSchema(map[string]any{
			"tab_id": integerSchema("Owned tab id"), "format": map[string]any{"type": "string", "enum": []string{"pdf", "mhtml"}},
			"output_path": stringSchema("New output file in an existing local directory"),
			"max_bytes":   map[string]any{"type": "integer", "minimum": 1, "maximum": obu.MaxPageExportBytes, "default": obu.MaxPageExportBytes},
			"timeout_ms":  map[string]any{"type": "integer", "minimum": 1, "maximum": 120000, "default": 10000},
			"pdf": objectSchema(map[string]any{
				"landscape": map[string]any{"type": "boolean"}, "printBackground": map[string]any{"type": "boolean"},
				"preferCSSPageSize": map[string]any{"type": "boolean"}, "generateTaggedPDF": map[string]any{"type": "boolean"}, "generateDocumentOutline": map[string]any{"type": "boolean"},
				"scale": numberSchema("Scale from 0.1 to 2"), "paperWidth": numberSchema("Width in inches, >0 and <=200"), "paperHeight": numberSchema("Height in inches, >0 and <=200"),
				"marginTop": numberSchema("Inches from 0 to 200"), "marginBottom": numberSchema("Inches from 0 to 200"), "marginLeft": numberSchema("Inches from 0 to 200"), "marginRight": numberSchema("Inches from 0 to 200"),
				"pageRanges": stringSchema("At most 1024 ASCII characters: digits, spaces, comma and hyphen"),
			}, nil),
		}, []string{"tab_id", "format", "output_path"})}
}
