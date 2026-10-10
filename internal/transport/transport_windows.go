//go:build windows

package transport

import (
	"errors"
	"fmt"
	"net"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func NewEndpoint(_ string, id string) string { return pipePrefix + "open-browser-use-" + id }

func Listen(path string) (net.Listener, error) {
	if !IsNamedPipe(path) {
		// Explicit legacy paths remain usable by older Go clients on Windows.
		return net.Listen("unix", path)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, fmt.Errorf("get native host user SID: %w", err)
	}
	return winio.ListenPipe(path, &winio.PipeConfig{
		// A protected ACL grants only this user access. go-winio also rejects
		// remote clients and creates the first instance exclusively.
		SecurityDescriptor: "D:P(A;;GA;;;" + user.User.Sid.String() + ")",
		MessageMode:        false,
		InputBufferSize:    65536,
		OutputBufferSize:   65536,
	})
}

func DialTimeout(path string, timeout time.Duration) (net.Conn, error) {
	if !IsNamedPipe(path) {
		return net.DialTimeout("unix", path, timeout)
	}
	return winio.DialPipe(path, &timeout)
}

func isPlatformStale(err error) bool { return errors.Is(err, windows.WSAECONNREFUSED) }
