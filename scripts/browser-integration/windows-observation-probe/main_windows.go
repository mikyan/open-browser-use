//go:build windows

// Acceptance-only observer. No title/text reads, keyboard/click hooks, input,
// focus changes, browser connections, or user-profile access.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"regexp"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	foregroundEvent = 3
	wmTimer         = 0x0113
	wmReady         = 0x8001
	wmStop          = 0x8002
)

type point struct{ X, Y int32 }
type message struct {
	Window         uintptr
	Message        uint32
	WParam, LParam uintptr
	Time           uint32
	Point          point
	Private        uint32
}
type foreground struct {
	HWND string  `json:"hwnd"`
	PID  *uint32 `json:"pid"`
}
type stopRequest struct{ reason, failure string }

var user32 = windows.NewLazySystemDLL("user32.dll")
var getForeground = user32.NewProc("GetForegroundWindow")
var getWindowPID = user32.NewProc("GetWindowThreadProcessId")
var getCursor = user32.NewProc("GetCursorPos")
var setHook = user32.NewProc("SetWinEventHook")
var unhook = user32.NewProc("UnhookWinEvent")
var peekMessage = user32.NewProc("PeekMessageW")
var getMessage = user32.NewProc("GetMessageW")
var postThreadMessage = user32.NewProc("PostThreadMessageW")
var setTimer = user32.NewProc("SetTimer")
var killTimer = user32.NewProc("KillTimer")

type windowsPlatform struct {
	threadID uint32
	callback uintptr
}

func (p *windowsPlatform) identify(hwnd uintptr) foreground {
	var pid uint32
	if hwnd != 0 {
		thread, _, _ := getWindowPID.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
		if thread == 0 || pid == 0 {
			return foreground{fmt.Sprint(hwnd), nil}
		}
	}
	return foreground{fmt.Sprint(hwnd), &pid}
}
func (p *windowsPlatform) foreground() foreground {
	hwnd, _, _ := getForeground.Call()
	return p.identify(hwnd)
}
func (p *windowsPlatform) cursor() (point, bool) {
	var cursor point
	ok, _, _ := getCursor.Call(uintptr(unsafe.Pointer(&cursor)))
	return cursor, ok != 0
}
func (p *windowsPlatform) createQueue() {
	var msg message
	peekMessage.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0, 0)
	p.threadID = windows.GetCurrentThreadId()
}
func (p *windowsPlatform) installHook(observe func(uintptr, uint32)) uintptr {
	p.callback = syscall.NewCallback(func(_hook, event, hwnd, _objectID, _childID, _thread, eventTime uintptr) uintptr {
		if event == foregroundEvent {
			observe(hwnd, uint32(eventTime))
		}
		return 0
	})
	// Exact EVENT_SYSTEM_FOREGROUND range; OUTOFCONTEXT (0), with no process
	// skipping. Native callbacks run through GetMessage on the owner thread.
	hook, _, _ := setHook.Call(foregroundEvent, foregroundEvent, 0, p.callback, 0, 0, 0)
	return hook
}
func (p *windowsPlatform) startTimer(interval uint) uintptr {
	timer, _, _ := setTimer.Call(0, 0, uintptr(interval), 0)
	return timer
}
func (p *windowsPlatform) post(kind uint32) bool {
	ok, _, _ := postThreadMessage.Call(uintptr(p.threadID), uintptr(kind), 0, 0)
	return ok != 0
}
func (p *windowsPlatform) next() (message, int32) {
	var msg message
	result, _, _ := getMessage.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
	return msg, int32(result)
}
func (p *windowsPlatform) stopTimer(timer uintptr) bool {
	ok, _, _ := killTimer.Call(0, timer)
	return ok != 0
}
func (p *windowsPlatform) removeHook(hook uintptr) bool {
	ok, _, _ := unhook.Call(hook)
	runtime.KeepAlive(p.callback)
	return ok != 0
}

func parseOptions(args []string) (string, uint, bool) {
	flags := flag.NewFlagSet("windows-observation-probe", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	runID := flags.String("run-id", "", "original observation UUID")
	sampleMS := flags.Uint("sample-ms", 50, "cursor/foreground sample interval")
	if flags.Parse(args) != nil || flags.NArg() != 0 || !regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`).MatchString(*runID) || *sampleMS < 25 || *sampleMS > 1000 {
		return "", 0, false
	}
	return *runID, *sampleMS, true
}

func main() {
	runID, sampleMS, ok := parseOptions(os.Args[1:])
	if !ok {
		fmt.Fprintln(os.Stderr, "INVALID_ARGUMENTS")
		os.Exit(2)
	}
	runtime.LockOSThread()
	// os.Exit also retires the process-owned callback thunk. Hook/timer cleanup
	// and its receipts have already settled on this original locked thread.
	os.Exit(observe(&windowsPlatform{}, os.Stdin, os.Stdout, runID, os.Getpid(), sampleMS))
}
