// Two independent synchronous SDK connections; arm acknowledgement precedes click.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"time"

	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
)

func run(endpoint, base, prefix string, files []string) (result map[string]any, err error) {
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme != "http" || (parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost") {
		return nil, errors.New("loopback fixture required")
	}
	options := obu.Options{SocketPath: endpoint, SessionID: prefix, TurnID: "chooser-ready", Timeout: 15 * time.Second}
	owner, err := obu.ConnectOpenBrowserUse(options)
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, owner.Close()) }()
	trigger, err := obu.ConnectOpenBrowserUse(options)
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, trigger.Close()) }()
	// Node retains this exact session for live OOPIF/HTTP evidence, then finalizes.
	info, err := owner.Client.GetInfo()
	if err != nil {
		return nil, err
	}
	if info.(map[string]any)["metadata"].(map[string]any)["fileChooserWaitVersion"] != float64(1) {
		return nil, errors.New("file chooser waits unsupported")
	}
	variants := []map[string]any{}
	for _, variant := range []string{"root", "oopif", "dynamic-oopif"} {
		key := prefix + "-" + variant
		tab, err := owner.NewTab()
		if err != nil {
			return nil, err
		}
		_, err = owner.CDP.Navigate(tab.ID, base+"chooser-waits/page?"+url.Values{"key": {key}, "variant": {variant}}.Encode(), obu.GotoOptions{})
		if err != nil {
			return nil, err
		}
		sender := trigger.Tab(tab.ID)
		waits, receipts := []map[string]any{}, []any{}
		for sequence := 1; sequence <= 2; sequence++ {
			wait, err := tab.ExpectFileChooser(obu.FileChooserWaitOptions{Timeout: 10 * time.Second})
			if err != nil {
				return nil, err
			}
			event := map[string]any{"waiterId": wait.WaiterID, "remainingMs": wait.RemainingMS, "readyAt": time.Now().UnixMilli()}
			failure := func() (stepErr error) {
				defer func() { stepErr = errors.Join(stepErr, wait.Cancel()) }()
				if variant == "dynamic-oopif" && sequence == 1 {
					if err := sender.GetByRole("button", obu.RoleOptions{Name: "Add upload frame", Exact: true}).Click(); err != nil {
						return err
					}
				}
				input := sender.GetByLabel("Upload fixture", obu.TextOptions{Exact: true})
				receiptNode := sender.Locator("#receipt")
				if variant != "root" {
					frame := sender.FrameLocator("#upload-frame")
					input = frame.GetByLabel("Upload fixture", obu.TextOptions{Exact: true})
					receiptNode = frame.Locator("#receipt")
				}
				event["triggerSubmittedAt"] = time.Now().UnixMilli()
				if err := input.Click(); err != nil {
					return err
				}
				chosen, err := wait.Result()
				if err != nil {
					return err
				}
				event["result"] = chosen
				event["collectedAt"] = time.Now().UnixMilli()
				if chosen.IsMultiple != (variant != "root") {
					return errors.New("chooser multiple mismatch")
				}
				selected := files
				if variant == "root" {
					selected = files[:1]
				}
				if sequence == 2 {
					selected = []string{}
				}
				if _, err := owner.Client.SetFileChooserFiles(chosen.FileChooserID, selected); err != nil {
					return err
				}
				deadline := time.Now().Add(5 * time.Second)
				for {
					text, err := receiptNode.TextContent()
					if err != nil {
						return err
					}
					var receipt map[string]any
					if text != nil && *text != "" {
						if err := json.Unmarshal([]byte(*text), &receipt); err != nil {
							return err
						}
					}
					if receipt != nil && receipt["sequence"] == float64(sequence) {
						receipts = append(receipts, receipt)
						break
					}
					if time.Now().After(deadline) {
						return errors.New("chooser server receipt did not render")
					}
					time.Sleep(25 * time.Millisecond)
				}
				return nil
			}()
			if failure != nil {
				return nil, failure
			}
			waits = append(waits, event)
		}
		first, err := owner.Client.Request("getControlState", nil)
		if err != nil {
			return nil, err
		}
		second, err := trigger.Client.Request("getControlState", nil)
		if err != nil {
			return nil, err
		}
		epoch := first.(map[string]any)["controlEpoch"]
		if epoch != second.(map[string]any)["controlEpoch"] {
			return nil, errors.New("connections have different epochs")
		}
		item := map[string]any{"key": key, "variant": variant, "tabId": tab.ID, "waits": waits, "receipts": receipts, "scope": map[string]any{"session_id": prefix, "turn_id": "chooser-ready", "control_epoch": epoch}}
		if variant == "dynamic-oopif" {
			adds, err := tab.Evaluate("chooserEvidence.frameAdds")
			if err != nil {
				return nil, err
			}
			item["frameAdds"] = adds
		}
		variants = append(variants, item)
	}
	return map[string]any{"caller": "go", "independentConnections": true, "variants": variants}, nil
}

func main() {
	if len(os.Args) < 7 {
		panic("usage: chooser-checks endpoint baseURL prefix outputPath files...")
	}
	result, err := run(os.Args[1], os.Args[2], os.Args[3], os.Args[5:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		panic(err)
	}
	file, err := os.OpenFile(os.Args[4], os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		panic(err)
	}
	if _, err = file.Write(append(encoded, '\n')); err != nil {
		panic(err)
	}
	if err = file.Close(); err != nil {
		panic(err)
	}
	fmt.Println(string(encoded))
}
