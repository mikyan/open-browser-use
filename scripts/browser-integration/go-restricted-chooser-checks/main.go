// Public typed chooser workflow; the parent retains the private evidence oracle.
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
	Layout string   `json:"layout"`
	Paths  []string `json:"paths"`
}

func run(endpoint string, c config, detail map[string]any) (err error) {
	detail["scope"], detail["tabId"] = c.Scope, c.TabID
	rounds, receipts := []map[string]any{}, []any{}
	detail["waits"], detail["receipts"] = rounds, receipts
	browser, err := obu.ConnectOpenBrowserUse(obu.Options{SocketPath: endpoint, SessionID: c.Scope.SessionID, TurnID: c.Scope.TurnID, Timeout: 15 * time.Second})
	if err != nil {
		return err
	}
	defer func() {
		if failure := browser.Close(); failure != nil {
			detail["connectionCleanupError"] = failure.Error()
			err = errors.Join(err, failure)
		}
	}()
	state, err := browser.Client.Request("getControlState", obu.Params{})
	if err != nil {
		return err
	}
	control, ok := state.(map[string]any)
	if !ok || control["controlEpoch"] != float64(c.Scope.ControlEpoch) || control["closing"] == true {
		return errors.New("original chooser caller scope changed")
	}
	tab := browser.Tab(c.TabID)
	upload, receiptNode := tab.GetByLabel("Upload fixture", obu.TextOptions{Exact: true}), tab.Locator("#receipt")
	if c.Layout != "root" {
		upload = tab.FrameLocator("#upload-frame").GetByLabel("Upload fixture", obu.TextOptions{Exact: true})
		receiptNode = tab.FrameLocator("#upload-frame").Locator("#receipt")
	}
	for sequence := 1; sequence <= 2; sequence++ {
		round := map[string]any{"sequence": sequence, "armStartedAt": time.Now().UnixMilli()}
		rounds = append(rounds, round)
		detail["waits"] = rounds
		err = func() (failure error) {
			wait, failure := tab.ExpectFileChooser(obu.FileChooserWaitOptions{Timeout: 10 * time.Second})
			if failure != nil {
				return failure
			}
			round["waiterId"], round["remainingMs"], round["readyAt"] = wait.WaiterID, wait.RemainingMS, time.Now().UnixMilli()
			defer func() {
				if cancelErr := wait.Cancel(); cancelErr != nil {
					round["cancelError"] = cancelErr.Error()
					failure = errors.Join(failure, cancelErr)
				} else {
					round["cancelled"] = true
				}
			}()
			if sequence == 1 && c.Layout == "dynamic-oopif" {
				if failure = tab.GetByRole("button", obu.RoleOptions{Name: "Add upload frame", Exact: true}).Click(); failure != nil {
					return failure
				}
			}
			round["triggerSubmittedAt"] = time.Now().UnixMilli()
			if failure = upload.Click(obu.BrowserActionOptions{Timeout: 5 * time.Second}); failure != nil {
				return failure
			}
			round["triggerCompletedAt"] = time.Now().UnixMilli()
			chosen, failure := wait.Result()
			if failure != nil {
				return failure
			}
			round["result"], round["collectedAt"] = chosen, time.Now().UnixMilli()
			if chosen.IsMultiple != (c.Layout != "root") {
				return errors.New("original chooser multiple flag changed")
			}
			paths := []string{}
			if sequence == 1 {
				paths = append(paths, c.Paths...)
			}
			round["files"], round["setStartedAt"] = paths, time.Now().UnixMilli()
			value, failure := browser.Client.SetFileChooserFiles(chosen.FileChooserID, paths)
			if failure != nil {
				return failure
			}
			round["setResult"], round["setCompletedAt"] = value, time.Now().UnixMilli()
			deadline := time.Now().Add(5 * time.Second)
			for attempt := 0; ; attempt++ {
				raw, failure := receiptNode.TextContent()
				if failure != nil {
					return failure
				}
				var receipt map[string]any
				if raw != nil && *raw != "" {
					if failure = json.Unmarshal([]byte(*raw), &receipt); failure != nil {
						return failure
					}
				}
				if receipt != nil && receipt["sequence"] == float64(sequence) {
					round["receipt"] = receipt
					receipts = append(receipts, receipt)
					detail["receipts"] = receipts
					return nil
				}
				if !time.Now().Before(deadline) || attempt >= 100 {
					return errors.New("original chooser receipt did not arrive")
				}
				time.Sleep(25 * time.Millisecond)
			}
		}()
		if err != nil {
			round["error"] = err.Error()
			return err
		}
	}
	return nil
}

func main() {
	if len(os.Args) != 4 {
		panic("usage: restricted-chooser-checks endpoint config output")
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
