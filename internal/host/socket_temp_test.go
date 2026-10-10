package host

import "runtime"

// macOS TMPDIR can exceed sockaddr_un limits; Windows has no /tmp directory.
func socketTestTempRoot() string {
	if runtime.GOOS == "windows" {
		return ""
	}
	return "/tmp"
}
