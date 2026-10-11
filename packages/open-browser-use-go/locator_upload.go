package obu

import (
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

var locatorUploadDrive = regexp.MustCompile(`^[A-Za-z]:[\\/]`)
var locatorUploadUNC = regexp.MustCompile(`^\\\\[^\\/]+[\\/][^\\/]+([\\/]|$)`)

// Validate before encoding/json can replace malformed UTF-8 or allocate a large
// serialized request. The normalized validation also checks wire timeout types.
func validateLocatorUploadInput(params Params) error {
	var args map[string]any
	switch value := params["args"].(type) {
	case Params:
		args = value
	case map[string]any:
		args = value
	}
	if len(args) != 1 {
		return errors.New("setInputFiles requires only args.files")
	}
	var files []string
	switch value := args["files"].(type) {
	case []string:
		if value == nil || len(value) > 1024 {
			return errors.New("setInputFiles files must be an array of at most 1024 absolute paths")
		}
		files = value
	case []any:
		if value == nil || len(value) > 1024 {
			return errors.New("setInputFiles files must be an array of at most 1024 absolute paths")
		}
		files = make([]string, len(value))
		for i, path := range value {
			var ok bool
			files[i], ok = path.(string)
			if !ok {
				return errors.New("setInputFiles paths must be strings")
			}
		}
	default:
		return errors.New("setInputFiles files must be an array of at most 1024 absolute paths")
	}
	total := 0
	for _, path := range files {
		if path == "" || strings.ContainsRune(path, 0) || !utf8.ValidString(path) || !(strings.HasPrefix(path, "/") || locatorUploadDrive.MatchString(path) || locatorUploadUNC.MatchString(path)) {
			return errors.New("setInputFiles requires nonempty absolute UTF-8 paths without NUL")
		}
		total += len(path)
		if len(path) > 131072 || total > 8*1024*1024 {
			return errors.New("setInputFiles path byte limit exceeded")
		}
	}
	return nil
}

func validateLocatorUploadParams(params Params) error {
	if err := validateLocatorUploadInput(params); err != nil {
		return err
	}
	if value, exists := params["timeoutMs"]; exists {
		timeout, ok := value.(float64)
		if !ok || timeout < 1 || timeout > 120000 || timeout != float64(int64(timeout)) {
			return errors.New("setInputFiles timeoutMs must be an integer from 1 to 120000")
		}
	}
	return nil
}

func (c *Client) requireLocatorUpload(scope Params, deadline time.Time) error {
	params := scopedParams(scope, Params{"tabId": scope["tabId"], "action": "engineInfo"})
	if timeout, ok := scope["timeoutMs"]; ok {
		params["timeoutMs"] = timeout
	}
	response, err := c.requestLocked("browserAction", params, deadline)
	if err != nil {
		return err
	}
	envelope, ok := response.(map[string]any)
	engine, _ := envelope["engine"].(map[string]any)
	capabilities, _ := engine["capabilities"].(map[string]any)
	_, hasValue := envelope["value"]
	_, versionOK := engine["version"].(string)
	_, playwrightOK := engine["playwrightVersion"].(string)
	if !ok || !hasValue || engine["name"] != "playwright-crx" || !versionOK || !playwrightOK || capabilities["locatorFileUpload"] != float64(1) {
		return errors.New("OBU_LOCATOR_FILE_UPLOAD_UNSUPPORTED: extension does not advertise engine.capabilities.locatorFileUpload 1")
	}
	return nil
}

// SetInputFiles sets native absolute file paths (or one directory). Empty/nil clears.
func (l *Locator) SetInputFiles(files []string, options ...BrowserActionOptions) error {
	if len(files) > 1024 {
		return errors.New("setInputFiles files must be an array of at most 1024 absolute paths")
	}
	copyFiles := make([]string, len(files))
	copy(copyFiles, files)
	return l.perform("setInputFiles", Params{"files": copyFiles}, options)
}
