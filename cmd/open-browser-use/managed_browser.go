package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"time"

	"github.com/ifuryst/open-browser-use/internal/managedruntime"
	"github.com/spf13/cobra"
)

const managedBrowserInstallTimeout = 10 * time.Minute

// This boundary selects only the owned runtime. Ordinary browser discovery and
// native-host installation deliberately do not participate in managed launch.
type managedBrowserAccess struct {
	defaultRoot func() (string, error)
	inspect     func(context.Context, string) (managedruntime.Installation, error)
	install     func(context.Context, string) (managedruntime.Installation, error)
	executable  func() (string, error)
}

func defaultManagedBrowserAccess() managedBrowserAccess {
	return managedBrowserAccess{managedruntime.DefaultRoot, managedruntime.Inspect, managedruntime.Install, os.Executable}
}

func (a managedBrowserAccess) cacheRoot(explicit string) (string, error) {
	root := explicit
	if root == "" {
		var err error
		root, err = a.defaultRoot()
		if err != nil {
			return "", fmt.Errorf("managed browser cache is unavailable; specify --browser-cache with an absolute dedicated directory: %w", err)
		}
	}
	if root == "" || !filepath.IsAbs(root) {
		return "", errors.New("--browser-cache must be an absolute dedicated directory")
	}
	return root, nil
}

func (a managedBrowserAccess) inspectCache(ctx context.Context, cache string) (managedruntime.Installation, error) {
	root, err := a.cacheRoot(cache)
	if err != nil {
		return managedruntime.Installation{}, err
	}
	installation, err := a.inspect(ctx, root)
	if errors.Is(err, managedruntime.ErrNotInstalled) {
		return managedruntime.Installation{}, fmt.Errorf("managed browser %s is not installed in %s; run 'open-browser-use managed browser install' with the same --browser-cache, or specify --browser-path: %w", managedruntime.RecommendedVersion, root, err)
	}
	if err != nil {
		return managedruntime.Installation{}, fmt.Errorf("managed browser cache validation failed; no browser was selected: %w", err)
	}
	return installation, nil
}

func (a managedBrowserAccess) browserPath(ctx context.Context, explicit, cache string) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	installation, err := a.inspectCache(ctx, cache)
	if err != nil {
		return "", err
	}
	return installation.Executable, nil
}

func managedExtensionPath(explicit, executable string) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	directory := filepath.Join(filepath.Dir(executable), "extension")
	info, err := os.Stat(directory)
	if err != nil || !info.IsDir() {
		if err == nil {
			err = errors.New("the adjacent extension path is not a directory")
		}
		return "", fmt.Errorf("managed extension is unavailable next to the executable; extract the complete package or specify --extension-dir: %w", err)
	}
	// Start still validates and privately stages the full original extension.
	return directory, nil
}

func newManagedBrowserCommand(access managedBrowserAccess) *cobra.Command {
	command := &cobra.Command{Use: "browser", Short: "Prepare or inspect the dedicated managed Chromium runtime"}
	for _, operation := range []string{"install", "status"} {
		var cache string
		timeout := managedBrowserInstallTimeout
		child := &cobra.Command{Use: operation, Args: cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				if operation == "install" && (timeout <= 0 || timeout > managedBrowserInstallTimeout) {
					return errors.New("managed browser install --timeout must be greater than zero and at most 10m")
				}
				ctx, cancel := signal.NotifyContext(cmd.Context(), os.Interrupt)
				defer cancel()
				if operation == "status" {
					installation, err := access.inspectCache(ctx, cache)
					if err != nil {
						return err
					}
					return writeJSONTo(cmd.OutOrStdout(), installation)
				}
				root, err := access.cacheRoot(cache)
				if err != nil {
					return err
				}
				installCtx, finish := context.WithTimeout(ctx, timeout)
				defer finish()
				installation, err := access.install(installCtx, root)
				if err != nil {
					return fmt.Errorf("managed browser installation was not completed: %w", err)
				}
				return writeJSONTo(cmd.OutOrStdout(), installation)
			}}
		child.Flags().StringVar(&cache, "browser-cache", "", "absolute owned browser cache directory (default: dedicated user cache)")
		if operation == "install" {
			child.Short = "Explicitly download or verify the fixed recommended Chromium " + managedruntime.RecommendedVersion
			child.Flags().DurationVar(&timeout, "timeout", managedBrowserInstallTimeout, "total install budget, at most 10m")
		} else {
			child.Short = "Verify the managed browser cache offline, without downloading"
		}
		command.AddCommand(child)
	}
	return command
}
