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
	return runWithHooks(endpoint, base, prefix, files, nil)
}

func runWithHooks(endpoint, base, prefix string, files []string, hook func(string, map[string]any) error) (result map[string]any, err error) {
	result = map[string]any{"caller": "go", "independentConnections": true, "variants": []map[string]any{}}
	defer func() {
		if err != nil {
			result["error"] = err.Error()
		}
	}()
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme != "http" || (parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost") {
		return result, errors.New("loopback fixture required")
	}
	if len(files) == 0 {
		return result, errors.New("at least one chooser fixture file required")
	}
	options := obu.Options{SocketPath: endpoint, SessionID: prefix, TurnID: "chooser-ready", Timeout: 15 * time.Second}
	owner, err := obu.ConnectOpenBrowserUse(options)
	if err != nil {
		return result, err
	}
	defer func() {
		if closeErr := owner.Close(); closeErr != nil {
			result["ownerCloseError"] = closeErr.Error()
			if err == nil {
				err = closeErr
			}
		}
	}()
	trigger, err := obu.ConnectOpenBrowserUse(options)
	if err != nil {
		return result, err
	}
	defer func() {
		if closeErr := trigger.Close(); closeErr != nil {
			result["triggerCloseError"] = closeErr.Error()
			if err == nil {
				err = closeErr
			}
		}
	}()
	// Node retains this exact session for live OOPIF/HTTP evidence, then finalizes.
	info, err := owner.Client.GetInfo()
	if err != nil {
		return result, err
	}
	object, _ := info.(map[string]any)
	metadata, _ := object["metadata"].(map[string]any)
	if metadata["fileChooserWaitVersion"] != float64(1) {
		return result, errors.New("file chooser waits unsupported")
	}
	variants := []map[string]any{}
	for _, variant := range []string{"root", "oopif", "dynamic-oopif"} {
		key := prefix + "-" + variant
		item := map[string]any{"key": key, "variant": variant, "startedAt": time.Now().UnixMilli(), "waits": []map[string]any{}, "receipts": []any{}}
		variants = append(variants, item)
		result["variants"] = variants
		err = withVariant(item, hook, func(progress *variantProgress) error {
			var tab *obu.Tab
			if err := progress.step(item, "newTab", func() error {
				var e error
				tab, e = owner.NewTab()
				if e == nil {
					item["tabId"] = tab.ID
				}
				return e
			}); err != nil {
				return err
			}
			if err := progress.step(item, "navigate", func() error {
				_, e := owner.CDP.Navigate(tab.ID, base+"chooser-waits/page?"+url.Values{"key": {key}, "variant": {variant}}.Encode(), obu.GotoOptions{})
				return e
			}); err != nil {
				return err
			}
			if err := progress.notify("start"); err != nil {
				return err
			}
			sender := trigger.Tab(tab.ID)
			waits, receipts := []map[string]any{}, []any{}
			for sequence := 1; sequence <= 2; sequence++ {
				event := map[string]any{"sequence": sequence}
				waits = append(waits, event)
				item["waits"] = waits
				var wait *obu.FileChooserWait
				if err := progress.step(event, "arm", func() error {
					var e error
					wait, e = tab.ExpectFileChooser(obu.FileChooserWaitOptions{Timeout: 10 * time.Second})
					if e == nil {
						event["waiterId"], event["remainingMs"], event["readyAt"] = wait.WaiterID, wait.RemainingMS, time.Now().UnixMilli()
					}
					return e
				}); err != nil {
					return err
				}
				failure := withChooserCancellation(progress, event, wait.Cancel, func() error {
					if variant == "dynamic-oopif" && sequence == 1 {
						if err := progress.step(event, "addFrame", func() error {
							return sender.GetByRole("button", obu.RoleOptions{Name: "Add upload frame", Exact: true}).Click()
						}); err != nil {
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
					if err := progress.step(event, "click", func() error {
						event["triggerSubmittedAt"] = time.Now().UnixMilli()
						if e := input.Click(); e != nil {
							return e
						}
						event["triggerCompletedAt"] = time.Now().UnixMilli()
						return nil
					}); err != nil {
						return err
					}
					var chosen obu.FileChooserResult
					if err := progress.step(event, "collect", func() error {
						var e error
						chosen, e = wait.Result()
						if e != nil {
							return e
						}
						event["result"], event["collectedAt"] = chosen, time.Now().UnixMilli()
						if chosen.IsMultiple != (variant != "root") {
							return errors.New("chooser multiple mismatch")
						}
						return nil
					}); err != nil {
						return err
					}
					selected := files
					if variant == "root" {
						selected = files[:1]
					}
					if sequence == 2 {
						selected = []string{}
					}
					if err := progress.step(event, "setFiles", func() error { _, e := owner.Client.SetFileChooserFiles(chosen.FileChooserID, selected); return e }); err != nil {
						return err
					}
					return progress.step(event, "receipt", func() error {
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
								item["receipts"], event["receipt"] = receipts, receipt
								break
							}
							if time.Now().After(deadline) {
								return errors.New("chooser server receipt did not render")
							}
							time.Sleep(25 * time.Millisecond)
						}
						return nil
					})
				})
				if failure != nil {
					return failure
				}
			}
			if err := progress.step(item, "scope", func() error {
				first, err := owner.Client.Request("getControlState", nil)
				if err != nil {
					return err
				}
				second, err := trigger.Client.Request("getControlState", nil)
				if err != nil {
					return err
				}
				epoch := first.(map[string]any)["controlEpoch"]
				if epoch != second.(map[string]any)["controlEpoch"] {
					return errors.New("connections have different epochs")
				}
				item["scope"] = map[string]any{"session_id": prefix, "turn_id": "chooser-ready", "control_epoch": epoch}
				return nil
			}); err != nil {
				return err
			}
			if variant == "dynamic-oopif" {
				if err := progress.step(item, "frameAdds", func() error {
					adds, err := tab.Evaluate("chooserEvidence.frameAdds")
					if err != nil {
						return err
					}
					item["frameAdds"] = adds
					return nil
				}); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return result, err
		}
	}
	return result, nil
}

func writeResult(filename string, result map[string]any) ([]byte, error) {
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filename, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, err
	}
	_, writeErr := file.Write(append(encoded, '\n'))
	return encoded, errors.Join(writeErr, file.Close())
}

func main() {
	if len(os.Args) < 7 {
		fmt.Fprintln(os.Stderr, "usage: chooser-checks endpoint baseURL prefix outputPath files...")
		os.Exit(1)
	}
	diagnostic := os.Getenv("OBU_GO_CHOOSER_DIAGNOSTIC") == "1"
	var hook func(string, map[string]any) error
	if diagnostic {
		protocol := newDiagnosticProtocol(os.Stdin, os.Stdout)
		defer protocol.close()
		hook = protocol.hook
	}
	result, runErr := runWithHooks(os.Args[1], os.Args[2], os.Args[3], os.Args[5:], hook)
	encoded, writeErr := writeResult(os.Args[4], result)
	if writeErr != nil {
		fmt.Fprintln(os.Stderr, errors.Join(runErr, writeErr))
		os.Exit(1)
	}
	if diagnostic {
		message, err := json.Marshal(map[string]any{"type": "result", "version": 1, "result": result})
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println(string(message))
	} else {
		fmt.Println(string(encoded))
	}
	if runErr != nil {
		fmt.Fprintln(os.Stderr, runErr)
		os.Exit(1)
	}
}
