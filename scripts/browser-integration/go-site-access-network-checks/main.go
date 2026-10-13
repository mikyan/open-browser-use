// One typed scoped workflow. The parent verifies original native and HTTP evidence.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
)

type config struct {
	TabID int `json:"tabId"`
	Scope struct {
		SessionID    string `json:"session_id"`
		TurnID       string `json:"turn_id"`
		ControlEpoch int64  `json:"control_epoch"`
	} `json:"scope"`
	Layout string `json:"layout"`
	Key    string `json:"key"`
	APIURL string `json:"apiURL"`
	Value  string `json:"value"`
}

func run(endpoint string, c config, detail map[string]any) (err error) {
	detail["scope"], detail["tabId"] = c.Scope, c.TabID
	browser, err := obu.ConnectOpenBrowserUse(obu.Options{SocketPath: endpoint, SessionID: c.Scope.SessionID, TurnID: c.Scope.TurnID, Timeout: 15 * time.Second})
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, browser.Close()) }()
	state, err := browser.Client.Request("getControlState", obu.Params{})
	if err != nil {
		return err
	}
	control, ok := state.(map[string]any)
	if !ok || control["controlEpoch"] != float64(c.Scope.ControlEpoch) || control["closing"] == true {
		return errors.New("original network caller scope changed")
	}
	tab := browser.Tab(c.TabID)
	waits := []*obu.NetworkWait{}
	defer func() {
		detail["cancelled"] = true
		for _, wait := range waits {
			if cleanupErr := wait.Cancel(); cleanupErr != nil {
				detail["cancelled"] = false
				err = errors.Join(err, cleanupErr)
			}
		}
	}()
	for _, event := range []string{"request", "response"} {
		match := obu.NetworkWaitMatch{URL: c.APIURL, Method: "POST"}
		var wait *obu.NetworkWait
		if event == "request" {
			wait, err = tab.ExpectRequest(match, obu.NetworkWaitOptions{Timeout: 10 * time.Second})
		} else {
			match.Status = 201
			wait, err = tab.ExpectResponse(match, obu.NetworkWaitOptions{Timeout: 10 * time.Second})
		}
		if err != nil {
			return err
		}
		waits = append(waits, wait)
		detail[event+"Ack"] = map[string]any{"waiterId": wait.WaiterID, "remainingMs": wait.RemainingMS}
	}
	locator := func(selector string) *obu.Locator {
		if c.Layout == "root" {
			return tab.Locator(selector)
		}
		return tab.FrameLocator("#network-frame").Locator(selector)
	}
	if c.Layout == "dynamic-oopif" {
		if err = tab.Locator("#add-network-frame").Click(); err != nil {
			return err
		}
	}
	if err = locator("#note").Fill(c.Value); err != nil {
		return err
	}
	if err = locator("#save").Click(); err != nil {
		return err
	}
	if detail["request"], err = waits[0].Result(); err != nil {
		return err
	}
	if detail["response"], err = waits[1].Result(); err != nil {
		return err
	}
	if detail["responseAgain"], err = waits[1].Result(); err != nil {
		return err
	}
	if err = locator(fmt.Sprintf("#receipt:has-text(%q)", "Saved "+c.Key+" 1 ")).WaitFor("visible", obu.BrowserActionOptions{Timeout: 5 * time.Second}); err != nil {
		return err
	}
	var receipt *string
	if receipt, err = locator("#receipt").TextContent(); err != nil {
		return err
	}
	if receipt == nil {
		return errors.New("original network receipt missing")
	}
	detail["receipt"] = *receipt
	return nil
}

func main() {
	if len(os.Args) != 4 {
		panic("usage: network-checks endpoint config output")
	}
	detail := map[string]any{}
	data, err := os.ReadFile(os.Args[2])
	var c config
	if err == nil {
		err = json.Unmarshal(data, &c)
	}
	if err == nil {
		err = run(os.Args[1], c, detail)
	}
	if err != nil {
		detail["error"] = err.Error()
	}
	encoded, encodeErr := json.Marshal(detail)
	if encodeErr != nil {
		panic(encodeErr)
	}
	file, fileErr := os.OpenFile(os.Args[3], os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if fileErr != nil {
		panic(fileErr)
	}
	if _, fileErr = file.Write(append(encoded, '\n')); fileErr != nil {
		panic(fileErr)
	}
	if fileErr = file.Close(); fileErr != nil {
		panic(fileErr)
	}
	fmt.Println(string(encoded))
	if err != nil {
		os.Exit(1)
	}
}
