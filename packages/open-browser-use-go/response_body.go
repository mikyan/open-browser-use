package obu

import (
	"encoding/base64"
	"errors"
	"math"
	"time"
	"unicode/utf8"
)

const MaxResponseBodyBytes = 8 * 1024 * 1024
const DefaultResponseBodyBytes = 1024 * 1024

type ResponseBodyRef struct {
	CaptureID string `json:"captureId"`
	RequestID string `json:"requestId"`
}
type ResponseBodyOptions struct {
	MaxBytes int           // Zero selects the 1 MiB default; maximum 8 MiB.
	Timeout  time.Duration // Zero selects 10 seconds; otherwise whole milliseconds.
}

// ResponseBody is the Chrome-decoded representation of an original response.
// No URL is fetched and no local file is written by this operation.
type ResponseBody struct {
	CaptureID  string `json:"captureId"`
	RequestID  string `json:"requestId"`
	Encoding   string `json:"encoding"`
	Data       string `json:"data"`
	ByteLength int    `json:"byteLength"`
}

func responseBodyInvalid() error {
	return errors.New("OBU_RESPONSE_BODY_INVALID: invalid response body reference or options")
}
func bodyIdentifier(value string) bool {
	return len(value) > 0 && len(value) <= 128 && utf8.ValidString(value)
}
func bodyInteger(value any, minimum, maximum float64) bool {
	var n float64
	switch v := value.(type) {
	case int:
		n = float64(v)
	case int64:
		n = float64(v)
	case float64:
		n = v
	default:
		return false
	}
	return !math.IsNaN(n) && n >= minimum && n <= maximum && n == math.Trunc(n)
}
func bodyMap(value any) (map[string]any, bool) {
	switch v := value.(type) {
	case Params:
		return v, true
	case map[string]any:
		return v, true
	default:
		return nil, false
	}
}
func ResponseBodyParams(ref ResponseBodyRef, options ResponseBodyOptions) (Params, error) {
	maximum, timeout := options.MaxBytes, options.Timeout
	if maximum == 0 {
		maximum = DefaultResponseBodyBytes
	}
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	if !bodyIdentifier(ref.CaptureID) || !bodyIdentifier(ref.RequestID) || maximum < 1 || maximum > MaxResponseBodyBytes || timeout < time.Millisecond || timeout > 120*time.Second || timeout%time.Millisecond != 0 {
		return nil, responseBodyInvalid()
	}
	return Params{"args": Params{"captureId": ref.CaptureID, "requestId": ref.RequestID, "maxBytes": maximum}, "timeoutMs": timeout.Milliseconds()}, nil
}

// ValidateResponseBodyParams runs before JSON encoding, so invalid UTF-8 cannot
// silently become a different diagnostic reference during serialization.
func ValidateResponseBodyParams(params Params) error {
	for key := range params {
		switch key {
		case "session_id", "turn_id", "control_epoch", "tabId", "action", "args", "timeoutMs":
		default:
			return responseBodyInvalid()
		}
	}
	if params["action"] != "responseBody" || !bodyInteger(params["tabId"], 0, 9007199254740991) {
		return responseBodyInvalid()
	}
	args, ok := bodyMap(params["args"])
	if !ok {
		return responseBodyInvalid()
	}
	for key := range args {
		if key != "captureId" && key != "requestId" && key != "maxBytes" {
			return responseBodyInvalid()
		}
	}
	capture, cok := args["captureId"].(string)
	request, rok := args["requestId"].(string)
	if !cok || !rok || !bodyIdentifier(capture) || !bodyIdentifier(request) {
		return responseBodyInvalid()
	}
	if n, exists := args["maxBytes"]; exists && !bodyInteger(n, 1, MaxResponseBodyBytes) {
		return responseBodyInvalid()
	}
	if n, exists := params["timeoutMs"]; exists && !bodyInteger(n, 1, 120000) {
		return responseBodyInvalid()
	}
	return nil
}
func ValidateResponseBody(value any, ref ResponseBodyRef, maximum int) (ResponseBody, error) {
	failure := errors.New("OBU_RESPONSE_BODY_FAILED: invalid response body result")
	object, ok := bodyMap(value)
	if !ok || len(object) != 5 || maximum < 1 || maximum > MaxResponseBodyBytes {
		return ResponseBody{}, failure
	}
	data, dok := object["data"].(string)
	if !dok || object["captureId"] != ref.CaptureID || object["requestId"] != ref.RequestID || object["encoding"] != "base64" || !bodyInteger(object["byteLength"], 0, float64(maximum)) {
		return ResponseBody{}, failure
	}
	var length int
	switch n := object["byteLength"].(type) {
	case int:
		length = n
	case int64:
		length = int(n)
	case float64:
		length = int(n)
	}
	if len(data) > 4*((maximum+2)/3) || len(data) != 4*((length+2)/3) {
		return ResponseBody{}, failure
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(data)
	if err != nil || len(decoded) != length || base64.StdEncoding.EncodeToString(decoded) != data {
		return ResponseBody{}, failure
	}
	return ResponseBody{ref.CaptureID, ref.RequestID, "base64", data, length}, nil
}
func ValidateResponseBodyEnvelope(value any, params Params) error {
	if err := ValidateResponseBodyParams(params); err != nil {
		return err
	}
	envelope, _ := bodyMap(value)
	engine, _ := bodyMap(envelope["engine"])
	caps, _ := bodyMap(engine["capabilities"])
	_, vok := engine["version"].(string)
	_, pok := engine["playwrightVersion"].(string)
	if engine["name"] != "playwright-crx" || !vok || !pok {
		return errors.New("OBU_RESPONSE_BODY_FAILED: invalid response body envelope")
	}
	if !bodyInteger(caps["responseBody"], 1, 1) {
		return errors.New("OBU_RESPONSE_BODY_UNSUPPORTED: extension engine does not advertise responseBody 1")
	}
	args, _ := bodyMap(params["args"])
	maximum := DefaultResponseBodyBytes
	if v, exists := args["maxBytes"]; exists {
		switch n := v.(type) {
		case int:
			maximum = n
		case int64:
			maximum = int(n)
		case float64:
			maximum = int(n)
		}
	}
	_, err := ValidateResponseBody(envelope["value"], ResponseBodyRef{args["captureId"].(string), args["requestId"].(string)}, maximum)
	return err
}
func (t *Tab) ResponseBody(ref ResponseBodyRef, options ...ResponseBodyOptions) (ResponseBody, error) {
	if len(options) > 1 {
		return ResponseBody{}, responseBodyInvalid()
	}
	opts := ResponseBodyOptions{}
	if len(options) == 1 {
		opts = options[0]
	}
	params, err := ResponseBodyParams(ref, opts)
	if err != nil {
		return ResponseBody{}, err
	}
	args := params["args"].(Params)
	value, err := t.Action("responseBody", BrowserActionOptions{Args: args, Timeout: time.Duration(params["timeoutMs"].(int64)) * time.Millisecond})
	if err != nil {
		return ResponseBody{}, err
	}
	return ValidateResponseBody(value, ref, args["maxBytes"].(int))
}
func (p *TabPlaywright) ResponseBody(ref ResponseBodyRef, options ...ResponseBodyOptions) (ResponseBody, error) {
	return p.tab.ResponseBody(ref, options...)
}
