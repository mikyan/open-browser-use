//go:build !windows

package managedruntime

import (
	"io"
	"os"
)

func platformValidatePath(string) error            { return errUnsupported }
func platformProtectDirectory(string) error        { return errUnsupported }
func platformLock(string, bool) (io.Closer, error) { return nil, errUnsupported }
func platformValidateDictionary(*os.File) error    { return errUnsupported }
