package obu

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

type DownloadOptions struct{ Timeout time.Duration }
type MediaDownloadOptions = DownloadURLOptions

type DownloadURLOptions struct {
	Filename string
	Timeout  time.Duration
}

// Download retains the start operation's original session, turn and epoch.
type Download struct {
	DownloadID string
	client     *Client
	params     Params
}

func isDownloadOperation(method string) bool {
	return method == "downloadURL" || method == "downloadMedia" || method == "downloadPath" || method == "cancelDownload"
}

func downloadTimeout(options []DownloadOptions) (time.Duration, error) {
	if len(options) > 1 {
		return 0, errors.New("at most one download options value is accepted")
	}
	timeout := 10 * time.Second
	if len(options) == 1 && options[0].Timeout != 0 {
		timeout = options[0].Timeout
	}
	if timeout < time.Millisecond || timeout > 120*time.Second || timeout%time.Millisecond != 0 {
		return 0, errors.New("download timeout must be an integer number of milliseconds from 1 to 120000")
	}
	return timeout, nil
}

var reservedDownloadBasename = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)`)

func downloadURLParams(rawURL string, options DownloadURLOptions) (Params, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || !utf8.ValidString(rawURL) || len(rawURL) > 8192 || parsed.Hostname() == "" || (strings.ToLower(parsed.Scheme) != "http" && strings.ToLower(parsed.Scheme) != "https") || parsed.User != nil || strings.TrimSpace(rawURL) != rawURL {
		return nil, errors.New("invalid download URL: require HTTP(S) without credentials")
	}
	for _, c := range rawURL {
		if c < 32 || c == 127 {
			return nil, errors.New("invalid download URL")
		}
	}
	params, err := downloadFileParams(options)
	if err != nil {
		return nil, err
	}
	params["url"] = rawURL
	return params, nil
}

func downloadFileParams(options DownloadURLOptions) (Params, error) {
	timeout, err := downloadTimeout([]DownloadOptions{{Timeout: options.Timeout}})
	if err != nil {
		return nil, err
	}
	params := Params{"timeoutMs": timeout.Milliseconds()}
	if name := options.Filename; name != "" {
		if !utf8.ValidString(name) || len(name) > 255 || strings.ContainsAny(name, "<>:\"/\\|?*") || strings.HasSuffix(name, ".") || strings.HasSuffix(name, " ") || reservedDownloadBasename.MatchString(name) {
			return nil, errors.New("invalid download filename: require a single portable basename")
		}
		for _, c := range name {
			if c < 32 || c == 127 {
				return nil, errors.New("invalid download filename")
			}
		}
		params["filename"] = name
	}
	return params, nil
}

func (t *Tab) DownloadURL(url string, options ...DownloadURLOptions) (*Download, error) {
	if len(options) > 1 {
		return nil, errors.New("at most one download URL options value is accepted")
	}
	var option DownloadURLOptions
	if len(options) == 1 {
		option = options[0]
	}
	params, err := downloadURLParams(url, option)
	if err != nil {
		return nil, err
	}
	return t.startDownload("downloadURL", params)
}

// DownloadMedia starts a new GET from the exact image's selected HTTP(S) source.
func (l *Locator) DownloadMedia(options ...MediaDownloadOptions) (*Download, error) {
	if l.err != nil {
		return nil, l.err
	}
	if len(l.locatorSteps()) == 0 {
		return nil, errors.New("DownloadMedia requires a nonempty locator")
	}
	if len(options) > 1 {
		return nil, errors.New("at most one media download options value is accepted")
	}
	var option MediaDownloadOptions
	if len(options) == 1 {
		option = options[0]
	}
	params, err := downloadFileParams(option)
	if err != nil {
		return nil, err
	}
	params["locator"] = l.locatorSteps()
	return l.Tab.startDownload("downloadMedia", params)
}

func (t *Tab) WaitForDownload(options ...DownloadOptions) (*Download, error) {
	timeout, err := downloadTimeout(options)
	if err != nil {
		return nil, err
	}
	return t.startDownload("waitForDownload", Params{"timeoutMs": timeout.Milliseconds()})
}

func (t *Tab) startDownload(method string, params Params) (*Download, error) {
	client := t.Browser.Client
	params["tabId"] = t.ID
	timeout := time.Duration(params["timeoutMs"].(int64)) * time.Millisecond
	value, err := client.requestInScope(method, params, timeout+time.Second, func(metadata Params, deadline time.Time) (any, error) {
		epoch, ok := metadata["control_epoch"].(int64)
		if !ok || epoch < 1 {
			return nil, errors.New("download handles require an explicit control epoch")
		}
		binding := scopedParams(metadata, nil)
		value, err := client.requestLocked(method, metadata, deadline)
		if err != nil {
			return nil, err
		}
		object, ok := value.(map[string]any)
		if !ok || len(object) != 1 || !networkString(object["downloadId"], 256, false) {
			return nil, errors.New("invalid download acknowledgement")
		}
		id := object["downloadId"].(string)
		binding["downloadId"] = id
		return &Download{DownloadID: id, client: client, params: binding}, nil
	})
	if err != nil {
		return nil, err
	}
	return value.(*Download), nil
}

func (d *Download) call(method string, options []DownloadOptions) (any, error) {
	timeout, err := downloadTimeout(options)
	if err != nil {
		return nil, err
	}
	params := scopedParams(d.params, Params{"downloadId": d.params["downloadId"], "timeoutMs": timeout.Milliseconds()})
	if tabID, exists := d.params["tabId"]; exists {
		params["tabId"] = tabID
	}
	return d.client.requestWithTimeout(method, params, timeout+time.Second)
}

func (d *Download) Path(options ...DownloadOptions) (string, error) {
	value, err := d.call("downloadPath", options)
	if err != nil {
		return "", err
	}
	object, ok := value.(map[string]any)
	if !ok || len(object) != 1 {
		return "", errors.New("invalid download path acknowledgement")
	}
	path, ok := object["path"].(string)
	if !ok || path == "" || strings.ContainsRune(path, '\x00') || !utf8.ValidString(path) {
		return "", errors.New("invalid download path acknowledgement")
	}
	return path, nil
}

func (d *Download) Cancel(options ...DownloadOptions) error {
	value, err := d.call("cancelDownload", options)
	if err != nil {
		return err
	}
	object, ok := value.(map[string]any)
	if !ok || len(object) != 1 || object["cancelled"] != true {
		return errors.New("invalid download cancellation acknowledgement")
	}
	return nil
}
