//go:build !windows

package managedbrowser

import (
	"context"
	"errors"
	"io"
)

var errManagedPlatform = errors.New("isolated managed browser sessions currently require Windows 10 or newer")

func platformValidatePath(string) error                          { return errManagedPlatform }
func platformProtectDirectory(string) error                      { return errManagedPlatform }
func platformLock(string) (io.Closer, error)                     { return nil, errManagedPlatform }
func platformRegister(string, string, string) (io.Closer, error) { return nil, errManagedPlatform }
func platformStart(string, []string, []string, string) (*platformProcess, error) {
	return nil, errManagedPlatform
}
func platformStartWithVisibility(string, []string, []string, string, bool) (*platformProcess, error) {
	return nil, errManagedPlatform
}

type platformProcess struct{}

func (*platformProcess) PID() int                      { return 0 }
func (*platformProcess) Wait() error                   { return errManagedPlatform }
func (*platformProcess) ExitCode() (uint32, error)     { return 0, errManagedPlatform }
func (*platformProcess) JobContains(int, string) error { return errManagedPlatform }
func (*platformProcess) NativeHost(int, string) (*platformNativeProcess, error) {
	return nil, errManagedPlatform
}
func (*platformProcess) Terminate() error               { return errManagedPlatform }
func (*platformProcess) WaitTree(context.Context) error { return errManagedPlatform }
func (*platformProcess) Close() error                   { return errManagedPlatform }

type platformNativeProcess struct{}

func (*platformNativeProcess) CreationTime() uint64       { return 0 }
func (*platformNativeProcess) ExitCode() (uint32, error)  { return 0, errManagedPlatform }
func (*platformNativeProcess) Wait(context.Context) error { return errManagedPlatform }
func (*platformNativeProcess) Close() error               { return errManagedPlatform }
