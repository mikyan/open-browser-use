// Read exactly one original response through the public typed Go facade.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
	"io"
	"os"
	"time"
)

type config struct {
	Endpoint string `json:"endpoint"`
	TabID    int    `json:"tabId"`
	Scope    struct {
		SessionID    string `json:"session_id"`
		TurnID       string `json:"turn_id"`
		ControlEpoch int64  `json:"control_epoch"`
	} `json:"scope"`
	Reference obu.ResponseBodyRef `json:"reference"`
	MaxBytes  int                 `json:"maxBytes"`
	TimeoutMS int                 `json:"timeoutMs"`
}

func run(c config) (result map[string]any, err error) {
	browser, err := obu.ConnectOpenBrowserUse(obu.Options{SocketPath: c.Endpoint, SessionID: c.Scope.SessionID, TurnID: c.Scope.TurnID, Timeout: 15 * time.Second})
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, browser.Close()) }()
	state, err := browser.Client.Request("getControlState", obu.Params{})
	if err != nil {
		return nil, err
	}
	object, ok := state.(map[string]any)
	if !ok || object["controlEpoch"] != float64(c.Scope.ControlEpoch) || object["closing"] == true {
		return nil, errors.New("original response reader scope changed")
	}
	value, err := browser.Tab(c.TabID).ResponseBody(c.Reference, obu.ResponseBodyOptions{MaxBytes: c.MaxBytes, Timeout: time.Duration(c.TimeoutMS) * time.Millisecond})
	if err != nil {
		return nil, err
	}
	return map[string]any{"caller": "go", "scope": c.Scope, "tabId": c.TabID, "value": value}, nil
}

func main() {
	var c config
	err := json.NewDecoder(io.LimitReader(os.Stdin, 32769)).Decode(&c)
	var value map[string]any
	if err == nil {
		value, err = run(c)
	}
	if err != nil {
		value = map[string]any{"error": err.Error()}
	}
	data, encodeErr := json.Marshal(value)
	if encodeErr != nil {
		fmt.Fprintln(os.Stderr, encodeErr)
		os.Exit(1)
	}
	fmt.Println(string(data))
	if err != nil {
		os.Exit(1)
	}
}
