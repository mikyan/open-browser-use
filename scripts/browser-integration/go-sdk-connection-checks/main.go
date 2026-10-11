package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"

	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) != 5 || (os.Args[4] != "close" && os.Args[4] != "eof") {
		return errors.New("usage: go-sdk-connection-checks endpoint session tabId close|eof")
	}
	tabID, err := strconv.Atoi(os.Args[3])
	if err != nil || tabID < 1 {
		return errors.New("tabId must be a positive integer")
	}
	mode := os.Args[4]
	options := obu.Options{SocketPath: os.Args[1], SessionID: os.Args[2], Timeout: 5 * time.Second}
	client := obu.NewClient(options)
	defer client.Close()
	state, err := client.BeginTurn()
	if err != nil {
		return fmt.Errorf("initial BeginTurn: %w", err)
	}
	stateObject, ok := state.(map[string]any)
	if !ok {
		return errors.New("initial control state is not an object")
	}
	tab := obu.NewBrowser(client).Tab(tabID)
	oldLocator := tab.Locator("#stale-action")
	ready, err := tab.Locator("#connection-ready").TextContent(obu.BrowserActionOptions{Timeout: time.Second})
	if err != nil {
		return fmt.Errorf("fixture readiness: %w", err)
	}
	if ready == nil || *ready != "SDK_CONNECTION_READY" {
		return fmt.Errorf("fixture readiness text did not match: %v", ready)
	}
	emit := func(phase string, values map[string]any) error {
		values["phase"], values["kind"], values["mode"], values["tabId"] = phase, "go", mode, tabID
		return json.NewEncoder(os.Stdout).Encode(values)
	}
	if err := emit("armed", map[string]any{"readyText": *ready, "epoch": stateObject["controlEpoch"], "turn": stateObject["nextTurnId"]}); err != nil {
		return err
	}
	scanner := bufio.NewScanner(os.Stdin)
	waitFor := func(expected string) error {
		if !scanner.Scan() {
			if err := scanner.Err(); err != nil {
				return err
			}
			return fmt.Errorf("stdin closed while waiting for %s", expected)
		}
		if scanner.Text() != expected {
			return fmt.Errorf("expected stdin %q, got %q", expected, scanner.Text())
		}
		return nil
	}
	if err := waitFor("cut"); err != nil {
		return err
	}
	if mode == "close" {
		if err := client.Close(); err != nil {
			return fmt.Errorf("Close: %w", err)
		}
	}
	firstError := oldLocator.Click(obu.BrowserActionOptions{Timeout: time.Second})
	if firstError == nil {
		return errors.New("old locator succeeded after connection cut")
	}
	if mode == "close" && !errors.Is(firstError, obu.ErrBrowserDisconnected) {
		return fmt.Errorf("closed client did not return disconnection error: %w", firstError)
	}
	blockedErrors := map[string]string{}
	calls := []struct {
		name string
		call func() error
	}{
		{"locator", func() error { return oldLocator.Click(obu.BrowserActionOptions{Timeout: time.Second}) }},
		{"BeginTurn", func() error { _, err := client.BeginTurn(); return err }},
		{"Connect", client.Connect},
		{"manualEpoch", func() error {
			_, err := client.Request("browserAction", obu.Params{
				"tabId": tabID, "action": "click", "timeoutMs": 3000,
				"locator":       []obu.Params{{"kind": "css", "selector": "#stale-action"}},
				"control_epoch": stateObject["controlEpoch"],
			})
			return err
		}},
	}
	for _, call := range calls {
		err := call.call()
		if !errors.Is(err, obu.ErrBrowserDisconnected) {
			return fmt.Errorf("old %s did not stay disconnected: %v", call.name, err)
		}
		blockedErrors[call.name] = err.Error()
	}
	if err := emit("blocked", map[string]any{"firstError": firstError.Error(), "blockedErrors": blockedErrors}); err != nil {
		return err
	}
	if err := waitFor("recover"); err != nil {
		return err
	}
	fresh := obu.NewClient(options)
	defer fresh.Close()
	freshState, err := fresh.BeginTurn()
	if err != nil {
		return fmt.Errorf("fresh BeginTurn: %w", err)
	}
	freshObject, ok := freshState.(map[string]any)
	if !ok {
		return errors.New("fresh control state is not an object")
	}
	if err := obu.NewBrowser(fresh).Tab(tabID).Locator("#recover-action").Click(obu.BrowserActionOptions{Timeout: time.Second}); err != nil {
		return fmt.Errorf("fresh locator: %w", err)
	}
	oldError := oldLocator.Click(obu.BrowserActionOptions{Timeout: time.Second})
	if !errors.Is(oldError, obu.ErrBrowserDisconnected) {
		return fmt.Errorf("new client revived old locator: %v", oldError)
	}
	return emit("done", map[string]any{"freshEpoch": freshObject["controlEpoch"], "freshTurn": freshObject["nextTurnId"], "oldLocatorError": oldError.Error()})
}
