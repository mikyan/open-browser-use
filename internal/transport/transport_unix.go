//go:build !windows

package transport

import (
	"net"
	"os"
	"path/filepath"
	"time"
)

func NewEndpoint(dir, id string) string { return filepath.Join(dir, id+".sock") }

func Listen(path string) (net.Listener, error) {
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = listener.Close()
		return nil, err
	}
	return listener, nil
}

func DialTimeout(path string, timeout time.Duration) (net.Conn, error) {
	return net.DialTimeout("unix", path, timeout)
}

func isPlatformStale(error) bool { return false }
