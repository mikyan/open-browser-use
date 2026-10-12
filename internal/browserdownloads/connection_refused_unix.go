//go:build !windows

package browserdownloads

import "syscall"

const connectionRefused = syscall.ECONNREFUSED
