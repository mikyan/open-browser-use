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
	"github.com/ifuryst/open-browser-use/internal/managedviewer"
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
	Operation string               `json:"operation,omitempty"`
	RunID     string               `json:"runId,omitempty"`
	State     string               `json:"state,omitempty"`
	Info      *managedbrowser.Info `json:"info,omitempty"`
	Error     string               `json:"error,omitempty"`
	ViewerURL string               `json:"viewerURL,omitempty"`
	NextStep  string               `json:"nextStep,omitempty"`
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
	if err := wire.WriteJSON(conn, managedMessage{State: state, RunID: s.info.RunID, Info: &s.info}); err != nil {
		return
	}
	// User operations require this same live connection and this exact run.
	request, err = readManagedMessage(conn)
	if err != nil {
		return
	}
	if (request.Operation != "stop" && request.Operation != "view") || request.RunID != s.info.RunID {
		_ = wire.WriteJSON(conn, managedMessage{Error: "managed run identity or operation mismatch"})
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
	if operation != "status" && operation != "stop" && operation != "view" {
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
		if operation == "view" {
			return zero, errors.New("managed setup is for manual login; close it before starting managed run")
		}
	} else if (response.Info.Mode != "" && response.Info.Mode != "run") || response.State != "ready" || !transport.IsNamedPipe(response.Info.SocketPath) {
		return zero, errors.New("managed supervisor did not confirm a ready, exact task session")
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
	if operation == "view" {
		location, parseErr := url.Parse(stopped.ViewerURL)
		if stopped.State != "viewer" || stopped.RunID != response.RunID || parseErr != nil || location.Scheme != "http" || location.Hostname() != "127.0.0.1" || location.Port() == "" || location.User != nil || location.Path != "/" || location.RawQuery != "" || !strings.HasPrefix(location.Fragment, "ticket=") || len(location.Fragment) != len("ticket=")+43 {
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
	command := &cobra.Command{Use: "managed", Short: "Experimental isolated browser sessions (Windows)", Long: "Use setup for manual login in a dedicated visible Chromium profile, then close it and start run for isolated headless tasks with a local live viewer. Setup and run cannot use the same profile concurrently. The viewer URL is a private, one-use user capability. The viewer offers experimental explicit control of the current page. Navigation ends takeover, and completion leaves the task paused until explicit Resume and a new turn. Ordinary installed browser profiles are unchanged."}
	command.AddCommand(newManagedSetupCommand())
	var config managedbrowser.Config
	runCommand := &cobra.Command{Use: "run", Short: "Keep an isolated browser running until Ctrl+C or managed stop", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			address, err := managedControlAddress(config.Root, config.Name)
			if err != nil {
				return err
			}
			listener, err := transport.Listen(address)
			if err != nil {
				return fmt.Errorf("managed supervisor is already running or cannot be created: %w", err)
			}
			defer listener.Close()
			config.HostPath, err = os.Executable()
			if err != nil {
				return err
			}
			config.ExtensionPublicKey = betaExtensionPublicKey
			ctx, cancel := signal.NotifyContext(cmd.Context(), os.Interrupt)
			defer cancel()
			startupTimeout := config.StartupTimeout
			if startupTimeout == 0 {
				startupTimeout = 45 * time.Second
			}
			startupCtx, startupCancel := context.WithTimeout(ctx, startupTimeout)
			defer startupCancel()
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
			viewer, err := managedviewer.Start(managedviewer.Config{RunID: session.Info().RunID, Backend: controller, Stop: supervisor.requestStop})
			if err != nil {
				return errors.Join(err, closeManagedRuntime(session, controller))
			}
			supervisor.issueViewerURL = viewer.IssueURL
			supervisor.waitViewerReady = viewer.WaitReady
			// Only the foreground human-facing launch result receives the ticket.
			// Info and management status never contain it; opening it is explicit.
			err = startupCtx.Err()
			startupCancel()
			if err == nil {
				supervisor.serve()
				err = writeJSONTo(cmd.OutOrStdout(), managedMessage{State: "ready", RunID: session.Info().RunID, Info: func() *managedbrowser.Info { info := session.Info(); return &info }(), ViewerURL: viewer.URL()})
			}
			if err == nil {
				select {
				case <-ctx.Done():
				case <-supervisor.stop:
				case <-session.Done():
					err = errors.New("managed browser or native host exited unexpectedly")
				case <-viewer.Done():
					err = errors.New("managed viewer exited unexpectedly")
				}
			}
			supervisor.stopOnce.Do(func() { close(supervisor.stop) })
			closeErr := closeManagedRuntime(session, controller)
			supervisor.finish(closeErr)
			replyCtx, replyCancel := context.WithTimeout(context.Background(), 3*time.Second)
			replyErr := viewer.WaitStopReply(replyCtx)
			replyCancel()
			viewerCtx, viewerCancel := context.WithTimeout(context.Background(), 5*time.Second)
			viewerErr := viewer.Close(viewerCtx)
			viewerCancel()
			return errors.Join(err, closeErr, replyErr, viewerErr)
		}}
	runCommand.Flags().StringVar(&config.Root, "root", defaultManagedRoot(), "dedicated managed session root")
	runCommand.Flags().StringVar(&config.Name, "name", "default", "isolated session name")
	runCommand.Flags().StringVar(&config.BrowserPath, "browser-path", "", "explicit Chromium or Chrome for Testing executable")
	runCommand.Flags().StringVar(&config.ExtensionDir, "extension-dir", "", "built extension directory containing managed-config.js")
	runCommand.Flags().DurationVar(&config.StartupTimeout, "startup-timeout", 30*time.Second, "total startup budget")
	_ = runCommand.MarkFlagRequired("browser-path")
	_ = runCommand.MarkFlagRequired("extension-dir")
	command.AddCommand(runCommand)
	for _, operation := range []string{"status", "stop", "view"} {
		var root, name string
		child := &cobra.Command{Use: operation, Short: operation + " the live managed supervisor", Args: cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				timeout := 5 * time.Second
				if operation == "stop" {
					timeout = 50 * time.Second
				} else if operation == "view" {
					timeout = 35 * time.Second
				}
				response, err := managedUserRequest(root, name, operation, timeout)
				if err != nil {
					return err
				}
				return writeJSONTo(cmd.OutOrStdout(), response)
			}}
		child.Flags().StringVar(&root, "root", defaultManagedRoot(), "dedicated managed session root")
		child.Flags().StringVar(&name, "name", "default", "isolated session name")
		command.AddCommand(child)
	}
	return command
}

func closeManagedRuntime(session *managedbrowser.Session, controller *managedbrowser.UserController) error {
	// Revoke user commands and finish the original stream before normal browser
	// closure. Even a failed/late controller cleanup must not orphan the process
	// tree; a final wait observes the same controller after real browser exit.
	controlCtx, controlCancel := context.WithTimeout(context.Background(), 5*time.Second)
	controlErr := controller.Close(controlCtx)
	controlCancel()
	sessionCtx, sessionCancel := context.WithTimeout(context.Background(), 30*time.Second)
	sessionErr := session.Close(sessionCtx)
	sessionCancel()
	settledCtx, settledCancel := context.WithTimeout(context.Background(), 5*time.Second)
	settledErr := controller.Close(settledCtx)
	settledCancel()
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
	if time.Until(deadline) <= 0 {
		return nil, context.DeadlineExceeded
	}
	return dialLocalEndpoint(status.Info.SocketPath, time.Until(deadline))
}
