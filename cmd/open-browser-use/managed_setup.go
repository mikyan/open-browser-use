package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"time"

	"github.com/ifuryst/open-browser-use/internal/managedbrowser"
	"github.com/ifuryst/open-browser-use/internal/transport"
	"github.com/spf13/cobra"
)

func newManagedSetupCommand() *cobra.Command {
	var config managedbrowser.SetupConfig
	command := &cobra.Command{
		Use: "setup", Short: "Open the dedicated profile for manual login, without Agent access",
		Long: "Open a visible, dedicated Chromium profile at about:blank. Navigate and log in yourself, then close this browser or use managed stop. Start managed run separately with the same name, root and browser. Persistent cookies and site data remain in this profile; open documents and in-memory state are not transferred. No task extension, native host or viewer is started.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			address, err := managedControlAddress(config.Root, config.Name)
			if err != nil {
				return err
			}
			listener, err := transport.Listen(address)
			if err != nil {
				return fmt.Errorf("managed profile is already supervised or cannot be reserved: %w", err)
			}
			defer listener.Close()
			ctx, cancel := signal.NotifyContext(cmd.Context(), os.Interrupt)
			defer cancel()
			session, err := managedbrowser.StartSetup(ctx, config)
			if err != nil {
				return err
			}
			supervisor := newManagedSupervisor(listener, session.Info())
			supervisor.serve()
			info := session.Info()
			err = writeJSONTo(cmd.OutOrStdout(), managedMessage{State: "setup", RunID: info.RunID, Info: &info,
				NextStep: "Log in using this browser, then close it or use managed stop. Start managed run separately with the same name, root and browser."})
			if err == nil {
				select {
				case <-ctx.Done():
				case <-supervisor.stop:
				case <-session.Done():
				}
			}
			supervisor.stopOnce.Do(func() { close(supervisor.stop) })
			cleanupCtx, finish := context.WithTimeout(context.Background(), 30*time.Second)
			defer finish()
			closeErr := session.Close(cleanupCtx)
			supervisor.finish(closeErr)
			return errors.Join(err, closeErr)
		},
	}
	command.Flags().StringVar(&config.Root, "root", defaultManagedRoot(), "dedicated managed profile root, shared with run")
	command.Flags().StringVar(&config.Name, "name", "default", "isolated profile name, shared with run")
	command.Flags().StringVar(&config.BrowserPath, "browser-path", "", "explicit Chromium or Chrome for Testing executable, shared with run")
	command.Flags().DurationVar(&config.StartupTimeout, "startup-timeout", 30*time.Second, "total startup budget")
	_ = command.MarkFlagRequired("browser-path")
	return command
}
