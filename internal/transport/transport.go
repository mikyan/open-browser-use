// Package transport connects local SDKs to a native host. Windows uses byte-mode
// named pipes; Unix systems use domain sockets with the same frame protocol.
package transport

import (
	"errors"
	"net"
	"os"
	"strings"
	"syscall"
)

const pipePrefix = `\\.\pipe\`

func IsNamedPipe(path string) bool {
	return strings.HasPrefix(strings.ToLower(path), pipePrefix)
}

// IsStale reports only definite endpoint absence. A busy pipe, denied access,
// or a timeout must not cause another live host's discovery record to be erased.
func IsStale(err error) bool {
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return false
	}
	return errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ECONNREFUSED) || isPlatformStale(err)
}

// RemoveEndpoint removes a Unix socket. Named pipes disappear when all handles
// close and must never be treated as files in the discovery directory.
func RemoveEndpoint(path string) error {
	if IsNamedPipe(path) {
		return nil
	}
	return os.Remove(path)
}
