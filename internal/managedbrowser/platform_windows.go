//go:build windows

package managedbrowser

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	procThreadAttributeJobList = 0x0002000d
	nativeRegistryParent       = `Software\Google\Chrome\NativeMessagingHosts`
	nativeOwnerValue           = "OpenBrowserUseManagedOwner"
)

var (
	managedNativeName = regexp.MustCompile(`^com\.openbrowseruse\.managed\.n[0-9a-f]{32}$`)
	managedOwner      = regexp.MustCompile(`^[0-9a-f]{32}$`)
	managedKernel     = windows.NewLazySystemDLL("kernel32.dll")
	isProcessInJob    = managedKernel.NewProc("IsProcessInJob")
	deleteRegistryKey = windows.NewLazySystemDLL("advapi32.dll").NewProc("RegDeleteKeyExW")
)

func platformSharingViolation(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION)
}

// Only ordinary absolute local paths are accepted. Check every existing ancestor,
// including junctions (which os.ModeSymlink alone does not consistently describe).
func platformValidatePath(path string) error {
	path = strings.ReplaceAll(path, "/", `\`)
	if len(path) < 3 || path[1] != ':' || path[2] != '\\' || !((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) {
		return errors.New("expected an absolute local drive path, without device or UNC prefixes")
	}
	parts := strings.Split(path[3:], `\`)
	current := path[:3]
	missing := false
	for i, part := range append([]string{""}, parts...) {
		if i > 0 {
			if part == "" && i == len(parts) {
				continue
			}
			if part == "" || part == "." || part == ".." || strings.TrimRight(part, " .") != part || strings.ContainsAny(part, `<>:"|?*`) {
				return errors.New("path contains a noncanonical or reserved Windows component")
			}
			for _, c := range part {
				if c < 32 {
					return errors.New("path contains a control character")
				}
			}
			base, _, _ := strings.Cut(part, ".")
			upper := strings.ToUpper(base)
			if reservedName(base) || upper == "CONIN$" || upper == "CONOUT$" || upper == "CLOCK$" || ((strings.HasPrefix(upper, "COM") || strings.HasPrefix(upper, "LPT")) && strings.ContainsAny(strings.TrimPrefix(strings.TrimPrefix(upper, "COM"), "LPT"), "¹²³")) {
				return errors.New("path contains a reserved Windows device name")
			}
			current = filepath.Join(current, part)
		}
		if missing {
			continue
		}
		name, err := windows.UTF16PtrFromString(current)
		if err != nil {
			return err
		}
		attributes, err := windows.GetFileAttributes(name)
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			missing = true
			continue
		}
		if err != nil {
			return err
		}
		if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return fmt.Errorf("managed paths cannot cross reparse points: %s", current)
		}
		if i < len(parts) && attributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
			return fmt.Errorf("managed path ancestor is not a directory: %s", current)
		}
	}
	return nil
}

// Called only after the session has established ownership of this directory.
// This is an OS-user boundary, not a sandbox against arbitrary same-user code.
func platformProtectDirectory(path string) error {
	if err := platformValidatePath(path); err != nil {
		return err
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(name, windows.READ_CONTROL|windows.WRITE_DAC, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("managed ownership target is not an ordinary directory")
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

type platformProfileLock struct {
	handle windows.Handle
	once   sync.Once
	err    error
}

func platformLock(profileDir string) (io.Closer, error) {
	path := filepath.Join(profileDir, ".managed-profile.lock")
	if err := platformValidatePath(path); err != nil {
		return nil, err
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	// No FILE_SHARE_DELETE: another process cannot replace the locked pathname.
	handle, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	var info windows.ByHandleFileInformation
	err = windows.GetFileInformationByHandle(handle, &info)
	if err == nil && info.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		err = errors.New("managed profile lock is not an ordinary file")
	}
	if err == nil {
		err = windows.LockFileEx(handle, windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &windows.Overlapped{})
	}
	if err != nil {
		return nil, errors.Join(fmt.Errorf("managed profile is unavailable: %w", err), windows.CloseHandle(handle))
	}
	return &platformProfileLock{handle: handle}, nil
}

func (l *platformProfileLock) Close() error {
	l.once.Do(func() {
		l.err = errors.Join(windows.UnlockFileEx(l.handle, 0, 1, 0, &windows.Overlapped{}), windows.CloseHandle(l.handle))
	})
	return l.err
}

type platformRegistration struct {
	name, manifest, owner string
	mu                    sync.Mutex
	closed                bool
}

func platformRegister(name, manifest, owner string) (io.Closer, error) {
	if !managedNativeName.MatchString(name) || !managedOwner.MatchString(owner) || !strings.HasSuffix(name, ".n"+owner) {
		return nil, errors.New("invalid isolated native host ownership")
	}
	if err := platformValidatePath(manifest); err != nil {
		return nil, err
	}
	info, err := os.Stat(manifest)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("native manifest is not a regular file")
	}
	r := &platformRegistration{name: name, manifest: manifest, owner: owner}
	for index, view := range []uint32{registry.WOW64_32KEY, registry.WOW64_64KEY} {
		key, existed, err := registry.CreateKey(registry.CURRENT_USER, nativeRegistryParent+`\`+name, registry.READ|registry.WRITE|view)
		if err != nil {
			return nil, r.startupFailure(err)
		}
		if existed {
			// On Windows these views may alias. Only the tuple just written by
			// this call may be reused; an existing first-view key is never adopted.
			if index == 0 {
				err = errors.New("isolated native host registration already exists")
			} else {
				err = r.verify(key)
			}
		} else {
			err = key.SetStringValue(nativeOwnerValue, owner)
			if err == nil {
				err = key.SetStringValue("", manifest)
			}
		}
		err = errors.Join(err, key.Close())
		if err != nil {
			if index == 0 && existed {
				return nil, err
			}
			return nil, r.startupFailure(err)
		}
	}
	return r, nil
}

func (r *platformRegistration) startupFailure(cause error) error {
	// A partially written key cannot pass the same ownership proof as a ready
	// registration. Preserve it and surface its exact name if cleanup is denied;
	// deleting an unknown or incomplete key is never a fallback for write failure.
	if cleanupErr := r.Close(); cleanupErr != nil {
		return fmt.Errorf("isolated native registration %s failed; cleanup is unconfirmed and the key was preserved: %w", r.name, errors.Join(cause, cleanupErr))
	}
	return cause
}

func (r *platformRegistration) verify(key registry.Key) error {
	info, err := key.Stat()
	if err != nil {
		return err
	}
	if info.SubKeyCount != 0 || info.ValueCount != 2 {
		return errors.New("isolated native registration contains unexpected entries")
	}
	for name, want := range map[string]string{"": r.manifest, nativeOwnerValue: r.owner} {
		got, kind, err := key.GetStringValue(name)
		if err != nil {
			return err
		}
		if kind != registry.SZ || got != want {
			return errors.New("isolated native registration ownership changed")
		}
	}
	return nil
}

func (r *platformRegistration) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil
	}
	// Validate both views before removing either. Never recursively delete or
	// remove a changed value, extra value, child key, or production registration.
	for _, view := range []uint32{registry.WOW64_32KEY, registry.WOW64_64KEY} {
		key, err := registry.OpenKey(registry.CURRENT_USER, nativeRegistryParent+`\`+r.name, registry.READ|view)
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			continue
		}
		if err != nil {
			return err
		}
		err = errors.Join(r.verify(key), key.Close())
		if err != nil {
			return err
		}
	}
	name, _ := windows.UTF16PtrFromString(nativeRegistryParent + `\` + r.name)
	for _, view := range []uint32{registry.WOW64_32KEY, registry.WOW64_64KEY} {
		code, _, _ := deleteRegistryKey.Call(uintptr(registry.CURRENT_USER), uintptr(unsafe.Pointer(name)), uintptr(view), 0)
		if code != 0 && code != uintptr(windows.ERROR_FILE_NOT_FOUND) {
			return windows.Errno(code)
		}
	}
	r.closed = true
	return nil
}

type platformProcess struct {
	pid          int
	created      uint64
	process, job windows.Handle
	done         chan struct{}
	waitErr      error
	exitCode     uint32
	exitReadErr  error
	mu           sync.Mutex
	closeOnce    sync.Once
	closeErr     error
}

// Assignment happens inside CreateProcess, before child code runs. Unlike a
// suspended-create/AssignProcessToJobObject sequence, supervisor death cannot
// leave a newly created process outside the kill-on-close job.
func platformStart(executable string, args, env []string, logPath string) (*platformProcess, error) {
	return platformStartWithVisibility(executable, args, env, logPath, false)
}

// visible is reserved for the explicit human setup command. Job membership,
// inherited handles and Ctrl+C isolation are identical in both launch modes.
func platformStartWithVisibility(executable string, args, env []string, logPath string, visible bool) (*platformProcess, error) {
	for _, path := range []string{executable, logPath} {
		if err := platformValidatePath(path); err != nil {
			return nil, err
		}
	}
	environment, err := platformEnvironment(env)
	if err != nil {
		return nil, err
	}
	application, err := windows.UTF16PtrFromString(executable)
	if err != nil {
		return nil, err
	}
	command, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(append([]string{executable}, args...)))
	if err != nil {
		return nil, err
	}
	currentDir, err := windows.UTF16PtrFromString(filepath.Dir(logPath))
	if err != nil {
		return nil, err
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	keepJob := false
	defer func() {
		if !keepJob {
			windows.CloseHandle(job)
		}
	}()
	if err := windows.SetHandleInformation(job, windows.HANDLE_FLAG_INHERIT, 0); err != nil {
		return nil, err
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return nil, err
	}
	var log *os.File
	if visible {
		// Human setup may visit login callbacks containing credentials. Its
		// stdout/stderr are not retained; readiness uses DevToolsActivePort.
		log, err = os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	} else {
		log, err = os.OpenFile(logPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	}
	if err != nil {
		return nil, err
	}
	defer log.Close()
	null, err := os.Open(os.DevNull)
	if err != nil {
		return nil, err
	}
	defer null.Close()
	var inherited [2]windows.Handle
	for i, file := range []*os.File{null, log} {
		if err := windows.DuplicateHandle(windows.CurrentProcess(), windows.Handle(file.Fd()), windows.CurrentProcess(), &inherited[i], 0, true, windows.DUPLICATE_SAME_ACCESS); err != nil {
			return nil, err
		}
		defer windows.CloseHandle(inherited[i])
	}
	attributes, err := windows.NewProcThreadAttributeList(2)
	if err != nil {
		return nil, err
	}
	defer attributes.Delete()
	if err := attributes.Update(procThreadAttributeJobList, unsafe.Pointer(&job), unsafe.Sizeof(job)); err != nil {
		return nil, fmt.Errorf("atomic job assignment requires Windows 10 or newer: %w", err)
	}
	if err := attributes.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, unsafe.Pointer(&inherited[0]), unsafe.Sizeof(inherited)); err != nil {
		return nil, err
	}
	startup := windows.StartupInfoEx{}
	startup.Cb = uint32(unsafe.Sizeof(startup))
	startup.Flags = windows.STARTF_USESTDHANDLES | windows.STARTF_USESHOWWINDOW
	startup.ShowWindow = windows.SW_HIDE
	if visible {
		startup.ShowWindow = windows.SW_SHOWNORMAL
	}
	startup.StdInput, startup.StdOutput, startup.StdErr = inherited[0], inherited[1], inherited[1]
	startup.ProcThreadAttributeList = attributes.List()
	var information windows.ProcessInformation
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT | windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW)
	err = windows.CreateProcess(application, command, nil, nil, true, flags, &environment[0], currentDir, &startup.StartupInfo, &information)
	runtime.KeepAlive(attributes)
	runtime.KeepAlive(inherited)
	runtime.KeepAlive(environment)
	if err != nil {
		return nil, err
	}
	p := &platformProcess{pid: int(information.ProcessId), process: information.Process, job: job, done: make(chan struct{})}
	keepJob = true
	go func() {
		_, p.waitErr = windows.WaitForSingleObject(p.process, windows.INFINITE)
		if p.waitErr == nil {
			p.exitReadErr = windows.GetExitCodeProcess(p.process, &p.exitCode)
			p.waitErr = p.exitReadErr
			if p.waitErr == nil && p.exitCode != 0 {
				p.waitErr = &platformExitError{Code: p.exitCode}
			}
		}
		close(p.done)
	}()
	threadErr := windows.CloseHandle(information.Thread)
	p.created, err = processCreation(p.process)
	if err == nil {
		err = processInJob(p.process, p.job)
	}
	if err = errors.Join(threadErr, err); err != nil {
		return nil, errors.Join(err, p.Close())
	}
	return p, nil
}

func platformEnvironment(env []string) ([]uint16, error) {
	values := make(map[string]string)
	for _, value := range env {
		if strings.ContainsRune(value, 0) {
			return nil, errors.New("environment contains NUL")
		}
		start := 0
		if strings.HasPrefix(value, "=") {
			start = 1
		} // Windows per-drive cwd entry.
		index := strings.IndexByte(value[start:], '=') + start
		if index < start || index == 0 {
			return nil, errors.New("invalid environment entry")
		}
		values[strings.ToUpper(value[:index])] = value
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	// Windows orders the case-insensitive names by UTF-16 code units, not by
	// UTF-8 bytes (the two differ for supplementary Unicode characters).
	sort.Slice(keys, func(i, j int) bool {
		a, b := utf16.Encode([]rune(keys[i])), utf16.Encode([]rune(keys[j]))
		for n := 0; n < len(a) && n < len(b); n++ {
			if a[n] != b[n] {
				return a[n] < b[n]
			}
		}
		return len(a) < len(b)
	})
	var block []uint16
	for _, key := range keys {
		block = append(block, utf16.Encode([]rune(values[key]))...)
		block = append(block, 0)
	}
	block = append(block, 0)
	if len(block) == 1 {
		block = append(block, 0)
	}
	return block, nil
}

func (p *platformProcess) PID() int    { return p.pid }
func (p *platformProcess) Wait() error { <-p.done; return p.waitErr }
func (p *platformProcess) ExitCode() (uint32, error) {
	select {
	case <-p.done:
		var exit *platformExitError
		if p.waitErr != nil && !errors.As(p.waitErr, &exit) {
			return 0, p.waitErr
		}
		return p.exitCode, p.exitReadErr
	default:
		return 0, errors.New("managed process has not exited")
	}
}

type jobAccounting struct {
	TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime int64
	TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses     uint32
}

func (p *platformProcess) activeProcesses() (uint32, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.job == 0 {
		return 0, errors.New("managed job handle is closed")
	}
	var accounting jobAccounting
	err := windows.QueryInformationJobObject(p.job, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&accounting)), uint32(unsafe.Sizeof(accounting)), nil)
	return accounting.ActiveProcesses, err
}

func (p *platformProcess) WaitTree(ctx context.Context) error {
	for {
		active, err := p.activeProcesses()
		if err != nil {
			return err
		}
		if active == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func (p *platformProcess) Terminate() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.job == 0 {
		return errors.New("managed job handle is closed")
	}
	return windows.TerminateJobObject(p.job, 1)
}

func (p *platformProcess) Close() error {
	p.closeOnce.Do(func() {
		active, err := p.activeProcesses()
		p.closeErr = err
		if err != nil || active != 0 {
			p.closeErr = errors.Join(p.closeErr, p.Terminate())
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		p.closeErr = errors.Join(p.closeErr, p.WaitTree(ctx))
		p.mu.Lock()
		p.closeErr = errors.Join(p.closeErr, windows.CloseHandle(p.job))
		p.job = 0
		p.mu.Unlock()
		select {
		case <-p.done:
			p.closeErr = errors.Join(p.closeErr, windows.CloseHandle(p.process))
		case <-ctx.Done():
			p.closeErr = errors.Join(p.closeErr, errors.New("managed original process wait did not settle before closing deadline"))
		}
	})
	return p.closeErr
}

func processCreation(handle windows.Handle) (uint64, error) {
	var creation, exit, kernel, user windows.Filetime
	err := windows.GetProcessTimes(handle, &creation, &exit, &kernel, &user)
	return uint64(creation.HighDateTime)<<32 | uint64(creation.LowDateTime), err
}

func processInJob(process, job windows.Handle) error {
	var member int32
	ok, _, err := isProcessInJob.Call(uintptr(process), uintptr(job), uintptr(unsafe.Pointer(&member)))
	if ok == 0 {
		return err
	}
	if member == 0 {
		return errors.New("native process is not in this managed browser job")
	}
	return nil
}

type platformNativeProcess struct {
	mu      sync.Mutex
	handle  windows.Handle
	created uint64
	code    uint32
	exited  bool
}

func (p *platformProcess) NativeHost(pid int, executable string) (*platformNativeProcess, error) {
	if pid <= 0 || uint64(pid) > uint64(^uint32(0)) {
		return nil, errors.New("invalid native process ID")
	}
	if err := platformValidatePath(executable); err != nil {
		return nil, err
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return nil, err
	}
	failed := true
	defer func() {
		if failed {
			windows.CloseHandle(handle)
		}
	}()
	p.mu.Lock()
	if p.job == 0 {
		err = errors.New("managed job handle is closed")
	} else {
		err = processInJob(handle, p.job)
	}
	p.mu.Unlock()
	if err != nil {
		return nil, err
	}
	var path [32768]uint16
	length := uint32(len(path))
	if err := windows.QueryFullProcessImageName(handle, 0, &path[0], &length); err != nil {
		return nil, err
	}
	if !strings.EqualFold(filepath.Clean(windows.UTF16ToString(path[:length])), filepath.Clean(executable)) {
		return nil, errors.New("native executable does not match this managed session")
	}
	creation, err := processCreation(handle)
	if err != nil {
		return nil, err
	}
	if creation < p.created {
		return nil, errors.New("native process predates the managed browser")
	}
	status, err := windows.WaitForSingleObject(handle, 0)
	if err != nil {
		return nil, err
	}
	if status != uint32(windows.WAIT_TIMEOUT) {
		return nil, errors.New("native process has already exited")
	}
	failed = false
	return &platformNativeProcess{handle: handle, created: creation}, nil
}

func (p *platformProcess) JobContains(pid int, executable string) error {
	host, err := p.NativeHost(pid, executable)
	if err != nil {
		return err
	}
	return host.Close()
}

func (p *platformNativeProcess) CreationTime() uint64 { return p.created }
func (p *platformNativeProcess) ExitCode() (uint32, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.exited {
		return p.code, nil
	}
	if p.handle == 0 {
		return 0, errors.New("native process handle is closed")
	}
	status, err := windows.WaitForSingleObject(p.handle, 0)
	if err != nil {
		return 0, err
	}
	if status != windows.WAIT_OBJECT_0 {
		return 0, errors.New("native process has not exited")
	}
	if err := windows.GetExitCodeProcess(p.handle, &p.code); err != nil {
		return 0, err
	}
	p.exited = true
	return p.code, nil
}

func (p *platformNativeProcess) Wait(ctx context.Context) error {
	for {
		p.mu.Lock()
		if p.handle == 0 && !p.exited {
			p.mu.Unlock()
			return errors.New("native process handle is closed")
		}
		status, err := uint32(windows.WAIT_OBJECT_0), error(nil)
		if !p.exited {
			status, err = windows.WaitForSingleObject(p.handle, 0)
		}
		p.mu.Unlock()
		if err != nil {
			return err
		}
		if status == windows.WAIT_OBJECT_0 {
			code, err := p.ExitCode()
			if err != nil {
				return err
			}
			if code != 0 {
				return &platformExitError{Code: code}
			}
			return nil
		}
		if status != uint32(windows.WAIT_TIMEOUT) {
			return fmt.Errorf("unexpected native process wait result: %d", status)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func (p *platformNativeProcess) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == 0 {
		return nil
	}
	err := windows.CloseHandle(p.handle)
	if err == nil {
		p.handle = 0
	}
	return err
}
