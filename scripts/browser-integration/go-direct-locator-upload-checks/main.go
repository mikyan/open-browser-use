// Public typed Go locator upload; parent hooks only observe exact native tabs.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
	"os"
	"reflect"
	"strings"
	"time"
)

type uploadAPI interface {
	Create() (int, error)
	Action(int, string, string, string, any) (any, error)
	Finalize() (any, error)
	Close()
}

type sdkAPI struct{ browser *obu.Browser }

func (api sdkAPI) Create() (int, error) {
	tab, err := api.browser.NewTab()
	if err != nil {
		return 0, err
	}
	return tab.ID, nil
}
func (api sdkAPI) Finalize() (any, error) { return api.browser.Client.FinalizeTabs([]obu.Params{}) }
func (api sdkAPI) Close()                 { api.browser.Close() }
func (api sdkAPI) Action(id int, variant, method, selector string, argument any) (any, error) {
	tab := api.browser.Tab(id)
	locator := tab.Locator(selector)
	if variant != "root" {
		locator = tab.FrameLocator("#upload-frame").Locator(selector)
	}
	options := obu.BrowserActionOptions{Timeout: 10 * time.Second}
	switch method {
	case "goto":
		return tab.Goto(argument.(string))
	case "engineInfo":
		return api.browser.Client.BrowserAction(id, "engineInfo", options)
	case "innerText":
		return locator.InnerText(10 * time.Second)
	case "waitFor":
		return nil, locator.WaitFor("visible", options)
	case "setInputFiles":
		return nil, locator.SetInputFiles(argument.([]string), options)
	case "invalidFiles":
		options.Locator = []obu.Params{{"kind": "css", "selector": "#upload"}}
		options.Args = obu.Params{"files": argument}
		return api.browser.Client.BrowserAction(id, "setInputFiles", options)
	}
	return nil, fmt.Errorf("unknown direct upload action %s", method)
}

func run(api uploadAPI, baseURL, key string, paths []string, detail map[string]any, hook func(string, map[string]any) error) {
	finalizing := false
	defer api.Close()
	defer func() {
		if err := recover(); err != nil {
			detail["error"] = fmt.Sprint(err)
			detail["passed"] = false
		}
		if !finalizing {
			value, err := api.Finalize()
			if err != nil {
				detail["cleanupError"] = err.Error()
			} else {
				detail["cleanupResult"] = value
			}
		}
	}()
	trace := func(method string, args any, work func() (any, error)) any {
		record := map[string]any{"method": method, "args": args, "requestedAt": time.Now().UnixMilli()}
		detail["trace"] = append(detail["trace"].([]any), record)
		value, err := work()
		if err != nil {
			record["error"] = err.Error()
			panic(err)
		}
		record["completedAt"] = time.Now().UnixMilli()
		return value
	}
	for _, variant := range []string{"root", "same", "dynamic-oopif"} {
		item := map[string]any{"key": key + "-" + variant, "variant": variant, "passed": false}
		detail["variants"] = append(detail["variants"].([]any), item)
		func() {
			started := false
			defer func() {
				failure := recover()
				if failure != nil {
					item["error"] = fmt.Sprint(failure)
				}
				if started {
					if err := hook("finish", item); err != nil {
						item["observerError"] = err.Error()
						if failure == nil {
							failure = err
						}
					}
				}
				if failure != nil {
					panic(failure)
				}
			}()
			id := trace("newTab", nil, func() (any, error) { return api.Create() }).(int)
			item["tabId"] = id
			detail["createdTabIds"] = append(detail["createdTabIds"].([]int), id)
			started = true
			if err := hook("start", item); err != nil {
				panic(err)
			}
			url := strings.TrimRight(baseURL, "/") + "/direct-locator-upload/page?key=" + item["key"].(string) + "&variant=" + variant
			item["url"] = url
			action := func(method, selector string, argument any) any {
				return trace(method, map[string]any{"tabId": id, "selector": selector, "argument": argument, "timeoutMs": 10000}, func() (any, error) { return api.Action(id, variant, method, selector, argument) })
			}
			action("goto", "", url)
			engine := action("engineInfo", "", nil)
			item["engine"] = engine
			encoded, _ := json.Marshal(engine)
			var result struct {
				Engine struct{ Capabilities map[string]any }
			}
			if err := json.Unmarshal(encoded, &result); err != nil {
				panic(err)
			}
			if result.Engine.Capabilities["locatorFileUpload"] != float64(1) {
				panic("Missing locatorFileUpload capability")
			}
			read := func(selector string) any {
				var value any
				if err := json.Unmarshal([]byte(action("innerText", selector, nil).(string)), &value); err != nil {
					panic(err)
				}
				return value
			}
			item["before"] = read("#state")
			if variant == "root" {
				item["negatives"] = []any{}
				for _, spec := range []struct {
					name, selector string
					arg            any
				}{{"strict", ".ambiguous", paths}, {"non-file", "#non-file", paths}, {"null", "", nil}, {"relative", "", []string{"relative.txt"}}} {
					record := map[string]any{"name": spec.name}
					item["negatives"] = append(item["negatives"].([]any), record)
					func() {
						defer func() {
							if err := recover(); err != nil {
								record["error"] = fmt.Sprint(err)
							}
						}()
						method := "setInputFiles"
						if spec.selector == "" {
							method = "invalidFiles"
						}
						action(method, spec.selector, spec.arg)
					}()
					message, ok := record["error"].(string)
					if !ok {
						panic("Invalid direct upload unexpectedly succeeded")
					}
					for _, word := range []string{"timed out", "timeout", "deadline", "disconnect"} {
						if strings.Contains(strings.ToLower(message), word) {
							panic("Validation was not a definite rejection: " + message)
						}
					}
				}
				item["afterNegatives"] = read("#state")
				if !reflect.DeepEqual(item["before"], item["afterNegatives"]) {
					panic("Negative request mutated FileList")
				}
			}
			item["uploadStartedAt"] = time.Now().UnixMilli()
			action("setInputFiles", "#upload", paths)
			item["uploadCompletedAt"] = time.Now().UnixMilli()
			action("waitFor", "#receipt", nil)
			item["receipt"] = read("#receipt")
			item["uploaded"] = read("#state")
			item["clearStartedAt"] = time.Now().UnixMilli()
			action("setInputFiles", "#upload", []string{})
			item["clearCompletedAt"] = time.Now().UnixMilli()
			item["cleared"] = read("#state")
			item["passed"] = true
		}()
	}
	finalizing = true
	detail["finalizeResult"] = trace("finalizeTabs", []any{}, api.Finalize)
	detail["passed"] = true
}

func main() {
	if len(os.Args) != 5 {
		panic("usage: endpoint fixtureURL filesJSON outputJSON")
	}
	bytes, err := os.ReadFile(os.Args[3])
	if err != nil {
		panic(err)
	}
	var files []struct{ Path string }
	if err = json.Unmarshal(bytes, &files); err != nil {
		panic(err)
	}
	paths := make([]string, len(files))
	for i, file := range files {
		paths[i] = file.Path
	}
	key := fmt.Sprintf("direct-go-%d", time.Now().UnixNano())
	detail := map[string]any{"caller": "go", "key": key, "trace": []any{}, "variants": []any{}, "createdTabIds": []int{}, "passed": false}
	browser, err := obu.ConnectOpenBrowserUse(obu.Options{SocketPath: os.Args[1], SessionID: key, Timeout: 15 * time.Second})
	if err != nil {
		detail["error"] = err.Error()
	} else {
		control, beginError := browser.Client.BeginTurn()
		if beginError != nil {
			detail["error"] = beginError.Error()
			browser.Close()
		} else {
			encoded, _ := json.Marshal(control)
			var state map[string]any
			_ = json.Unmarshal(encoded, &state)
			detail["scope"] = map[string]any{"session_id": key, "turn_id": state["nextTurnId"], "control_epoch": state["controlEpoch"]}
			reader := bufio.NewReaderSize(os.Stdin, 65538)
			sequence := 0
			hook := func(kind string, item map[string]any) error {
				sequence++
				identity := map[string]any{"key": item["key"], "variant": item["variant"], "tabId": item["tabId"]}
				if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "hook", "version": 1, "id": sequence, "kind": kind, "item": identity}); err != nil {
					return err
				}
				line, err := reader.ReadSlice('\n')
				if err != nil {
					return err
				}
				if len(line) > 65537 {
					return fmt.Errorf("Parent ACK too large")
				}
				var ack struct {
					Type        string
					Version, ID int
					OK          bool
					Error       string
				}
				if err = json.Unmarshal(line, &ack); err != nil {
					return err
				}
				if ack.Type != "ack" || ack.Version != 1 || ack.ID != sequence || !ack.OK {
					return fmt.Errorf("Parent hook rejected: %s", ack.Error)
				}
				return nil
			}
			run(sdkAPI{browser}, os.Args[2], key, paths, detail, hook)
		}
	}
	bytes, err = json.MarshalIndent(detail, "", "  ")
	if err != nil {
		panic(err)
	}
	file, err := os.OpenFile(os.Args[4], os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		panic(err)
	}
	if _, err = file.Write(bytes); err != nil {
		panic(err)
	}
	if err = file.Close(); err != nil {
		panic(err)
	}
	if err = json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "result", "version": 1, "result": detail}); err != nil {
		panic(err)
	}
	if detail["passed"] != true {
		os.Exit(1)
	}
}
