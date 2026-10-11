package main

import (
	"fmt"
	"reflect"
	"testing"

	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
)

type testAPI struct {
	next, finalized, closed int
	writes                  [][]string
	states                  map[int]string
	failWrite, failFinalize bool
}

func (api *testAPI) Create() (int, error) { api.next++; return api.next, nil }
func (api *testAPI) Finalize() (any, error) {
	api.finalized++
	if api.failFinalize {
		return nil, fmt.Errorf("cleanup failed")
	}
	return map[string]any{"done": true}, nil
}
func (api *testAPI) Close() { api.closed++ }
func (api *testAPI) Action(id int, variant, method, selector string, arg any) (any, error) {
	switch method {
	case "engineInfo":
		return obu.BrowserActionResult{Engine: map[string]any{"capabilities": map[string]any{"locatorFileUpload": 1}}}, nil
	case "innerText":
		state := api.states[id]
		if state == "" {
			state = "empty"
		}
		return fmt.Sprintf(`{"state":%q}`, state), nil
	case "invalidFiles":
		return nil, fmt.Errorf("Invalid files")
	case "setInputFiles":
		if selector != "#upload" {
			return nil, fmt.Errorf("Invalid input")
		}
		files := arg.([]string)
		copy := append([]string{}, files...)
		api.writes = append(api.writes, copy)
		if api.failWrite {
			return nil, fmt.Errorf("original write failed")
		}
		api.states[id] = "uploaded"
		if len(files) == 0 {
			api.states[id] = "cleared"
		}
	}
	return nil, nil
}
func result() map[string]any {
	return map[string]any{"trace": []any{}, "variants": []any{}, "createdTabIds": []int{}, "passed": false}
}
func TestDirectUploadPublicWorkflowSingleWriteClearEachVariant(t *testing.T) {
	api := &testAPI{states: map[int]string{}}
	detail := result()
	var hooks []string
	run(api, "http://127.0.0.1:1234", "direct-go-unit", []string{"/中文.bin"}, detail, func(kind string, item map[string]any) error {
		hooks = append(hooks, kind+":"+item["variant"].(string))
		return nil
	})
	if detail["passed"] != true {
		t.Fatalf("workflow: %#v", detail)
	}
	if !reflect.DeepEqual(api.writes, [][]string{{"/中文.bin"}, {}, {"/中文.bin"}, {}, {"/中文.bin"}, {}}) {
		t.Fatalf("writes %#v", api.writes)
	}
	if !reflect.DeepEqual(hooks, []string{"start:root", "finish:root", "start:same", "finish:same", "start:dynamic-oopif", "finish:dynamic-oopif"}) {
		t.Fatalf("hooks %#v", hooks)
	}
	if api.finalized != 1 || api.closed != 1 {
		t.Fatalf("cleanup %d/%d", api.finalized, api.closed)
	}
}
func TestDirectUploadOriginalErrorSurvivesObserverAndFinalize(t *testing.T) {
	api := &testAPI{states: map[int]string{}, failWrite: true, failFinalize: true}
	detail := result()
	run(api, "http://127.0.0.1:1234", "direct-go-unit", []string{"/file"}, detail, func(kind string, item map[string]any) error {
		if kind == "finish" {
			return fmt.Errorf("observer failed")
		}
		return nil
	})
	if detail["error"] != "original write failed" || detail["cleanupError"] != "cleanup failed" {
		t.Fatalf("errors %#v", detail)
	}
	if len(api.writes) != 1 || api.finalized != 1 || api.closed != 1 {
		t.Fatal("write replayed or cleanup missing")
	}
	item := detail["variants"].([]any)[0].(map[string]any)
	if item["observerError"] != "observer failed" {
		t.Fatal("observer error lost")
	}
}
