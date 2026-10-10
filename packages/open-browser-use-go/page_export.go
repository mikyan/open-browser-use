package obu

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"
)

const MaxPageExportBytes = 16 * 1024 * 1024

// PDFOptions uses pointers so explicitly false and zero margins differ from
// omitted options, whose defaults are chosen by the browser.
type PDFOptions struct {
	Landscape               *bool    `json:"landscape,omitempty"`
	PrintBackground         *bool    `json:"printBackground,omitempty"`
	Scale                   *float64 `json:"scale,omitempty"`
	PaperWidth              *float64 `json:"paperWidth,omitempty"`
	PaperHeight             *float64 `json:"paperHeight,omitempty"`
	MarginTop               *float64 `json:"marginTop,omitempty"`
	MarginBottom            *float64 `json:"marginBottom,omitempty"`
	MarginLeft              *float64 `json:"marginLeft,omitempty"`
	MarginRight             *float64 `json:"marginRight,omitempty"`
	PageRanges              *string  `json:"pageRanges,omitempty"`
	PreferCSSPageSize       *bool    `json:"preferCSSPageSize,omitempty"`
	GenerateTaggedPDF       *bool    `json:"generateTaggedPDF,omitempty"`
	GenerateDocumentOutline *bool    `json:"generateDocumentOutline,omitempty"`
}

type ExportPageOptions struct {
	MaxBytes int           // Zero selects the 16 MiB default.
	Timeout  time.Duration // Zero selects the 10 second default.
	PDF      *PDFOptions
}

// PageExport contains encoded bytes. No local file is written automatically.
type PageExport struct {
	Format     string `json:"format"`
	MimeType   string `json:"mimeType"`
	Encoding   string `json:"encoding"`
	Data       string `json:"data"`
	ByteLength int    `json:"byteLength"`
}

// ExportPageParams validates and copies options for the finite export RPC.
// It excludes tab and control metadata, which belong to the client's scope.
func ExportPageParams(format string, options ExportPageOptions) (Params, error) {
	if format != "pdf" && format != "mhtml" {
		return nil, errors.New("invalid page export format")
	}
	maximum, timeout := options.MaxBytes, options.Timeout
	if maximum == 0 {
		maximum = MaxPageExportBytes
	}
	if maximum < 1 || maximum > MaxPageExportBytes {
		return nil, errors.New("page export maxBytes must be an integer from 1 to 16777216")
	}
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	if timeout < time.Millisecond || timeout > 120*time.Second || timeout%time.Millisecond != 0 {
		return nil, errors.New("page export timeout must be an integer number of milliseconds from 1 to 120000")
	}
	params := Params{"format": format, "maxBytes": maximum, "timeoutMs": timeout.Milliseconds()}
	if options.PDF != nil {
		if format != "pdf" {
			return nil, errors.New("PDF options require format pdf")
		}
		payload, err := json.Marshal(options.PDF)
		if err != nil {
			return nil, errors.New("invalid PDF options")
		}
		var pdf Params
		if err := json.Unmarshal(payload, &pdf); err != nil {
			return nil, err
		}
		for key, value := range pdf {
			if number, ok := value.(float64); ok {
				minimum, maximum := 0.0, 200.0
				if key == "scale" {
					minimum, maximum = .1, 2
				}
				if math.IsNaN(number) || math.IsInf(number, 0) || number < minimum || number > maximum || (strings.HasPrefix(key, "paper") && number == 0) {
					return nil, errors.New("invalid PDF option: " + key)
				}
			}
		}
		if ranges := options.PDF.PageRanges; ranges != nil {
			if len(*ranges) > 1024 || strings.IndexFunc(*ranges, func(c rune) bool { return c != ' ' && c != ',' && c != '-' && (c < '0' || c > '9') }) >= 0 {
				return nil, errors.New("invalid PDF pageRanges")
			}
		}
		params["pdf"] = pdf
	}
	return params, nil
}

// ValidatePageExport checks a decoded wire result, including canonical base64
// and the caller's byte budget, before any consumer publishes it as an artifact.
func ValidatePageExport(value any, format string, maxBytes int) (PageExport, error) {
	invalid := errors.New("invalid exportPage result")
	if maxBytes < 1 || maxBytes > MaxPageExportBytes || (format != "pdf" && format != "mhtml") {
		return PageExport{}, invalid
	}
	object, ok := value.(map[string]any)
	if !ok || len(object) != 5 {
		return PageExport{}, invalid
	}
	mime := "application/pdf"
	if format == "mhtml" {
		mime = "multipart/related"
	}
	data, dOK := object["data"].(string)
	number, nOK := object["byteLength"].(float64)
	if !nOK || number < 1 || number > float64(maxBytes) || math.IsNaN(number) || number != math.Trunc(number) || object["format"] != format || object["mimeType"] != mime || object["encoding"] != "base64" || !dOK || len(data) > 4*((maxBytes+2)/3) || len(data) != 4*((int(number)+2)/3) {
		return PageExport{}, invalid
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(data)
	if err != nil || len(decoded) != int(number) || base64.StdEncoding.EncodeToString(decoded) != data {
		return PageExport{}, invalid
	}
	return PageExport{Format: format, MimeType: mime, Encoding: "base64", Data: data, ByteLength: len(decoded)}, nil
}

func (t *Tab) ExportPage(format string, options ...ExportPageOptions) (PageExport, error) {
	if len(options) > 1 {
		return PageExport{}, errors.New("at most one page export options value is accepted")
	}
	var option ExportPageOptions
	if len(options) == 1 {
		option = options[0]
	}
	params, err := ExportPageParams(format, option)
	if err != nil {
		return PageExport{}, err
	}
	params["tabId"] = t.ID
	value, err := t.Browser.Client.requestWithTimeout("exportPage", params, time.Duration(params["timeoutMs"].(int64))*time.Millisecond+time.Second)
	if err != nil {
		return PageExport{}, err
	}
	return ValidatePageExport(value, format, params["maxBytes"].(int))
}

func (t *Tab) ExportPDF(options ...ExportPageOptions) (PageExport, error) {
	return t.ExportPage("pdf", options...)
}
func (t *Tab) ExportMHTML(options ...ExportPageOptions) (PageExport, error) {
	return t.ExportPage("mhtml", options...)
}
