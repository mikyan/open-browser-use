// Exercise typed dialog decisions; the parent verifies original native/HTTP evidence.
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

type dialogCase struct {
	Button   string             `json:"button"`
	Decision obu.DialogDecision `json:"decision"`
}

func run(endpoint, base, prefix string, cases []dialogCase, keyPrefix string) (result map[string]any, err error) {
	result = map[string]any{"caller": "go", "variants": []map[string]any{}, "passed": false}
	if keyPrefix != "go" {
		result["keyPrefix"] = keyPrefix
	}
	defer func() {
		if err != nil {
			result["error"] = err.Error()
		}
	}()
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme != "http" || (parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost") {
		return result, errors.New("loopback fixture required")
	}
	browser, err := obu.ConnectOpenBrowserUse(obu.Options{SocketPath: endpoint, SessionID: prefix, TurnID: "dialog-decisions", Timeout: 15 * time.Second})
	if err != nil {
		return result, err
	}
	defer func() { err = errors.Join(err, browser.Close()) }()
	variants := []map[string]any{}
	for _, layout := range []string{"root", "oopif", "dynamic-oopif"} {
		key := keyPrefix + "-dialogs-" + layout
		tab, createErr := browser.NewTab()
		if createErr != nil {
			return result, createErr
		}
		item := map[string]any{"key": key, "layout": layout, "tabId": tab.ID, "decisions": []map[string]any{}}
		variants = append(variants, item)
		result["variants"] = variants
		if _, err = tab.Goto(base + "native-dialogs?" + url.Values{"key": {key}, "layout": {layout}}.Encode()); err != nil {
			return result, err
		}
		button := func(name string) *obu.Locator {
			if layout == "root" {
				return tab.GetByRole("button", obu.RoleOptions{Name: name, Exact: true})
			}
			return tab.FrameLocator("#dialog-frame").GetByRole("button", obu.RoleOptions{Name: name, Exact: true})
		}
		decisions := []map[string]any{}
		for index, selected := range cases {
			decision := selected.Decision
			message := decision.Type + ": " + key
			decision.Message = &message
			wait, armErr := tab.ExpectDialog(decision, obu.DialogWaitOptions{Timeout: 10 * time.Second})
			if armErr != nil {
				return result, armErr
			}
			record := map[string]any{"decision": decision, "dialogId": wait.DialogID, "remainingMs": wait.RemainingMS}
			decisions = append(decisions, record)
			item["decisions"] = decisions
			err = func() (stepErr error) {
				defer func() { stepErr = errors.Join(stepErr, wait.Cancel()) }()
				if layout == "dynamic-oopif" && index == 0 {
					if e := tab.GetByRole("button", obu.RoleOptions{Name: "Add dialog frame", Exact: true}).Click(); e != nil {
						return e
					}
				}
				if e := button(selected.Button).Click(); e != nil {
					return e
				}
				value, e := wait.Result()
				if e != nil {
					return e
				}
				record["result"] = value
				return nil
			}()
			if err != nil {
				return result, err
			}
		}
		if err = button("Confirm transfer").Click(); err != nil {
			return result, err
		}
	}
	result["passed"] = true
	return result, nil
}

func main() {
	if len(os.Args) != 6 && len(os.Args) != 7 {
		panic("usage: dialog-checks endpoint baseURL prefix config output [keyPrefix]")
	}
	data, err := os.ReadFile(os.Args[4])
	if err != nil {
		panic(err)
	}
	var cases []dialogCase
	if err = json.Unmarshal(data, &cases); err != nil {
		panic(err)
	}
	keyPrefix := "go"
	if len(os.Args) == 7 {
		keyPrefix = os.Args[6]
	}
	result, runErr := run(os.Args[1], os.Args[2], os.Args[3], cases, keyPrefix)
	encoded, err := json.Marshal(result)
	if err != nil {
		panic(err)
	}
	file, err := os.OpenFile(os.Args[5], os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
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
