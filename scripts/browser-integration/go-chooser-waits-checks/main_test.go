package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestPartialStagesKeepOriginalBeforeCancelAndFinish(t *testing.T) {
	for _, failing := range []string{"arm", "addFrame", "click", "collect", "setFiles", "receipt", "cancel"} {
		t.Run(failing, func(t *testing.T) {
			original, cancelErr, diagnosticErr := errors.New("original "+failing), errors.New("cleanup failed"), errors.New("diagnostic failed")
			event := map[string]any{"sequence": 1}
			item := map[string]any{"key": "test", "variant": "dynamic-oopif", "tabId": 42, "waits": []map[string]any{event}}
			var order []string
			hook := func(kind string, received map[string]any) error {
				order = append(order, kind)
				if received["key"] != item["key"] {
					t.Fatal("wrong item")
				}
				if kind == "failure" {
					if event["originalError"] != original.Error() || event["failedStage"] != failing {
						t.Fatalf("failure hook lacked original stage: %#v", event)
					}
					return diagnosticErr
				}
				if kind == "finish" {
					return diagnosticErr
				}
				return nil
			}
			err := withVariant(item, hook, func(progress *variantProgress) error {
				if err := progress.notify("start"); err != nil {
					return err
				}
				if err := progress.step(event, "arm", func() error {
					order = append(order, "arm")
					if failing == "arm" {
						return original
					}
					event["waiterId"] = "original-wait"
					return nil
				}); err != nil {
					return err
				}
				return withChooserCancellation(progress, event, func() error {
					order = append(order, "cancel")
					if failing == "cancel" {
						return original
					}
					return cancelErr
				}, func() error {
					for _, name := range []string{"addFrame", "click", "collect", "setFiles", "receipt"} {
						if err := progress.step(event, name, func() error {
							order = append(order, name)
							if name == failing {
								return original
							}
							return nil
						}); err != nil {
							return err
						}
					}
					return nil
				})
			})
			if err != original {
				t.Fatalf("original error replaced: %v", err)
			}
			if item["passed"] != false || item["originalError"] != original.Error() || event["originalError"] != original.Error() {
				t.Fatalf("partial result lost: %#v %#v", item, event)
			}
			if item["diagnosticFailureError"] != diagnosticErr.Error() || item["diagnosticFinishError"] != diagnosticErr.Error() {
				t.Fatal("diagnostic errors lost")
			}
			if failing != "arm" && event["cancelError"] == nil {
				t.Fatal("cancel error lost")
			}
			if event[failing+"StartedAt"] == nil || event[failing+"FailedAt"] == nil || event[failing+"CompletedAt"] != nil {
				t.Fatalf("invalid failed timing: %#v", event)
			}
			failureIndex, cancelIndex := -1, -1
			for index, name := range order {
				if name == "failure" {
					if failureIndex != -1 {
						t.Fatal("failure hook repeated")
					}
					failureIndex = index
				}
				if name == "cancel" {
					cancelIndex = index
				}
			}
			if order[len(order)-1] != "finish" || failing != "arm" && failing != "cancel" && failureIndex >= cancelIndex {
				t.Fatalf("wrong lifecycle order: %v", order)
			}
			if failing == "arm" && cancelIndex != -1 {
				t.Fatal("cancelled a waiter that was never acquired")
			}
			if _, err := json.Marshal(item); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestStartFailureStopsBusinessButStillFinishesAndEarlyFailureSendsNoHooks(t *testing.T) {
	for _, early := range []bool{false, true} {
		item := map[string]any{"waits": []map[string]any{}}
		original := errors.New("setup failed")
		var calls []string
		err := withVariant(item, func(kind string, _ map[string]any) error {
			calls = append(calls, kind)
			if kind == "start" {
				return original
			}
			return nil
		}, func(progress *variantProgress) error {
			if early {
				return progress.step(item, "navigate", func() error { return original })
			}
			if err := progress.notify("start"); err != nil {
				return err
			}
			t.Fatal("arm must not follow a rejected start")
			return nil
		})
		if err != original {
			t.Fatal("setup failure lost")
		}
		if early {
			if len(calls) != 0 || item["diagnosticNotStarted"] != true {
				t.Fatalf("early hooks: %v %#v", calls, item)
			}
		} else if !reflect.DeepEqual(calls, []string{"start", "finish"}) {
			t.Fatalf("wrong hooks: %v", calls)
		}
	}
}

func TestSuccessfulStagesAndNilHookPreserveOperationOrder(t *testing.T) {
	item, event := map[string]any{}, map[string]any{}
	var calls []string
	err := withVariant(item, nil, func(progress *variantProgress) error {
		if err := progress.notify("start"); err != nil {
			return err
		}
		return withChooserCancellation(progress, event, func() error { calls = append(calls, "cancel"); return nil }, func() error {
			for _, name := range []string{"arm", "addFrame", "click", "collect", "setFiles", "receipt"} {
				if err := progress.step(event, name, func() error { calls = append(calls, name); return nil }); err != nil {
					return err
				}
			}
			return nil
		})
	})
	if err != nil || item["passed"] != true {
		t.Fatalf("success lost: %v %#v", err, item)
	}
	if !reflect.DeepEqual(calls, []string{"arm", "addFrame", "click", "collect", "setFiles", "receipt", "cancel"}) {
		t.Fatal(calls)
	}
	for _, name := range calls {
		if event[name+"StartedAt"] == nil || event[name+"CompletedAt"] == nil || event[name+"FailedAt"] != nil {
			t.Fatal(event)
		}
	}
	for key := range item {
		if strings.HasPrefix(key, "diagnostic") {
			t.Fatalf("nil hook introduced diagnostic field %s", key)
		}
	}
}

func TestDefaultModePreservesBusinessErrorAcrossCancellation(t *testing.T) {
	original, cleanup := errors.New("original collect timeout"), errors.New("cancel failed")
	item, event := map[string]any{}, map[string]any{}
	err := withVariant(item, nil, func(progress *variantProgress) error {
		return withChooserCancellation(progress, event, func() error { return cleanup }, func() error {
			return progress.step(event, "collect", func() error { return original })
		})
	})
	if err != original || item["stage"] != "collect" || event["stage"] != "collect" || event["cancelError"] != cleanup.Error() || event["originalError"] != original.Error() {
		t.Fatalf("default failure lost: %v %#v %#v", err, item, event)
	}
	for key := range item {
		if strings.HasPrefix(key, "diagnostic") {
			t.Fatalf("default emitted diagnostic field %s", key)
		}
	}
}

func TestPartialRunWritesExclusiveOutputBeforeFailureExit(t *testing.T) {
	if os.Getenv("OBU_CHOOSER_TEST_PROCESS") == "1" {
		os.Args = []string{"chooser-checks", "unused", "https://not-loopback.invalid/", "test", os.Getenv("OBU_CHOOSER_TEST_OUTPUT"), "file-one", "file-two"}
		main()
		return
	}
	for _, diagnostic := range []bool{false, true} {
		filename := filepath.Join(t.TempDir(), "partial.json")
		command := exec.Command(os.Args[0], "-test.run=^TestPartialRunWritesExclusiveOutputBeforeFailureExit$")
		command.Env = append(os.Environ(), "OBU_CHOOSER_TEST_PROCESS=1", "OBU_CHOOSER_TEST_OUTPUT="+filename, "OBU_GO_CHOOSER_DIAGNOSTIC=")
		if diagnostic {
			command.Env = append(command.Env, "OBU_GO_CHOOSER_DIAGNOSTIC=1")
		}
		output, err := command.Output()
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 1 {
			t.Fatalf("want actual exit 1: %v %s", err, output)
		}
		body, err := os.ReadFile(filename)
		if err != nil {
			t.Fatal(err)
		}
		var saved, message map[string]any
		if json.Unmarshal(body, &saved) != nil || json.Unmarshal(output, &message) != nil {
			t.Fatalf("invalid retained JSON: %s %s", body, output)
		}
		if saved["error"] != "loopback fixture required" || len(saved["variants"].([]any)) != 0 {
			t.Fatal(saved)
		}
		if diagnostic {
			if message["type"] != "result" || message["version"] != float64(1) || !reflect.DeepEqual(message["result"], saved) {
				t.Fatal(message)
			}
		} else if !reflect.DeepEqual(message, saved) {
			t.Fatal("default stdout shape changed")
		}
		if _, err := writeResult(filename, map[string]any{"replacement": true}); err == nil {
			t.Fatal("overwrote existing evidence")
		}
		after, _ := os.ReadFile(filename)
		if string(after) != string(body) {
			t.Fatal("failed overwrite altered evidence")
		}
	}
}
