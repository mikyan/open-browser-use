// Package managedbrowser owns an explicit, isolated Chromium process tree.
// It never discovers an installed profile or substitutes a global host endpoint.
package managedbrowser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/ifuryst/open-browser-use/internal/host"
	"github.com/ifuryst/open-browser-use/internal/transport"
)

type Info struct {
	Name                string `json:"name"`
	RunID               string `json:"runId"`
	RunDir              string `json:"runDir"`
	ProfileDir          string `json:"profileDir"`
	SocketPath          string `json:"socketPath"`
	BrowserPID          int    `json:"browserPID"`
	NativePID           int    `json:"nativePID"`
	ExtensionID         string `json:"extensionId"`
	NativeHostName      string `json:"nativeHostName"`
	ExtensionInstanceID string `json:"extensionInstanceId"`
}

type exitReceipt struct {
	At    time.Time `json:"at"`
	Code  *uint32   `json:"code,omitempty"`
	Error string    `json:"error,omitempty"`
}

type acknowledgement struct {
	At     time.Time       `json:"at"`
	Error  string          `json:"error,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
}

type lifecycle struct {
	Version             int                      `json:"version"`
	State               string                   `json:"state"`
	StartedAt           time.Time                `json:"startedAt"`
	ReadyAt             *time.Time               `json:"readyAt,omitempty"`
	EndedAt             *time.Time               `json:"endedAt,omitempty"`
	Info                Info                     `json:"info"`
	BrowserVersion      json.RawMessage          `json:"browserVersion,omitempty"`
	CommandLine         []string                 `json:"commandLine,omitempty"`
	NativeDescriptor    *host.ActiveSocketRecord `json:"nativeDescriptor,omitempty"`
	NativeCreationTime  uint64                   `json:"nativeCreationTime,omitempty"`
	Binding             json.RawMessage          `json:"binding,omitempty"`
	BrowserClose        *acknowledgement         `json:"browserClose,omitempty"`
	BrowserExit         *exitReceipt             `json:"browserExit,omitempty"`
	NativeExit          *exitReceipt             `json:"nativeExit,omitempty"`
	JobEmpty            *acknowledgement         `json:"jobEmpty,omitempty"`
	Forced              bool                     `json:"forced"`
	ForceReason         string                   `json:"forceReason,omitempty"`
	RegistrationCleanup *acknowledgement         `json:"registrationCleanup,omitempty"`
	EndpointCleanup     *acknowledgement         `json:"endpointCleanup,omitempty"`
	Error               string                   `json:"error,omitempty"`
}

type Session struct {
	info                    Info
	record                  lifecycle
	process                 *platformProcess
	native                  *platformNativeProcess
	browser                 *browserConnection
	registration, lock      io.Closer
	endpointDir             string
	browserDone, nativeDone chan struct{}
	browserExit, nativeExit exitReceipt
	done                    chan struct{}
	closeOnce               sync.Once
	closeErr                error
}

func (s *Session) Info() Info            { return s.info }
func (s *Session) Done() <-chan struct{} { return s.done }

// Start's context governs setup only. A ready session has its own lifetime and
// must be explicitly closed; expiration of the startup budget does not kill it.
func Start(parent context.Context, config Config) (_ *Session, err error) {
	if config.StartupTimeout == 0 {
		config.StartupTimeout = 45 * time.Second
	}
	ctx, cancel := context.WithTimeout(parent, config.StartupTimeout)
	defer cancel()
	if err := contextError(ctx); err != nil {
		return nil, err
	}
	config, err = validateConfig(config)
	if err != nil {
		return nil, err
	}
	if err := ownDirectory(config.Root, ".managed-root.json", "open-browser-use-managed-v1"); err != nil {
		return nil, err
	}
	nameDir := filepath.Join(config.Root, config.Name)
	if err := ownDirectory(nameDir, ".managed-name.json", config.Name); err != nil {
		return nil, err
	}
	if err := contextError(ctx); err != nil {
		return nil, err
	}
	lock, err := platformLock(nameDir)
	if err != nil {
		return nil, err
	}
	s := &Session{lock: lock, done: make(chan struct{}), browserDone: make(chan struct{}), nativeDone: make(chan struct{})}
	s.record = lifecycle{Version: 1, State: "starting", StartedAt: time.Now().UTC()}
	defer func() {
		if err == nil {
			return
		}
		s.record.Error = err.Error()
		cleanup, finish := context.WithTimeout(context.Background(), 30*time.Second)
		defer finish()
		err = errors.Join(err, s.Close(cleanup))
	}()
	id, err := randomID()
	if err != nil {
		return nil, err
	}
	s.info = Info{Name: config.Name, RunID: id, RunDir: filepath.Join(nameDir, "runs", id), ProfileDir: filepath.Join(nameDir, "profile"), NativeHostName: "com.openbrowseruse.managed.n" + id}
	if err := ownDirectory(s.info.ProfileDir, ".managed-profile.json", config.Name); err != nil {
		return nil, err
	}
	if err := contextError(ctx); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(s.info.RunDir), 0o700); err != nil {
		return nil, err
	}
	if err := os.Mkdir(s.info.RunDir, 0o700); err != nil {
		return nil, err
	}
	if err := platformProtectDirectory(s.info.RunDir); err != nil {
		return nil, err
	}
	s.record.Info = s.info
	if err := s.save(); err != nil {
		return nil, err
	}
	if err := contextError(ctx); err != nil {
		return nil, err
	}
	extension := filepath.Join(s.info.RunDir, "extension")
	s.info.ExtensionID, err = stageExtension(ctx, config.ExtensionDir, extension, config.ExtensionPublicKey, s.info.NativeHostName)
	if err != nil {
		return nil, err
	}
	nativeExe := filepath.Join(s.info.RunDir, "native-host.exe")
	if err := copyRegular(ctx, config.HostPath, nativeExe); err != nil {
		return nil, err
	}
	manifest := map[string]any{"name": s.info.NativeHostName, "description": "Open Browser Use isolated session", "path": nativeExe, "type": "stdio", "allowed_origins": []string{"chrome-extension://" + s.info.ExtensionID + "/"}}
	manifestPath := filepath.Join(s.info.RunDir, "native-host.json")
	if err := writeJSONFile(manifestPath, manifest); err != nil {
		return nil, err
	}
	env, err := privateEnvironment(s.info.RunDir)
	if err != nil {
		return nil, err
	}
	s.endpointDir = filepath.Join(s.info.RunDir, "temp", "open-browser-use")
	if err := contextError(ctx); err != nil {
		return nil, err
	}
	s.registration, err = platformRegister(s.info.NativeHostName, manifestPath, id)
	if err != nil {
		return nil, err
	}
	// Only the locked, owned profile may contain a previous endpoint file. It
	// cannot identify the next run, even if the same ephemeral port is reused.
	portFile := filepath.Join(s.info.ProfileDir, "DevToolsActivePort")
	if err := platformValidatePath(portFile); err != nil {
		return nil, err
	}
	if err := os.Remove(portFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	args := browserArguments(s.info.ProfileDir, extension, filepath.Join(s.info.RunDir, "chrome.log"))
	if err := contextError(ctx); err != nil {
		return nil, err
	}
	s.process, err = platformStart(config.BrowserPath, args, env, filepath.Join(s.info.RunDir, "browser.log"))
	if err != nil {
		return nil, err
	}
	s.info.BrowserPID = s.process.PID()
	go func() {
		waitErr := s.process.Wait()
		code, codeErr := s.process.ExitCode()
		s.browserExit = processReceipt(code, codeErr, waitErr)
		close(s.browserDone)
	}()
	var cdpURL string
	if err := s.waitStartup(ctx, func() (bool, error) {
		data, err := readSmallFile(portFile, 4096)
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		// Chromium writes this small file directly. An incomplete publication
		// is still startup, bounded by the same deadline, not a fresh attempt.
		if len(strings.Split(strings.TrimSpace(string(data)), "\n")) < 2 {
			return false, nil
		}
		cdpURL, err = browserEndpoint(data)
		return err == nil, err
	}); err != nil {
		return nil, fmt.Errorf("managed Browser startup: %w", err)
	}
	s.browser, err = connectBrowser(ctx, cdpURL)
	if err != nil {
		return nil, err
	}
	if err := s.browser.call(ctx, "Browser.getVersion", map[string]any{}, &s.record.BrowserVersion); err != nil {
		return nil, err
	}
	var version struct{ Product, ProtocolVersion, Revision string }
	if json.Unmarshal(s.record.BrowserVersion, &version) != nil || !strings.HasPrefix(version.Product, "Chrome/") || version.ProtocolVersion == "" || version.Revision == "" {
		return nil, errors.New("managed Browser returned an incomplete Chromium identity")
	}
	var commandLine struct {
		Arguments []string `json:"arguments"`
	}
	if err := s.browser.call(ctx, "Browser.getBrowserCommandLine", map[string]any{}, &commandLine); err != nil {
		return nil, err
	}
	if err := validateBrowserArguments(commandLine.Arguments, args); err != nil {
		return nil, err
	}
	s.record.CommandLine = commandLine.Arguments
	var descriptor host.ActiveSocketRecord
	if err := s.waitStartup(ctx, func() (bool, error) {
		data, err := readSmallFile(filepath.Join(s.endpointDir, "active.json"), 4096)
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if err := json.Unmarshal(data, &descriptor); err != nil {
			return false, err
		}
		if !transport.IsNamedPipe(descriptor.SocketPath) || descriptor.PID <= 0 || descriptor.StartedAt.IsZero() {
			return false, errors.New("invalid private native endpoint descriptor")
		}
		return true, nil
	}); err != nil {
		return nil, fmt.Errorf("managed native startup: %w", err)
	}
	s.native, err = s.process.NativeHost(descriptor.PID, nativeExe)
	if err != nil {
		return nil, err
	}
	s.info.NativePID, s.info.SocketPath = descriptor.PID, descriptor.SocketPath
	s.record.NativeDescriptor = &descriptor
	s.record.NativeCreationTime = s.native.CreationTime()
	go func() {
		waitErr := s.native.Wait(context.Background())
		code, codeErr := s.native.ExitCode()
		s.nativeExit = processReceipt(code, codeErr, waitErr)
		close(s.nativeDone)
	}()
	var backend struct {
		Type     string `json:"type"`
		Metadata struct {
			ExtensionID         string `json:"extensionId"`
			ExtensionInstanceID string `json:"extensionInstanceId"`
			NativeHostName      string `json:"nativeHostName"`
		} `json:"metadata"`
	}
	if err := nativeCall(ctx, s.info.SocketPath, "getInfo", map[string]any{}, &backend); err != nil {
		return nil, err
	}
	if backend.Type != "extension" || backend.Metadata.ExtensionID != s.info.ExtensionID || backend.Metadata.NativeHostName != s.info.NativeHostName || backend.Metadata.ExtensionInstanceID == "" {
		return nil, errors.New("managed native endpoint has an unexpected extension identity")
	}
	s.info.ExtensionInstanceID = backend.Metadata.ExtensionInstanceID
	deadline, _ := ctx.Deadline()
	remaining := time.Until(deadline).Milliseconds()
	if remaining < 1 {
		return nil, context.DeadlineExceeded
	}
	if err := nativeCall(ctx, s.info.SocketPath, "host.bindBrowser", map[string]any{"cdpURL": cdpURL, "exclusive": true, "timeoutMs": remaining}, &s.record.Binding); err != nil {
		return nil, err
	}
	if err := validateBinding(s.record.Binding, s.info); err != nil {
		return nil, err
	}
	if err := s.checkStartup(ctx); err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	s.record.State, s.record.ReadyAt, s.record.Info = "ready", &now, s.info
	if err := s.save(); err != nil {
		return nil, err
	}
	if err := s.checkStartup(ctx); err != nil {
		return nil, err
	}
	go func() {
		select {
		case <-s.browserDone:
		case <-s.nativeDone:
		case <-s.done:
			return
		}
		s.beginClose()
	}()
	return s, nil
}

func browserArguments(profile, extension, log string) []string {
	return []string{"--headless=new", "--enable-automation", "--user-data-dir=" + profile, "--remote-debugging-port=0", "--disable-extensions-except=" + extension, "--load-extension=" + extension, "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-networking", "--site-per-process", "--disable-field-trial-config", "--enable-logging", "--log-file=" + log, "about:blank"}
}

func validateBrowserArguments(actual, wanted []string) error {
	for _, value := range actual {
		if value == "--no-sandbox" || strings.HasPrefix(value, "--no-sandbox=") || value == "--disable-setuid-sandbox" {
			return errors.New("managed browser disabled its sandbox")
		}
	}
	for _, value := range wanted {
		if !strings.HasPrefix(value, "--") {
			continue
		}
		key, _, _ := strings.Cut(value, "=")
		count := 0
		for _, candidate := range actual {
			candidateKey, _, _ := strings.Cut(candidate, "=")
			if candidateKey == key {
				count++
				if candidate != value {
					return fmt.Errorf("managed Browser changed %s", key)
				}
			}
		}
		if count != 1 {
			return fmt.Errorf("managed Browser did not preserve exactly one %s", key)
		}
	}
	return nil
}

func validateBinding(data []byte, info Info) error {
	var result struct {
		Bound, Exclusive    bool
		Behavior            string
		ExtensionID         string `json:"extensionId"`
		ExtensionInstanceID string `json:"extensionInstanceId"`
		Generation          string
		WorkerBootID        string `json:"workerBootId"`
		PortID              string `json:"portId"`
	}
	if json.Unmarshal(data, &result) != nil || !result.Bound || !result.Exclusive || result.Behavior != "default" || result.ExtensionID != info.ExtensionID || result.ExtensionInstanceID != info.ExtensionInstanceID || result.Generation == "" || result.WorkerBootID == "" || result.PortID == "" {
		return errors.New("managed native Browser binding identity mismatch")
	}
	return nil
}

func (s *Session) checkStartup(ctx context.Context) error {
	if err := contextError(ctx); err != nil {
		return err
	}
	select {
	case <-s.browserDone:
		return fmt.Errorf("managed browser exited during startup: %+v", s.browserExit)
	default:
	}
	select {
	case <-s.nativeDone:
		return fmt.Errorf("managed native host exited during startup: %+v", s.nativeExit)
	default:
	}
	return nil
}

func (s *Session) waitStartup(ctx context.Context, check func() (bool, error)) error {
	for {
		if err := s.checkStartup(ctx); err != nil {
			return err
		}
		ready, err := check()
		if err != nil {
			return err
		}
		if ready {
			return s.checkStartup(ctx)
		}
		timer := time.NewTimer(30 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-s.browserDone:
			timer.Stop()
		case <-timer.C:
		}
	}
}

// Close callers share the original cleanup. Their timeout only bounds their
// wait: the profile lock remains held until the owned Job has actually emptied.
func (s *Session) Close(ctx context.Context) error {
	s.beginClose()
	select {
	case <-s.done:
		return s.closeErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Session) beginClose() { s.closeOnce.Do(func() { go s.shutdown() }) }

func (s *Session) shutdown() {
	var failures []error
	s.record.State = "closing"
	s.record.Info = s.info
	if s.info.RunDir != "" {
		if err := s.save(); err != nil {
			failures = append(failures, err)
		}
	}
	if s.process != nil {
		grace, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if s.browser != nil {
			var response json.RawMessage
			err := s.browser.call(grace, "Browser.close", map[string]any{}, &response)
			s.record.BrowserClose = receipt(response, err)
			if err != nil {
				failures = append(failures, fmt.Errorf("managed Browser.close was not acknowledged: %w", err))
			}
		}
		// WaitTree uses the live Job accounting, not a process-name scan or a
		// PID file. Natural EOF and forced termination remain distinguishable.
		err := s.process.WaitTree(grace)
		cancel()
		if err != nil {
			s.record.Forced, s.record.ForceReason = true, err.Error()
			failures = append(failures, fmt.Errorf("managed browser required forced termination: %w", err))
			if err := s.process.Terminate(); err != nil {
				failures = append(failures, err)
			}
			// Even if termination failed, never release a profile still in use.
			if err := s.process.WaitTree(context.Background()); err != nil {
				failures = append(failures, err)
				s.closeErr = errors.Join(failures...)
				s.record.Error = s.closeErr.Error()
				_ = s.save()
				return
			}
		}
		s.record.JobEmpty = receipt(json.RawMessage(`{"activeProcesses":0}`), nil)
		<-s.browserDone
		s.record.BrowserExit = &s.browserExit
		if s.browserExit.Error != "" {
			failures = append(failures, errors.New(s.browserExit.Error))
		}
		if s.native != nil {
			<-s.nativeDone
			s.record.NativeExit = &s.nativeExit
			if s.nativeExit.Error != "" {
				failures = append(failures, errors.New(s.nativeExit.Error))
			}
			if err := s.native.Close(); err != nil {
				failures = append(failures, err)
			}
		}
		if s.browser != nil {
			_ = s.browser.close()
		}
		if err := s.process.Close(); err != nil {
			failures = append(failures, err)
		}
	}
	if s.registration != nil {
		err := s.registration.Close()
		s.record.RegistrationCleanup = receipt(nil, err)
		if err != nil {
			failures = append(failures, err)
		}
	}
	if s.endpointDir != "" {
		err := s.cleanEndpointRecords()
		s.record.EndpointCleanup = receipt(nil, err)
		if err != nil {
			failures = append(failures, err)
		}
	}
	if s.lock != nil {
		if err := s.lock.Close(); err != nil {
			failures = append(failures, err)
		}
	}
	s.closeErr = errors.Join(failures...)
	if s.closeErr != nil {
		if s.record.Error == "" {
			s.record.Error = s.closeErr.Error()
		} else {
			s.record.Error += "\n" + s.closeErr.Error()
		}
	}
	now := time.Now().UTC()
	s.record.EndedAt, s.record.State = &now, "closed"
	if s.info.RunDir != "" {
		s.closeErr = errors.Join(s.closeErr, s.save())
	}
	close(s.done)
}

func (s *Session) cleanEndpointRecords() error {
	// The host normally removes both files during EOF shutdown. After the Job
	// empties, only records matching our held original identity may be removed.
	entries, err := os.ReadDir(s.endpointDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() != "active.json" && !strings.HasSuffix(entry.Name(), host.EndpointRecordSuffix) {
			return errors.New("managed native endpoint directory contains unknown entries")
		}
		data, err := readSmallFile(filepath.Join(s.endpointDir, entry.Name()), 4096)
		if err != nil {
			return err
		}
		var record host.ActiveSocketRecord
		if json.Unmarshal(data, &record) != nil || s.info.SocketPath == "" || record.SocketPath != s.info.SocketPath || record.PID != s.info.NativePID {
			return errors.New("managed native cleanup found a foreign endpoint record")
		}
		if err := os.Remove(filepath.Join(s.endpointDir, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

func processReceipt(code uint32, codeErr, waitErr error) exitReceipt {
	result := exitReceipt{At: time.Now().UTC()}
	if codeErr == nil {
		result.Code = &code
	}
	if err := errors.Join(codeErr, waitErr); err != nil {
		result.Error = err.Error()
	}
	return result
}

func receipt(result json.RawMessage, err error) *acknowledgement {
	value := &acknowledgement{At: time.Now().UTC(), Result: result}
	if err != nil {
		value.Error = err.Error()
	}
	return value
}

func (s *Session) save() error {
	return writeJSONFile(filepath.Join(s.info.RunDir, "lifecycle.json"), s.record)
}

func writeJSONFile(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".managed-write-*")
	if err != nil {
		return err
	}
	name := temp.Name()
	defer os.Remove(name)
	_, writeErr := temp.Write(append(data, '\n'))
	if err := errors.Join(writeErr, temp.Close()); err != nil {
		return err
	}
	return os.Rename(name, path)
}

func readSmallFile(path string, limit int64) ([]byte, error) {
	if err := platformValidatePath(path); err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, errors.New("managed record is not a bounded regular file")
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("managed record exceeded its read limit")
	}
	return data, nil
}
