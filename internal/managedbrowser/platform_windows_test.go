//go:build windows

package managedbrowser

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const platformHelperEnvironment = "OBU_MANAGED_PLATFORM_TEST_HELPER"

func helperArguments(mode, dir string, extra ...string) []string {
	return append([]string{"-test.run=^TestManagedPlatformHelper$", "--", mode, dir}, extra...)
}

// Each subprocess is this test executable, never a browser or a daily profile.
func TestManagedPlatformHelper(t *testing.T) {
	if os.Getenv(platformHelperEnvironment) != "1" {
		return
	}
	var args []string
	for index, arg := range os.Args {
		if arg == "--" {
			args = os.Args[index+1:]
			break
		}
	}
	if len(args) < 2 {
		os.Exit(90)
	}
	mode, dir := args[0], args[1]
	write := func(name string, value any) {
		data, err := json.Marshal(value)
		if err == nil {
			err = os.WriteFile(filepath.Join(dir, name), data, 0o600)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(91)
		}
	}
	wait := func(name string) {
		deadline := time.Now().Add(60 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		os.Exit(92)
	}
	switch mode {
	case "leaf":
		write("leaf.json", map[string]any{"pid": os.Getpid()})
		wait("release-leaf")
	case "tree":
		self, _ := os.Executable()
		child := exec.Command(self, helperArguments("leaf", dir)...)
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		child.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if err := child.Start(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(93)
		}
		write("tree.json", map[string]any{"pid": os.Getpid(), "leafPID": child.Process.Pid})
		wait("release-root")
		// Deliberately exit while the child is live. The supervisor must still
		// account for the original child through its job, not the root PID.
	case "supervisor":
		self, _ := os.Executable()
		process, err := platformStart(self, helperArguments("tree", dir), os.Environ(), filepath.Join(dir, "tree.log"))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(94)
		}
		write("supervisor.json", map[string]any{"rootPID": process.PID()})
		wait("release-supervisor")
		if err := process.Close(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(95)
		}
	case "lock":
		lock, err := platformLock(dir)
		if err == nil {
			err = lock.Close()
		}
		write("lock-result.json", map[string]any{"locked": err == nil})
	case "environment":
		write("environment.json", map[string]any{"value": os.Getenv("OBU_PLATFORM_VALUE"), "unicode": os.Getenv("OBU_PLATFORM_UNICODE"), "args": args[2:]})
	case "exit":
		code, _ := strconv.Atoi(args[2])
		os.Exit(code)
	default:
		os.Exit(96)
	}
	os.Exit(0)
}

func platformTestEnvironment() []string { return append(os.Environ(), platformHelperEnvironment+"=1") }

func awaitPlatformJSON(t *testing.T, path string, result any) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(path)
		if err == nil {
			err = json.Unmarshal(data, result)
		}
		if err == nil {
			return
		}
		last = err
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out reading helper result %s: %v", path, last)
}

func releasePlatformHelper(t *testing.T, dir, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("release"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func startPlatformHelper(t *testing.T, mode, dir string, extra ...string) *platformProcess {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	process, err := platformStart(self, helperArguments(mode, dir, extra...), platformTestEnvironment(), filepath.Join(dir, "process.log"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := process.Close(); err != nil {
			t.Errorf("owned process cleanup: %v", err)
		}
	})
	return process
}

func TestPlatformOriginalProcessAndDescendantLifecycle(t *testing.T) {
	dir := t.TempDir()
	process := startPlatformHelper(t, "tree", dir)
	var tree struct {
		PID     int `json:"pid"`
		LeafPID int `json:"leafPID"`
	}
	awaitPlatformJSON(t, filepath.Join(dir, "tree.json"), &tree)
	var leaf struct {
		PID int `json:"pid"`
	}
	awaitPlatformJSON(t, filepath.Join(dir, "leaf.json"), &leaf)
	if tree.PID != process.PID() || tree.LeafPID != leaf.PID {
		t.Fatal("helper identities do not agree")
	}
	self, _ := os.Executable()
	host, err := process.NativeHost(leaf.PID, self)
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	if host.CreationTime() < process.created {
		t.Fatal("child creation precedes original root")
	}
	if err := process.JobContains(os.Getpid(), self); err == nil {
		t.Fatal("accepted a process outside this job")
	}
	if _, err := process.NativeHost(leaf.PID, filepath.Join(dir, "wrong.exe")); err == nil {
		t.Fatal("accepted a different executable path")
	}
	var flags uint32
	ok, _, callErr := managedKernel.NewProc("GetHandleInformation").Call(uintptr(process.job), uintptr(unsafe.Pointer(&flags)))
	if ok == 0 {
		t.Fatal(callErr)
	}
	if flags&windows.HANDLE_FLAG_INHERIT != 0 {
		t.Fatal("job handle is inheritable")
	}
	var limits windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	if err := windows.QueryInformationJobObject(process.job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits)), nil); err != nil {
		t.Fatal(err)
	}
	if limits.BasicLimitInformation.LimitFlags != windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE {
		t.Fatalf("unexpected job limits: %#x", limits.BasicLimitInformation.LimitFlags)
	}
	releasePlatformHelper(t, dir, "release-root")
	if err := process.Wait(); err != nil {
		t.Fatal(err)
	}
	if code, err := process.ExitCode(); err != nil || code != 0 {
		t.Fatalf("root exit %d: %v", code, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	err = process.WaitTree(ctx)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("living child was not retained: %v", err)
	}
	if _, err := host.ExitCode(); err == nil {
		t.Fatal("reported a live child's exit code")
	}
	releasePlatformHelper(t, dir, "release-leaf")
	ctx, cancel = context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := host.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	if code, err := host.ExitCode(); err != nil || code != 0 {
		t.Fatalf("native exit %d: %v", code, err)
	}
	if err := process.WaitTree(ctx); err != nil {
		t.Fatal(err)
	}
	if err := process.Close(); err != nil {
		t.Fatal(err)
	}
	if code, err := process.ExitCode(); err != nil || code != 0 {
		t.Fatalf("original exit not retained after Close: %d %v", code, err)
	}
}

func TestPlatformTerminateOnlyOwnedJob(t *testing.T) {
	dir := t.TempDir()
	process := startPlatformHelper(t, "tree", dir)
	var leaf struct {
		PID int `json:"pid"`
	}
	awaitPlatformJSON(t, filepath.Join(dir, "leaf.json"), &leaf)
	self, _ := os.Executable()
	host, err := process.NativeHost(leaf.PID, self)
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	if err := process.Terminate(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := process.WaitTree(ctx); err != nil {
		t.Fatal(err)
	}
	if err := process.Wait(); err == nil {
		t.Fatal("forced root exit reported success")
	}
	if err := host.Wait(ctx); err == nil {
		t.Fatal("forced native exit reported success")
	}
	for label, read := range map[string]func() (uint32, error){"root": process.ExitCode, "native": host.ExitCode} {
		if code, err := read(); err != nil || code != 1 {
			t.Fatalf("%s exit %d: %v", label, code, err)
		}
	}
}

func TestPlatformSupervisorDeathKillsOwnedTree(t *testing.T) {
	dir := t.TempDir()
	self, _ := os.Executable()
	command := exec.Command(self, helperArguments("supervisor", dir)...)
	command.Env = platformTestEnvironment()
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := os.Create(filepath.Join(dir, "supervisor.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	command.Stdout, command.Stderr = output, output
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if command.ProcessState == nil {
			command.Process.Kill()
			command.Wait()
		}
	}()
	var supervisor struct {
		RootPID int `json:"rootPID"`
	}
	awaitPlatformJSON(t, filepath.Join(dir, "supervisor.json"), &supervisor)
	var tree struct {
		PID     int `json:"pid"`
		LeafPID int `json:"leafPID"`
	}
	awaitPlatformJSON(t, filepath.Join(dir, "tree.json"), &tree)
	var leaf struct {
		PID int `json:"pid"`
	}
	awaitPlatformJSON(t, filepath.Join(dir, "leaf.json"), &leaf)
	if supervisor.RootPID != tree.PID || tree.LeafPID != leaf.PID {
		t.Fatal("supervisor tree identity mismatch")
	}
	var handles []windows.Handle
	for _, pid := range []int{tree.PID, leaf.PID} {
		handle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
		if err != nil {
			t.Fatal(err)
		}
		handles = append(handles, handle)
		defer windows.CloseHandle(handle)
		if status, err := windows.WaitForSingleObject(handle, 0); err != nil || status != uint32(windows.WAIT_TIMEOUT) {
			t.Fatal("original helper not live before supervisor death", status, err)
		}
	}
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := command.Wait(); err == nil {
		t.Fatal("killed supervisor unexpectedly succeeded")
	}
	for _, handle := range handles {
		status, err := windows.WaitForSingleObject(handle, 10000)
		if err != nil || status != windows.WAIT_OBJECT_0 {
			t.Fatalf("original child survived owner death: %d %v", status, err)
		}
	}
}

func TestPlatformEnvironmentAndArgumentRoundTrip(t *testing.T) {
	dir := t.TempDir()
	self, _ := os.Executable()
	wantArgs := []string{"中文 空间", `trailing\`, `a"quote`, ""}
	env := append(platformTestEnvironment(), "OBU_PLATFORM_VALUE=old", "obu_platform_value=new", "OBU_PLATFORM_UNICODE=测试😀")
	p, err := platformStart(self, helperArguments("environment", dir, wantArgs...), env, filepath.Join(dir, "environment.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if err := p.Wait(); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Value   string   `json:"value"`
		Unicode string   `json:"unicode"`
		Args    []string `json:"args"`
	}
	awaitPlatformJSON(t, filepath.Join(dir, "environment.json"), &result)
	if result.Value != "new" || result.Unicode != "测试😀" || !reflect.DeepEqual(result.Args, wantArgs) {
		t.Fatalf("round trip mismatch: %#v", result)
	}
	block, err := platformEnvironment([]string{"z=1", "a=first", "A=last", "=C:=C:\\test"})
	if err != nil {
		t.Fatal(err)
	}
	decoded := string(utf16.Decode(block))
	if decoded != "=C:=C:\\test\x00A=last\x00z=1\x00\x00" {
		t.Fatalf("environment not deduplicated and sorted: %q", decoded)
	}
	for _, invalid := range []string{"missing-equals", "=", "A\x00=B"} {
		if _, err := platformEnvironment([]string{invalid}); err == nil {
			t.Fatalf("accepted invalid environment %q", invalid)
		}
	}
}

func TestPlatformOriginalNonzeroExit(t *testing.T) {
	p := startPlatformHelper(t, "exit", t.TempDir(), "7")
	var exit *platformExitError
	if err := p.Wait(); !errors.As(err, &exit) || exit.Code != 7 {
		t.Fatalf("original exit error: %v", err)
	}
	if code, err := p.ExitCode(); err != nil || code != 7 {
		t.Fatalf("exit receipt: %d %v", code, err)
	}
}

func TestPlatformProfileLockAcrossProcesses(t *testing.T) {
	dir := t.TempDir()
	lock, err := platformLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	self, _ := os.Executable()
	check := func(want bool) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, self, helperArguments("lock", dir)...)
		command.Env = platformTestEnvironment()
		command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if out, err := command.CombinedOutput(); err != nil {
			t.Fatalf("lock helper: %v %s", err, out)
		}
		var result struct {
			Locked bool `json:"locked"`
		}
		awaitPlatformJSON(t, filepath.Join(dir, "lock-result.json"), &result)
		if result.Locked != want {
			t.Fatalf("cross-process lock got %v want %v", result.Locked, want)
		}
	}
	check(false)
	if err := os.Remove(filepath.Join(dir, ".managed-profile.lock")); err == nil {
		t.Fatal("locked pathname was replaced")
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	check(true)
}

func TestPlatformPathsAndDirectoryProtection(t *testing.T) {
	dir := t.TempDir()
	if err := platformValidatePath(filepath.Join(dir, "new", "normal.txt")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{`\\?\C:\test`, `\\server\share\test`, `C:relative`, `C:\file:stream`, `C:\trailing.\file`, `C:\trailing \file`, `C:\CON.txt`, `C:\a\..\b`, `C:\LPT¹.txt`} {
		if err := platformValidatePath(path); err == nil {
			t.Fatalf("accepted special path %q", path)
		}
	}
	if err := platformProtectDirectory(dir); err != nil {
		t.Fatal(err)
	}
	sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sddl := sd.String()
	if !strings.HasPrefix(sddl, "D:P") || !strings.Contains(sddl, ";;;SY)") || !strings.Contains(sddl, ";;;"+user.User.Sid.String()+")") || strings.Count(sddl, "(A;") != 2 {
		t.Fatalf("unexpected protected DACL: %s", sddl)
	}
	link := filepath.Join(dir, "reparse")
	createPlatformTestJunction(t, link, dir)
	defer os.Remove(link)
	if err := platformValidatePath(filepath.Join(link, "child")); err == nil {
		t.Fatal("accepted a reparse ancestor")
	}
}

// Mount-point junctions exercise the real reparse attribute without requiring
// the unrelated SeCreateSymbolicLinkPrivilege on a developer's Windows account.
func createPlatformTestJunction(t *testing.T, link, target string) {
	t.Helper()
	if err := os.Mkdir(link, 0o700); err != nil {
		t.Fatal(err)
	}
	name, err := windows.UTF16PtrFromString(link)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	substitute := utf16.Encode([]rune(`\??\` + target))
	printName := utf16.Encode([]rune(target))
	data := make([]byte, 16+(len(substitute)+len(printName)+2)*2)
	binary.LittleEndian.PutUint32(data, windows.IO_REPARSE_TAG_MOUNT_POINT)
	binary.LittleEndian.PutUint16(data[4:], uint16(len(data)-8))
	binary.LittleEndian.PutUint16(data[10:], uint16(len(substitute)*2))
	binary.LittleEndian.PutUint16(data[12:], uint16((len(substitute)+1)*2))
	binary.LittleEndian.PutUint16(data[14:], uint16(len(printName)*2))
	for index, value := range append(append(substitute, 0), append(printName, 0)...) {
		binary.LittleEndian.PutUint16(data[16+index*2:], value)
	}
	var returned uint32
	if err := windows.DeviceIoControl(handle, windows.FSCTL_SET_REPARSE_POINT, &data[0], uint32(len(data)), nil, 0, &returned, nil); err != nil {
		t.Fatal(err)
	}
}

func TestPlatformNativeRegistrationOwnership(t *testing.T) {
	dir := t.TempDir()
	manifest := filepath.Join(dir, "manifest.json")
	if err := os.WriteFile(manifest, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	id, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	name := "com.openbrowseruse.managed.n" + id
	registration, err := platformRegister(name, manifest, id)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := registration.Close(); err != nil {
			t.Errorf("registration cleanup: %v", err)
		}
	}()
	if _, err := platformRegister(name, manifest, id); err == nil {
		t.Fatal("adopted a preexisting registration")
	}
	key, err := registry.OpenKey(registry.CURRENT_USER, nativeRegistryParent+`\`+name, registry.READ|registry.WRITE|registry.WOW64_32KEY)
	if err != nil {
		t.Fatal(err)
	}
	defer key.Close()
	for _, change := range []string{"owner", "manifest", "extra", "child"} {
		switch change {
		case "owner":
			err = key.SetStringValue(nativeOwnerValue, "someone-else")
		case "manifest":
			err = key.SetStringValue("", manifest+"-other")
		case "extra":
			err = key.SetStringValue("UnexpectedTestValue", "keep")
		case "child":
			child, _, createErr := registry.CreateKey(key, "UnexpectedTestChild", registry.READ|registry.WRITE)
			err = createErr
			if err == nil {
				err = child.Close()
			}
		}
		if err != nil {
			t.Fatal(err)
		}
		if err := registration.Close(); err == nil {
			t.Fatalf("deleted changed %s registration", change)
		}
		if _, err := key.Stat(); err != nil {
			t.Fatalf("changed registration no longer exists: %v", err)
		}
		switch change {
		case "owner":
			err = key.SetStringValue(nativeOwnerValue, id)
		case "manifest":
			err = key.SetStringValue("", manifest)
		case "extra":
			err = key.DeleteValue("UnexpectedTestValue")
		case "child":
			err = registry.DeleteKey(key, "UnexpectedTestChild")
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := registration.Close(); err != nil {
		t.Fatal(err)
	}
	for _, view := range []uint32{registry.WOW64_32KEY, registry.WOW64_64KEY} {
		other, err := registry.OpenKey(registry.CURRENT_USER, nativeRegistryParent+`\`+name, registry.READ|view)
		if err == nil {
			other.Close()
			t.Fatal("owned registration survived Close")
		}
		if !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			t.Fatal(err)
		}
	}
	if _, err := platformRegister("com.ifuryst.open_browser_use.extension", manifest, id); err == nil {
		t.Fatal("accepted production native host name")
	}
}

func TestPlatformPartialRegistrationFailureIsNotClaimedClean(t *testing.T) {
	id, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	r := &platformRegistration{name: "com.openbrowseruse.managed.n" + id, owner: id, manifest: filepath.Join(t.TempDir(), "manifest.json")}
	key, existed, err := registry.CreateKey(registry.CURRENT_USER, nativeRegistryParent+`\`+r.name, registry.READ|registry.WRITE|registry.WOW64_32KEY)
	if err != nil || existed {
		t.Fatalf("new partial registration: %v existed=%v", err, existed)
	}
	defer key.Close()
	if err := key.SetStringValue(nativeOwnerValue, id); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := key.SetStringValue("", r.manifest); err != nil {
			t.Error(err)
			return
		}
		if err := r.Close(); err != nil {
			t.Error(err)
		}
	}()
	err = r.startupFailure(windows.ERROR_ACCESS_DENIED)
	if !errors.Is(err, windows.ERROR_ACCESS_DENIED) || !strings.Contains(err.Error(), "cleanup is unconfirmed") || !strings.Contains(err.Error(), r.name) {
		t.Fatalf("incomplete cleanup not surfaced: %v", err)
	}
	if info, err := key.Stat(); err != nil || info.ValueCount != 1 {
		t.Fatalf("incomplete key was deleted: %#v %v", info, err)
	}
}
