// Independent synchronous SDK connections; ready ACK precedes page click.
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

func run(endpoint, base, prefix string) (result map[string]any, err error) {
	progress := map[string]any{"caller": "go", "independentConnections": true, "variants": []map[string]any{}}
	defer func() {
		if err != nil {
			progress["error"] = err.Error()
			result = progress
		}
	}()
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme != "http" || (parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost") {
		return nil, errors.New("loopback fixture required")
	}
	options := obu.Options{SocketPath: endpoint, SessionID: prefix, TurnID: "download-ready", Timeout: 15 * time.Second}
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
	info, err := owner.Client.GetInfo()
	if err != nil {
		return nil, err
	}
	if info.(map[string]any)["metadata"].(map[string]any)["downloadWaitVersion"] != float64(1) {
		return nil, errors.New("download waits unsupported")
	}
	variants := []map[string]any{}
	for _, variant := range []string{"root", "oopif", "dynamic-oopif"} {
		key := prefix + "-" + variant
		tab, err := owner.NewTab()
		if err != nil {
			return nil, err
		}
		if _, err = owner.CDP.Navigate(tab.ID, base+"download-waits/page?"+url.Values{"key": {key}, "variant": {variant}}.Encode(), obu.GotoOptions{}); err != nil {
			return nil, err
		}
		sender := trigger.Tab(tab.ID)
		wait, err := tab.ExpectDownload(obu.DownloadWaitOptions{Timeout: 10 * time.Second})
		if err != nil {
			return nil, err
		}
		item := map[string]any{"key": key, "variant": variant, "tabId": tab.ID, "waiterId": wait.WaiterID, "remainingMs": wait.RemainingMS, "readyAt": time.Now().UnixMilli()}
		variants = append(variants, item)
		progress["variants"] = variants
		failure := func() (stepErr error) {
			defer func() { stepErr = errors.Join(stepErr, wait.Cancel()) }()
			if variant == "dynamic-oopif" {
				if err := sender.GetByRole("button", obu.RoleOptions{Name: "Add download frame", Exact: true}).Click(); err != nil {
					return err
				}
			}
			link := sender.GetByRole("link", obu.RoleOptions{Name: "Download fixture", Exact: true})
			evidence := sender.Locator("#evidence")
			if variant != "root" {
				frame := sender.FrameLocator("#download-frame")
				link = frame.GetByRole("link", obu.RoleOptions{Name: "Download fixture", Exact: true})
				evidence = frame.Locator("#evidence")
			}
			item["triggerSubmittedAt"] = time.Now().UnixMilli()
			if err := link.Click(); err != nil {
				return err
			}
			download, err := wait.Result()
			if err != nil {
				return err
			}
			item["result"] = map[string]any{"downloadId": download.DownloadID}
			item["collectedAt"] = time.Now().UnixMilli()
			value, err := evidence.TextContent()
			if err != nil {
				return err
			}
			if value == nil {
				return errors.New("missing trusted download witness")
			}
			var page map[string]any
			if err := json.Unmarshal([]byte(*value), &page); err != nil {
				return err
			}
			item["page"] = page
			if variant == "dynamic-oopif" {
				adds, err := tab.Evaluate("downloadEvidence.frameAdds")
				if err != nil {
					return err
				}
				item["frameAdds"] = adds
			}
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
				return errors.New("different connection scope")
			}
			item["scope"] = map[string]any{"session_id": prefix, "turn_id": "download-ready", "control_epoch": epoch}
			return nil
		}()
		if failure != nil {
			return nil, failure
		}
	}
	return map[string]any{"caller": "go", "independentConnections": true, "variants": variants}, nil
}

func main() {
	if len(os.Args) != 5 {
		panic("usage: download-waits-checks endpoint baseURL prefix outputPath")
	}
	result, runErr := run(os.Args[1], os.Args[2], os.Args[3])
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
	if runErr != nil {
		fmt.Fprintln(os.Stderr, runErr)
		os.Exit(1)
	}
}
