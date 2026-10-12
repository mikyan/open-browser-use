package main

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/ifuryst/open-browser-use/internal/browserdownloads"
	"github.com/ifuryst/open-browser-use/internal/wire"
	"github.com/spf13/cobra"
)

func newBindBrowserCommand() *cobra.Command {
	var endpoint, cdpURL string
	var exclusive bool
	var timeout time.Duration
	command := &cobra.Command{Use: "bind-browser", Short: "Explicitly bind this host to an authorized Browser CDP connection", Args: cobra.NoArgs,
		Long: "Bind an exact local host endpoint to an authorized loopback Browser WebSocket. --exclusive confirms this tool may enable native download events and set CDP download behavior to default. User download preferences are not changed.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if strings.TrimSpace(endpoint) == "" || endpoint != strings.TrimSpace(endpoint) || !exclusive {
				return errors.New("bind-browser requires an exact --socket and --exclusive")
			}
			if timeout < time.Millisecond || timeout > 120*time.Second {
				return errors.New("bind-browser --timeout must be from 1ms to 120s")
			}
			if err := browserdownloads.ValidateURL(cdpURL); err != nil {
				return err
			}
			deadline := time.Now().Add(timeout)
			conn, err := dialLocalEndpoint(endpoint, time.Until(deadline))
			if err != nil {
				return err
			}
			defer conn.Close()
			if err := conn.SetDeadline(deadline); err != nil {
				return err
			}
			remaining := time.Until(deadline).Milliseconds()
			if remaining < 1 {
				return errors.New("bind-browser deadline expired before submission")
			}
			id := fmt.Sprintf("bind-browser:%d", time.Now().UnixNano())
			if err := wire.WriteJSON(conn, map[string]any{"jsonrpc": "2.0", "id": id, "method": "host.bindBrowser", "params": map[string]any{"cdpURL": cdpURL, "exclusive": true, "timeoutMs": remaining}}); err != nil {
				return err
			}
			response, err := readResponseForID(conn, id)
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
			return writeJSONTo(cmd.OutOrStdout(), response)
		}}
	command.Flags().StringVar(&endpoint, "socket", "", "exact native host endpoint; no discovery or fallback")
	command.Flags().StringVar(&cdpURL, "cdp-url", "", "authorized loopback /devtools/browser/ WebSocket URL")
	command.Flags().BoolVar(&exclusive, "exclusive", false, "confirm exclusive control of Browser CDP download behavior")
	command.Flags().DurationVar(&timeout, "timeout", 10*time.Second, "total binding timeout")
	for _, name := range []string{"socket", "cdp-url", "exclusive"} {
		_ = command.MarkFlagRequired(name)
	}
	return command
}
