//go:build !windows

package managedruntime

import "io"

func platformValidatePath(string) error            { return errUnsupported }
func platformProtectDirectory(string) error        { return errUnsupported }
func platformLock(string, bool) (io.Closer, error) { return nil, errUnsupported }
