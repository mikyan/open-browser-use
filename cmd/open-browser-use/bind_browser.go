package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/ifuryst/open-browser-use/internal/browserdownloads"
	"github.com/ifuryst/open-browser-use/internal/wire"
	"github.com/spf13/cobra"
)

func newBindBrowserCommand() *cobra.Command {
	var endpoint, cdpURL, browser, userDataDir string
	var exclusive, autoConnect bool
	var timeout time.Duration
	command := &cobra.Command{Use: "bind-browser", Short: "Explicitly bind this host to an authorized Browser CDP connection", Args: cobra.NoArgs,
		Long: "Bind an exact local host endpoint to an authorized loopback Browser WebSocket. Use --cdp-url, or --auto-connect --browser chrome|edge to read only that browser's DevToolsActivePort file. --exclusive confirms this tool may enable native download events and set CDP download behavior to default. User download preferences are not changed.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if strings.TrimSpace(endpoint) == "" || endpoint != strings.TrimSpace(endpoint) || !exclusive {
				return errors.New("bind-browser requires an exact --socket and --exclusive")
			}
			if autoConnect && cmd.Flags().Changed("cdp-url") {
				return errors.New("bind-browser --auto-connect and --cdp-url are mutually exclusive")
			}
			if !autoConnect && (cmd.Flags().Changed("browser") || cmd.Flags().Changed("user-data-dir")) {
				return errors.New("bind-browser --browser and --user-data-dir require --auto-connect")
			}
			if autoConnect && !cmd.Flags().Changed("timeout") {
				timeout = 60 * time.Second
			}
			if timeout < time.Millisecond || timeout > 120*time.Second {
				return errors.New("bind-browser --timeout must be from 1ms to 120s")
			}
			ctx, cancel := context.WithTimeout(cmd.Context(), timeout)
			defer cancel()
			if err := bindContextError(ctx); err != nil {
				return err
			}
			if autoConnect {
				root, err := bindBrowserRoot(browser, userDataDir, cmd.Flags().Changed("user-data-dir"))
				if err != nil {
					return err
				}
				cdpURL, err = discoverBindBrowser(ctx, root)
				if err != nil {
					return err
				}
				if _, err := fmt.Fprintf(cmd.ErrOrStderr(), "Allow the remote debugging connection in %s if prompted. Waiting within the original bind-browser timeout.\n", browser); err != nil {
					return err
				}
			}
			if err := browserdownloads.ValidateURL(cdpURL); err != nil {
				return err
			}
			deadline, _ := ctx.Deadline()
			conn, err := dialBindBrowser(ctx, endpoint)
			if err != nil {
				return err
			}
			defer conn.Close()
			stopCancel := context.AfterFunc(ctx, func() { _ = conn.Close() })
			defer stopCancel()
			if err := conn.SetDeadline(deadline); err != nil {
				return err
			}
			if err := bindContextError(ctx); err != nil {
				return err
			}
			remaining := time.Until(deadline).Milliseconds()
			if remaining < 1 {
				return errors.New("bind-browser deadline expired before submission")
			}
			id := fmt.Sprintf("bind-browser:%d", time.Now().UnixNano())
			params := map[string]any{"cdpURL": cdpURL, "exclusive": true, "timeoutMs": remaining}
			if autoConnect {
				params["loopbackFallback"] = true
			}
			if err := wire.WriteJSON(conn, map[string]any{"jsonrpc": "2.0", "id": id, "method": "host.bindBrowser", "params": params}); err != nil {
				return err
			}
			response, err := readResponseForID(conn, id)
			if contextErr := bindContextError(ctx); contextErr != nil {
				return contextErr
			}
			if err != nil {
				return err
			}
			if failure, ok := response["error"].(map[string]any); ok {
				return fmt.Errorf("bind-browser: %v", failure["message"])
			}
			result, ok := response["result"].(map[string]any)
			if response["jsonrpc"] != "2.0" || !ok || result["bound"] != true || result["exclusive"] != true || result["behavior"] != "default" {
				return errors.New("bind-browser: invalid host binding acknowledgement")
			}
			for _, key := range []string{"generation", "extensionId", "extensionInstanceId", "workerBootId", "portId"} {
				if value, ok := result[key].(string); !ok || value == "" || len(value) > 256 {
					return errors.New("bind-browser: incomplete host binding identity")
				}
			}
			if err := bindContextError(ctx); err != nil {
				return err
			}
			return writeJSONTo(cmd.OutOrStdout(), response)
		}}
	command.Flags().StringVar(&endpoint, "socket", "", "exact native host endpoint; no discovery or fallback")
	command.Flags().StringVar(&cdpURL, "cdp-url", "", "authorized loopback /devtools/browser/ WebSocket URL")
	command.Flags().BoolVar(&autoConnect, "auto-connect", false, "read only the selected browser root's DevToolsActivePort file")
	command.Flags().StringVar(&browser, "browser", "", "required with --auto-connect: chrome or edge (stable)")
	command.Flags().StringVar(&userDataDir, "user-data-dir", "", "absolute local browser user-data root; only with --auto-connect")
	command.Flags().BoolVar(&exclusive, "exclusive", false, "confirm exclusive control of Browser CDP download behavior")
	command.Flags().DurationVar(&timeout, "timeout", 10*time.Second, "total binding timeout (10s manual; 60s auto-connect; maximum 120s)")
	for _, name := range []string{"socket", "exclusive"} {
		_ = command.MarkFlagRequired(name)
	}
	return command
}

func bindContextError(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if deadline, ok := ctx.Deadline(); ok && !time.Now().Before(deadline) {
		return context.DeadlineExceeded
	}
	return nil
}

func dialBindBrowser(ctx context.Context, endpoint string) (net.Conn, error) {
	if err := bindContextError(ctx); err != nil {
		return nil, err
	}
	deadline, _ := ctx.Deadline()
	dial := dialLocalEndpoint
	type result struct {
		conn net.Conn
		err  error
	}
	ready := make(chan result)
	go func() {
		conn, err := dial(endpoint, time.Until(deadline))
		select {
		case ready <- result{conn, err}:
		case <-ctx.Done():
			if conn != nil {
				_ = conn.Close()
			}
		}
	}()
	select {
	case value := <-ready:
		if err := bindContextError(ctx); err != nil {
			if value.conn != nil {
				_ = value.conn.Close()
			}
			return nil, err
		}
		return value.conn, value.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
