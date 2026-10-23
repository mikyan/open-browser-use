package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/ifuryst/open-browser-use/internal/host"
	"github.com/ifuryst/open-browser-use/internal/managedbrowser"
	"github.com/ifuryst/open-browser-use/internal/transport"
	"github.com/ifuryst/open-browser-use/internal/wire"
	"github.com/spf13/cobra"
)

var managedNamePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,47}$`)

func validateManagedFlags(command *cobra.Command, options *socketOptions) error {
	if command.Flags().Changed("managed") && !managedNamePattern.MatchString(options.managedName) {
		return errors.New("managed name must be nonempty lowercase letters, digits or hyphens, starting with a letter (maximum 48 characters)")
	}
	if command.Flags().Changed("managed-root") && options.managedName == "" {
		return errors.New("--managed-root requires --managed")
	}
	return nil
}

func defaultManagedRoot() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "OpenBrowserUse", "managed")
}

// The control address locates a live supervisor, never a PID or a stale task
// endpoint. The pipe uses the existing current-user ACL and exclusive instance.
func managedControlAddress(root, name string) (string, error) {
	if runtime.GOOS != "windows" {
		return "", errors.New("managed sessions currently require Windows 10 or newer")
	}
	if !managedNamePattern.MatchString(name) {
		return "", errors.New("managed name must be 1-48 lowercase letters, digits or hyphens, starting with a letter")
	}
	if root == "" || !filepath.IsAbs(root) {
		return "", errors.New("managed root must be an absolute dedicated directory")
	}
	canonical := strings.ToLower(filepath.Clean(root)) + "\x00" + name
	hash := sha256.Sum256([]byte(canonical))
	return transport.NewEndpoint("", fmt.Sprintf("managed-%x", hash[:20])), nil
}

type managedMessage struct {
	Operation   string               `json:"operation,omitempty"`
	RunID       string               `json:"runId,omitempty"`
	State       string               `json:"state,omitempty"`
	Info        *managedbrowser.Info `json:"info,omitempty"`
	Error       string               `json:"error,omitempty"`
	ViewerURL   string               `json:"viewerURL,omitempty"`
	NextStep    string               `json:"nextStep,omitempty"`
	NativeEpoch uint64               `json:"nativeEpoch,omitempty"`
}

func readManagedMessage(conn net.Conn) (managedMessage, error) {
	var message managedMessage
	payload, err := wire.ReadFrame(conn, 4096)
	if err != nil {
		return message, err
	}
	err = json.Unmarshal(payload, &message)
	return message, err
}

// Only the supervisor owns shutdown. A caller receives a stopped response only
// after the original Session.Close has finished. There is no task RPC setter.
type managedSupervisor struct {
	listener        net.Listener
	info            managedbrowser.Info
	stop            chan struct{}
	finished        chan struct{}
	stopOnce        sync.Once
	err             error
	mu              sync.Mutex
	connections     map[net.Conn]struct{}
	wg              sync.WaitGroup
	issueViewerURL  func() (string, error)
	waitViewerReady func(context.Context) error
	statusSnapshot  func() managedMessage
	recoverViewer   func(context.Context) (managedMessage, error)
}

func newManagedSupervisor(listener net.Listener, info managedbrowser.Info) *managedSupervisor {
	return &managedSupervisor{listener: listener, info: info, stop: make(chan struct{}), finished: make(chan struct{}), connections: make(map[net.Conn]struct{})}
}

func (s *managedSupervisor) serve() {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for {
			conn, err := s.listener.Accept()
			if err != nil {
				return
			}
			s.mu.Lock()
			if len(s.connections) >= 8 {
				s.mu.Unlock()
				conn.Close()
				continue
			}
			s.connections[conn] = struct{}{}
			s.wg.Add(1)
			s.mu.Unlock()
			go func() {
				defer s.wg.Done()
				defer func() { conn.Close(); s.mu.Lock(); delete(s.connections, conn); s.mu.Unlock() }()
				s.handle(conn)
			}()
		}
	}()
}

func (s *managedSupervisor) handle(conn net.Conn) {
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	request, err := readManagedMessage(conn)
	if err != nil || request.Operation != "status" || request.RunID != "" {
		return
	}
	select {
	case <-s.stop:
		_ = wire.WriteJSON(conn, managedMessage{State: "stopping", RunID: s.info.RunID})
		return
	default:
	}
	state := "ready"
	if s.info.Mode == "setup" {
		state = "setup"
	}
	status := managedMessage{State: state, RunID: s.info.RunID, Info: &s.info}
	if s.statusSnapshot != nil {
		status = s.statusSnapshot()
	}
	if err := wire.WriteJSON(conn, status); err != nil {
		return
	}
	// User operations require this same live connection and this exact run.
	request, err = readManagedMessage(conn)
	if err != nil {
		return
	}
	if (request.Operation != "stop" && request.Operation != "view" && request.Operation != "recover") || request.RunID != s.info.RunID {
		_ = wire.WriteJSON(conn, managedMessage{Error: "managed run identity or operation mismatch"})
		return
	}
	if request.Operation == "recover" {
		if s.info.Mode == "setup" || s.recoverViewer == nil {
			_ = wire.WriteJSON(conn, managedMessage{Error: "this managed session does not support Native recovery"})
			return
		}
		_ = conn.SetDeadline(time.Now().Add(60 * time.Second))
		ctx, cancel := context.WithTimeout(context.Background(), 55*time.Second)
		defer cancel()
		go func() {
			select {
			case <-s.stop:
				cancel()
			case <-ctx.Done():
			}
		}()
		select {
		case <-s.stop:
			_ = wire.WriteJSON(conn, managedMessage{Error: "managed session is stopping"})
			return
		default:
		}
		response, err := s.recoverViewer(ctx)
		if err != nil {
			_ = wire.WriteJSON(conn, managedMessage{Error: err.Error()})
			return
		}
		select {
		case <-s.stop:
			_ = wire.WriteJSON(conn, managedMessage{Error: "managed session stopped before recovery delivery"})
			return
		default:
		}
		_ = wire.WriteJSON(conn, response)
		return
	}
	if request.Operation == "view" {
		if s.info.Mode == "setup" {
			_ = wire.WriteJSON(conn, managedMessage{Error: "managed setup is for manual login; no task viewer is available"})
			return
		}
		select {
		case <-s.stop:
			_ = wire.WriteJSON(conn, managedMessage{Error: "managed session is stopping"})
			return
		default:
		}
		if s.issueViewerURL == nil {
			_ = wire.WriteJSON(conn, managedMessage{Error: "managed viewer is unavailable"})
			return
		}
		_ = conn.SetDeadline(time.Now().Add(35 * time.Second))
		if s.waitViewerReady != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			go func() {
				select {
				case <-s.stop:
					cancel()
				case <-ctx.Done():
				}
			}()
			err := s.waitViewerReady(ctx)
			cancel()
			if err != nil {
				_ = wire.WriteJSON(conn, managedMessage{Error: err.Error()})
				return
			}
		}
		select {
		case <-s.stop:
			_ = wire.WriteJSON(conn, managedMessage{Error: "managed session is stopping"})
			return
		default:
		}
		viewerURL, err := s.issueViewerURL()
		if err != nil {
			_ = wire.WriteJSON(conn, managedMessage{Error: err.Error()})
			return
		}
		_ = wire.WriteJSON(conn, managedMessage{State: "viewer", RunID: s.info.RunID, ViewerURL: viewerURL})
		return
	}
	s.stopOnce.Do(func() { close(s.stop) })
	_ = conn.SetDeadline(time.Now().Add(50 * time.Second))
	<-s.finished
	response := managedMessage{State: "stopped", RunID: s.info.RunID}
	if s.err != nil {
		response.State = "cleanup-failed"
		response.Error = s.err.Error()
	}
	_ = wire.WriteJSON(conn, response)
}

// The HTTP user route shares the supervisor's original shutdown receipt. It
// never closes its own HTTP server from inside a pending Stop handler.
func (s *managedSupervisor) requestStop(ctx context.Context) error {
	s.stopOnce.Do(func() { close(s.stop) })
	select {
	case <-s.finished:
		return s.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *managedSupervisor) finish(err error) {
	_ = s.listener.Close()
	s.err = err
	close(s.finished)
	// Status-only peers can hold a read for at most five seconds. Stop replies
	// are delivered before we close the remaining connections.
	done := make(chan struct{})
	go func() { s.wg.Wait(); close(done) }()
	select {
	case <-done:
		return
	case <-time.After(6 * time.Second):
	}
	s.mu.Lock()
	for conn := range s.connections {
		_ = conn.Close()
	}
	s.mu.Unlock()
	<-done
}

func managedRequest(root, name string, stop bool, timeout time.Duration) (managedMessage, error) {
	operation := "status"
	if stop {
		operation = "stop"
	}
	return managedUserRequest(root, name, operation, timeout)
}

func managedUserRequest(root, name, operation string, timeout time.Duration) (managedMessage, error) {
	var zero managedMessage
	if operation != "status" && operation != "stop" && operation != "view" && operation != "recover" {
		return zero, errors.New("unknown managed user operation")
	}
	endpoint, err := managedControlAddress(root, name)
	if err != nil {
		return zero, err
	}
	if timeout <= 0 {
		return zero, context.DeadlineExceeded
	}
	deadline := time.Now().Add(timeout)
	conn, err := transport.DialTimeout(endpoint, timeout)
	if err != nil {
		return zero, fmt.Errorf("managed session %q has no reachable supervisor: %w", name, err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(deadline); err != nil {
		return zero, err
	}
	if err := wire.WriteJSON(conn, managedMessage{Operation: "status"}); err != nil {
		return zero, err
	}
	response, err := readManagedMessage(conn)
	if err != nil {
		return zero, err
	}
	if response.Info == nil || response.Info.Name != name || response.Info.RunID == "" || response.RunID != response.Info.RunID {
		return zero, errors.New("managed supervisor did not confirm a ready, exact session")
	}
	if response.Info.Mode == "setup" {
		info := response.Info
		if response.State != "setup" || info.BrowserPID <= 0 || info.SocketPath != "" || info.NativePID != 0 || info.NativeHostName != "" || info.ExtensionID != "" || info.ExtensionInstanceID != "" || response.ViewerURL != "" {
			return zero, errors.New("managed setup reported an invalid browser identity or task endpoint")
		}
		if operation == "view" || operation == "recover" {
			return zero, errors.New("managed setup is for manual login; close it before starting managed run")
		}
	} else {
		if response.Info.Mode != "" && response.Info.Mode != "run" {
			return zero, errors.New("managed supervisor reported an unknown session mode")
		}
		switch response.State {
		case "ready":
			if !transport.IsNamedPipe(response.Info.SocketPath) {
				return zero, errors.New("managed supervisor did not confirm an exact task endpoint")
			}
		case "degraded", "recovering":
			if response.Info.SocketPath != "" || response.Info.BrowserPID <= 0 || response.ViewerURL != "" {
				return zero, errors.New("unavailable managed session leaked an endpoint or has no browser identity")
			}
			if operation == "view" {
				return zero, errors.New("managed connection is unavailable; use managed recover explicitly")
			}
		default:
			return zero, errors.New("managed supervisor did not confirm an available management session")
		}
	}
	if operation == "status" {
		return response, nil
	}
	if err := wire.WriteJSON(conn, managedMessage{Operation: operation, RunID: response.RunID}); err != nil {
		return zero, err
	}
	stopped, err := readManagedMessage(conn)
	if err != nil {
		return zero, fmt.Errorf("managed %s outcome is unknown: %w", operation, err)
	}
	if stopped.Error != "" {
		return stopped, errors.New(stopped.Error)
	}
	if operation == "view" || operation == "recover" {
		location, parseErr := url.Parse(stopped.ViewerURL)
		wantedState := "viewer"
		if operation == "recover" {
			wantedState = "recovered"
			if stopped.Info == nil || stopped.Info.RunID != response.RunID || stopped.Info.Name != name || !transport.IsNamedPipe(stopped.Info.SocketPath) || stopped.NativeEpoch <= response.NativeEpoch {
				return stopped, errors.New("managed recovery did not confirm a new Native generation in the original run")
			}
		}
		if stopped.State != wantedState || stopped.RunID != response.RunID || parseErr != nil || location.Scheme != "http" || location.Hostname() != "127.0.0.1" || location.Port() == "" || location.User != nil || location.Path != "/" || location.RawQuery != "" || !strings.HasPrefix(location.Fragment, "ticket=") || len(location.Fragment) != len("ticket=")+43 {
			return stopped, errors.New("managed viewer did not confirm the original run and local URL")
		}
		return stopped, nil
	}
	if stopped.State != "stopped" || stopped.RunID != response.RunID {
		return stopped, errors.New("managed shutdown did not confirm the original run")
	}
	return stopped, nil
}

func newManagedCommand() *cobra.Command {
	return newManagedCommandWithBrowser(defaultManagedBrowserAccess())
}

func newManagedCommandWithBrowser(browser managedBrowserAccess) *cobra.Command {
	command := &cobra.Command{Use: "managed", Short: "Experimental isolated browser sessions (Windows)", Long: "Explicitly prepare the fixed recommended Chromium with managed browser install, or provide --browser-path. Setup and run only inspect the local cache; they never download a browser. Use setup for manual login in a dedicated visible profile, then close it and start run for isolated headless tasks with a local live viewer. Setup and run cannot use the same profile concurrently. The viewer URL is a private, one-use user capability. Experimental takeover can continue through navigation within the same original tab and target; completion leaves the task paused until explicit Resume and a new turn. Finalized result pages can be viewed and operated while the task remains paused. Ordinary installed browser profiles are unchanged."}
	command.AddCommand(newManagedSetupCommandWithBrowser(browser), newManagedBrowserCommand(browser))
	var config managedbrowser.Config
	var browserCache string
	runCommand := &cobra.Command{Use: "run", Short: "Keep an isolated browser running until Ctrl+C or managed stop", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx, cancel := signal.NotifyContext(cmd.Context(), os.Interrupt)
			defer cancel()
			startupTimeout := config.StartupTimeout
			if startupTimeout == 0 {
				startupTimeout = 45 * time.Second
			}
			startupCtx, startupCancel := context.WithTimeout(ctx, startupTimeout)
			defer startupCancel()
			var err error
			config.BrowserPath, err = browser.browserPath(startupCtx, config.BrowserPath, browserCache)
			if err != nil {
				return err
			}
			config.HostPath, err = browser.executable()
			if err != nil {
				return err
			}
			config.ExtensionDir, err = managedExtensionPath(config.ExtensionDir, config.HostPath)
			if err != nil {
				return err
			}
			config.ExtensionPublicKey = betaExtensionPublicKey
			address, err := managedControlAddress(config.Root, config.Name)
			if err != nil {
				return err
			}
			listener, err := transport.Listen(address)
			if err != nil {
				return fmt.Errorf("managed supervisor is already running or cannot be created: %w", err)
			}
			defer listener.Close()
			session, err := managedbrowser.Start(startupCtx, config)
			if err != nil {
				return err
			}
			controller, err := session.OpenUserController(startupCtx)
			if err != nil {
				cleanupCtx, finish := context.WithTimeout(context.Background(), 30*time.Second)
				defer finish()
				return errors.Join(err, session.Close(cleanupCtx))
			}
			supervisor := newManagedSupervisor(listener, session.Info())
			runtime, err := newManagedRuntime(session, controller, supervisor)
			if err != nil {
				return errors.Join(err, closeManagedRuntime(session, controller))
			}
			// Only the foreground human-facing launch result receives the ticket.
			// Info and management status never contain it; opening it is explicit.
			err = startupCtx.Err()
			startupCancel()
			if err == nil {
				ready := runtime.status()
				if ready.State != "ready" {
					err = errors.New("managed connection ended before startup publication")
				} else {
					supervisor.serve()
					ready.ViewerURL = runtime.viewer.URL()
					err = writeJSONTo(cmd.OutOrStdout(), ready)
				}
			}
			if err == nil {
				select {
				case <-ctx.Done():
				case <-supervisor.stop:
				case <-session.Done():
					err = errors.New("managed browser exited unexpectedly")
				}
			}
			supervisor.stopOnce.Do(func() { close(supervisor.stop) })
			closeErr := runtime.close()
			supervisor.finish(closeErr)
			return errors.Join(err, closeErr, runtime.closeViewers())
		}}
	runCommand.Flags().StringVar(&config.Root, "root", defaultManagedRoot(), "dedicated managed session root")
	runCommand.Flags().StringVar(&config.Name, "name", "default", "isolated session name")
	runCommand.Flags().StringVar(&config.BrowserPath, "browser-path", "", "explicit Chromium executable; otherwise verify the owned local cache")
	runCommand.Flags().StringVar(&browserCache, "browser-cache", "", "absolute owned browser cache directory; ignored with --browser-path")
	runCommand.Flags().StringVar(&config.ExtensionDir, "extension-dir", "", "built extension directory; defaults only to extension next to this executable")
	runCommand.Flags().DurationVar(&config.StartupTimeout, "startup-timeout", 30*time.Second, "total startup budget")
	runCommand.Flags().BoolVar(&config.RestoreLastSession, "restore", false, "request Chromium's native session restore in the same dedicated profile; starts a new run with new handles and explicit page claims, without guaranteeing restored pages or memory")
	command.AddCommand(runCommand)
	for _, operation := range []string{"status", "stop", "view", "recover"} {
		var root, name string
		child := &cobra.Command{Use: operation, Short: operation + " the live managed supervisor", Args: cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				timeout := 5 * time.Second
				if operation == "stop" {
					timeout = 50 * time.Second
				} else if operation == "view" {
					timeout = 35 * time.Second
				} else if operation == "recover" {
					timeout = 65 * time.Second
				}
				response, err := managedUserRequest(root, name, operation, timeout)
				if err != nil {
					return err
				}
				return writeJSONTo(cmd.OutOrStdout(), response)
			}}
		child.Flags().StringVar(&root, "root", defaultManagedRoot(), "dedicated managed session root")
		child.Flags().StringVar(&name, "name", "default", "isolated session name")
		if operation == "recover" {
			child.Short = "Reconnect an ended Native connection in the original managed browser"
			child.Long = "Explicitly retire the old connection and reconnect to the same original browser. A replacement extension worker must verify the original recovery journal and release its recorded page resources before issuing fresh result permissions. Returns a new one-use viewer URL and leaves the Agent paused; Resume and a new turn are required for further automation. Unknown input, missing original records or unconfirmed cleanup prevents recovery. No page navigation or input is replayed."
		}
		command.AddCommand(child)
	}
	return command
}

func closeManagedRuntime(session *managedbrowser.Session, controller *managedbrowser.UserController) error {
	return closeManagedRuntimeResources(session.Close, controller.Close)
}

func closeManagedRuntimeResources(closeSession, closeController func(context.Context) error) error {
	// Revoke user commands and finish the original stream before normal browser
	// closure. Even a failed/late controller cleanup must not orphan the process
	// tree; a final wait observes the same controller after real browser exit.
	controlCtx, controlCancel := context.WithTimeout(context.Background(), 5*time.Second)
	controlErr := closeController(controlCtx)
	controlCancel()
	sessionCtx, sessionCancel := context.WithTimeout(context.Background(), 30*time.Second)
	sessionErr := closeSession(sessionCtx)
	sessionCancel()
	settledCtx, settledCancel := context.WithTimeout(context.Background(), 5*time.Second)
	settledErr := closeController(settledCtx)
	settledCancel()
	// Session.Close succeeds only after the original owned Browser/Job exits.
	// The second controller wait must also settle. Only this exact temporary
	// wait is superseded; a timeout, wrapped/joined cause or other failure stays.
	if controlErr == managedbrowser.ErrUserCleanupPendingOwnedExit && sessionErr == nil && settledErr == nil {
		controlErr = nil
	}
	return errors.Join(controlErr, sessionErr, settledErr)
}

func dialBrowserSocketForOptions(options socketOptions, timeout time.Duration) (net.Conn, error) {
	if options.managedName == "" {
		if options.managedRoot != "" && options.managedRoot != defaultManagedRoot() {
			return nil, errors.New("--managed-root requires --managed")
		}
		return dialBrowserSocketForProfile(options.socketPath, options.socketDir, options.browser, options.profile, timeout)
	}
	if options.socketPath != "" || options.browser != "" || options.profile != "" || (options.socketDir != "" && options.socketDir != host.DefaultSocketDir) {
		return nil, errors.New("--managed cannot be combined with another browser, profile or endpoint selector")
	}
	deadline := time.Now().Add(timeout)
	root := options.managedRoot
	if root == "" {
		root = defaultManagedRoot()
	}
	status, err := managedRequest(root, options.managedName, false, timeout)
	if err != nil {
		return nil, err
	}
	if status.Info.Mode == "setup" {
		return nil, errors.New("managed session is in manual login setup; close setup and explicitly start managed run before connecting an Agent")
	}
	if status.State != "ready" {
		return nil, errors.New("managed task connection is unavailable; use managed recover explicitly, then Resume and start a new turn")
	}
	if time.Until(deadline) <= 0 {
		return nil, context.DeadlineExceeded
	}
	return dialLocalEndpoint(status.Info.SocketPath, time.Until(deadline))
}
