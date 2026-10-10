package obu

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"strconv"
	"time"
	"unicode/utf8"
)

const MaxClipboardBytes = 16 * 1024 * 1024
const maxClipboardJSONBytes = 48 * 1024 * 1024

func boundedClipboardWire(value map[string]any) (map[string]any, error) {
	// Use the same encoder (including HTML escapes) as the native host. This
	// bound leaves transport-envelope space beneath the 64 MiB frame limit.
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if len(encoded) > maxClipboardJSONBytes {
		return nil, errors.New("OBU_CLIPBOARD_LIMIT: encoded clipboard body exceeds 48 MiB")
	}
	return value, nil
}

// encoding/json replaces malformed UTF-8 and unpaired UTF-16 escapes. Check
// the original clipboard response before that lossy conversion can hide them.
func validateClipboardJSONUnicode(data []byte) error {
	invalid := errors.New("invalid clipboard UTF-8 JSON text")
	if !utf8.Valid(data) {
		return invalid
	}
	for i := 0; i < len(data); i++ {
		if data[i] != '\\' {
			continue
		}
		i++
		if i >= len(data) {
			return invalid
		}
		if data[i] != 'u' {
			continue
		}
		if i+4 >= len(data) {
			return invalid
		}
		number, err := strconv.ParseUint(string(data[i+1:i+5]), 16, 16)
		if err != nil {
			return invalid
		}
		i += 4
		if number >= 0xDC00 && number <= 0xDFFF {
			return invalid
		}
		if number >= 0xD800 && number <= 0xDBFF {
			if i+6 >= len(data) || data[i+1] != '\\' || data[i+2] != 'u' {
				return invalid
			}
			low, err := strconv.ParseUint(string(data[i+3:i+7]), 16, 16)
			if err != nil || low < 0xDC00 || low > 0xDFFF {
				return invalid
			}
			i += 6
		}
	}
	return nil
}

type ClipboardOptions struct {
	MaxBytes int           // Zero selects 16 MiB.
	Timeout  time.Duration // Zero selects 10 seconds.
}
type ClipboardEntry struct {
	MIMEType string  `json:"mime_type"`
	Text     *string `json:"text,omitempty"`
	Base64   *string `json:"base64,omitempty"`
}
type ClipboardItem struct {
	Entries           []ClipboardEntry `json:"entries"`
	PresentationStyle string           `json:"presentation_style,omitempty"`
}

func isClipboardMethod(method string) bool {
	return method == "readClipboardText" || method == "writeClipboardText" || method == "readClipboard" || method == "writeClipboard"
}
func clipboardKeys(value map[string]any, allowed ...string) error {
	for key := range value {
		found := false
		for _, name := range allowed {
			if key == name {
				found = true
				break
			}
		}
		if !found {
			return errors.New("invalid clipboard fields")
		}
	}
	return nil
}
func clipboardObject(value any) (map[string]any, bool) {
	switch object := value.(type) {
	case map[string]any:
		return object, true
	case Params:
		return map[string]any(object), true
	}
	return nil, false
}
func clipboardArray(value any) ([]any, bool) {
	switch array := value.(type) {
	case []any:
		return array, array != nil
	case []Params:
		if array == nil {
			return nil, false
		}
		result := make([]any, len(array))
		for i, item := range array {
			result[i] = item
		}
		return result, true
	}
	return nil, false
}
func clipboardTextBytes(value any) (int, error) {
	text, ok := value.(string)
	if !ok || !utf8.ValidString(text) {
		return 0, errors.New("invalid clipboard UTF-8 text")
	}
	return len(text), nil
}
func clipboardPNGBytes(value any, maximum int) (int, error) {
	invalid := errors.New("invalid clipboard PNG")
	encoded, ok := value.(string)
	if !ok || len(encoded) > 4*((maximum+2)/3) {
		return 0, invalid
	}
	data, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(data) < 33 || len(data) > maximum || base64.StdEncoding.EncodeToString(data) != encoded || string(data[:8]) != "\x89PNG\r\n\x1a\n" || binary.BigEndian.Uint32(data[8:12]) != 13 || string(data[12:16]) != "IHDR" {
		return 0, invalid
	}
	width, height := uint64(binary.BigEndian.Uint32(data[16:20])), uint64(binary.BigEndian.Uint32(data[20:24]))
	depths := map[byte][]byte{0: {1, 2, 4, 8, 16}, 2: {8, 16}, 3: {1, 2, 4, 8}, 4: {8, 16}, 6: {8, 16}}
	depthOK := false
	for _, depth := range depths[data[25]] {
		if data[24] == depth {
			depthOK = true
		}
	}
	if width == 0 || height == 0 || width*height > 16777216 || !depthOK || data[26] != 0 || data[27] != 0 || data[28] > 1 {
		return 0, errors.New("invalid clipboard PNG IHDR or pixel limit")
	}
	// Structural preflight only; the trusted browser adapter must fully decode.
	return len(data), nil
}
func validateClipboardItems(value any, maximum int) ([]any, error) {
	items, ok := clipboardArray(value)
	if !ok || len(items) > 1 {
		return nil, errors.New("clipboard items must contain at most one item")
	}
	result := make([]any, 0, len(items))
	total := 0
	for _, raw := range items {
		item, ok := clipboardObject(raw)
		if !ok {
			return nil, errors.New("invalid clipboard item")
		}
		if err := clipboardKeys(item, "entries", "presentation_style"); err != nil {
			return nil, err
		}
		if style, exists := item["presentation_style"]; exists && style != "unspecified" && style != "inline" && style != "attachment" {
			return nil, errors.New("invalid clipboard presentation_style")
		}
		entries, ok := clipboardArray(item["entries"])
		if !ok || len(entries) < 1 || len(entries) > 3 {
			return nil, errors.New("invalid clipboard entries")
		}
		copied := make([]any, 0, len(entries))
		seen := map[string]bool{}
		for _, rawEntry := range entries {
			entry, ok := clipboardObject(rawEntry)
			if !ok {
				return nil, errors.New("invalid clipboard entry")
			}
			mime, ok := entry["mime_type"].(string)
			if !ok || seen[mime] {
				return nil, errors.New("invalid or duplicate clipboard MIME type")
			}
			seen[mime] = true
			var size int
			var err error
			var normalized map[string]any
			switch mime {
			case "text/plain", "text/html":
				if err = clipboardKeys(entry, "mime_type", "text"); err != nil {
					return nil, err
				}
				size, err = clipboardTextBytes(entry["text"])
				normalized = map[string]any{"mime_type": mime, "text": entry["text"]}
			case "image/png":
				if err = clipboardKeys(entry, "mime_type", "base64"); err != nil {
					return nil, err
				}
				size, err = clipboardPNGBytes(entry["base64"], maximum)
				normalized = map[string]any{"mime_type": mime, "base64": entry["base64"]}
			default:
				return nil, errors.New("unsupported clipboard MIME type")
			}
			if err != nil {
				return nil, err
			}
			total += size
			if total > maximum {
				return nil, errors.New("clipboard byte limit exceeded")
			}
			copied = append(copied, normalized)
		}
		normalized := map[string]any{"entries": copied}
		if style, exists := item["presentation_style"]; exists {
			normalized["presentation_style"] = style
		}
		result = append(result, normalized)
	}
	return result, nil
}

// ClipboardParams validates and copies payload before any discovery or JSON encoding.
func ClipboardParams(method string, tabID int, payload Params, options ClipboardOptions) (Params, error) {
	if !isClipboardMethod(method) || tabID < 0 || int64(tabID) > 9007199254740991 {
		return nil, errors.New("invalid clipboard request")
	}
	maximum, timeout := options.MaxBytes, options.Timeout
	if maximum == 0 {
		maximum = MaxClipboardBytes
	}
	if maximum < 1 || maximum > MaxClipboardBytes {
		return nil, errors.New("invalid clipboard maxBytes")
	}
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	if timeout < time.Millisecond || timeout > 120*time.Second || timeout%time.Millisecond != 0 {
		return nil, errors.New("invalid clipboard timeoutMs")
	}
	allowed := []string{}
	if method == "writeClipboardText" {
		allowed = []string{"text"}
	}
	if method == "writeClipboard" {
		allowed = []string{"items"}
	}
	if err := clipboardKeys(payload, allowed...); err != nil {
		return nil, err
	}
	result := Params{"tabId": tabID, "maxBytes": maximum, "timeoutMs": timeout.Milliseconds()}
	if method == "writeClipboardText" {
		size, err := clipboardTextBytes(payload["text"])
		if err != nil {
			return nil, err
		}
		if size > maximum {
			return nil, errors.New("clipboard byte limit exceeded")
		}
		result["text"] = payload["text"]
	} else if method == "writeClipboard" {
		items, err := validateClipboardItems(payload["items"], maximum)
		if err != nil {
			return nil, err
		}
		result["items"] = items
	}
	bounded, err := boundedClipboardWire(result)
	return Params(bounded), err
}
func ValidateClipboardResult(method string, value any, maxBytes int) (map[string]any, error) {
	if maxBytes < 1 || maxBytes > MaxClipboardBytes {
		return nil, errors.New("invalid clipboard maxBytes")
	}
	object, ok := clipboardObject(value)
	if !ok || object == nil {
		return nil, errors.New("invalid clipboard result")
	}
	if method == "readClipboardText" {
		if err := clipboardKeys(object, "text"); err != nil {
			return nil, err
		}
		size, err := clipboardTextBytes(object["text"])
		if err != nil {
			return nil, err
		}
		if size > maxBytes {
			return nil, errors.New("clipboard byte limit exceeded")
		}
		return boundedClipboardWire(map[string]any{"text": object["text"]})
	}
	if method == "readClipboard" {
		if err := clipboardKeys(object, "items"); err != nil {
			return nil, err
		}
		items, err := validateClipboardItems(object["items"], maxBytes)
		if err != nil {
			return nil, err
		}
		return boundedClipboardWire(map[string]any{"items": items})
	}
	if method != "writeClipboard" && method != "writeClipboardText" {
		return nil, errors.New("invalid clipboard method")
	}
	if err := clipboardKeys(object); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}
func (c *Client) clipboard(method string, tabID int, payload Params, options ...ClipboardOptions) (any, error) {
	if len(options) > 1 {
		return nil, errors.New("at most one clipboard options value is accepted")
	}
	var option ClipboardOptions
	if len(options) == 1 {
		option = options[0]
	}
	params, err := ClipboardParams(method, tabID, payload, option)
	if err != nil {
		return nil, err
	}
	value, err := c.requestWithTimeout(method, params, time.Duration(params["timeoutMs"].(int64))*time.Millisecond+time.Second)
	if err != nil {
		return nil, err
	}
	return ValidateClipboardResult(method, value, params["maxBytes"].(int))
}

type TabClipboard struct{ tab *Tab }

func (t *Tab) Clipboard() *TabClipboard { return &TabClipboard{tab: t} }
func (c *TabClipboard) ReadText(options ...ClipboardOptions) (string, error) {
	value, err := c.tab.Browser.Client.ReadClipboardText(c.tab.ID, options...)
	if err != nil {
		return "", err
	}
	return value.(map[string]any)["text"].(string), nil
}
func (c *TabClipboard) WriteText(text string, options ...ClipboardOptions) error {
	_, err := c.tab.Browser.Client.WriteClipboardText(c.tab.ID, text, options...)
	return err
}
func (c *TabClipboard) Read(options ...ClipboardOptions) ([]ClipboardItem, error) {
	value, err := c.tab.Browser.Client.ReadClipboard(c.tab.ID, options...)
	if err != nil {
		return nil, err
	}
	result := []ClipboardItem{}
	for _, raw := range value.(map[string]any)["items"].([]any) {
		item := raw.(map[string]any)
		copied := ClipboardItem{Entries: []ClipboardEntry{}}
		copied.PresentationStyle, _ = item["presentation_style"].(string)
		for _, rawEntry := range item["entries"].([]any) {
			entry := rawEntry.(map[string]any)
			e := ClipboardEntry{MIMEType: entry["mime_type"].(string)}
			if text, ok := entry["text"].(string); ok {
				e.Text = &text
			}
			if data, ok := entry["base64"].(string); ok {
				e.Base64 = &data
			}
			copied.Entries = append(copied.Entries, e)
		}
		result = append(result, copied)
	}
	return result, nil
}
func (c *TabClipboard) Write(items []ClipboardItem, options ...ClipboardOptions) error {
	wireItems := make([]Params, 0, len(items))
	for _, item := range items {
		entries := make([]Params, 0, len(item.Entries))
		for _, entry := range item.Entries {
			e := Params{"mime_type": entry.MIMEType}
			if entry.Text != nil {
				e["text"] = *entry.Text
			}
			if entry.Base64 != nil {
				e["base64"] = *entry.Base64
			}
			entries = append(entries, e)
		}
		i := Params{"entries": entries}
		if item.PresentationStyle != "" {
			i["presentation_style"] = item.PresentationStyle
		}
		wireItems = append(wireItems, i)
	}
	_, err := c.tab.Browser.Client.WriteClipboard(c.tab.ID, wireItems, options...)
	return err
}
