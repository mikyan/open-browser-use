//go:build windows

package managedruntime

import (
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/sys/windows"
)

// This rejects junctions as well as symbolic links. The protected user cache is
// an OS-user boundary, not a sandbox against arbitrary code running as that user.
func platformValidatePath(name string) error {
	if len(name) < 3 || name[1] != ':' || name[2] != '\\' || !((name[0] >= 'A' && name[0] <= 'Z') || (name[0] >= 'a' && name[0] <= 'z')) || strings.Contains(name, "/") {
		return errors.New("managed browser paths must be absolute local drive paths")
	}
	parts := []string{}
	if len(name) > 3 {
		parts = strings.Split(name[3:], `\`)
	}
	for _, part := range parts {
		if !validComponent(part) {
			return errors.New("managed browser path has a reserved or noncanonical Windows component")
		}
	}
	current, missing := name[:3], false
	for index := 0; index <= len(parts); index++ {
		if index > 0 {
			current = filepath.Join(current, parts[index-1])
		}
		if missing {
			continue
		}
		pointer, err := windows.UTF16PtrFromString(current)
		if err != nil {
			return err
		}
		attributes, err := windows.GetFileAttributes(pointer)
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			missing = true
			continue
		}
		if err != nil {
			return err
		}
		if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return errors.New("managed browser path crosses a reparse point")
		}
		if index < len(parts) && attributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
			return errors.New("managed browser path ancestor is not a directory")
		}
	}
	return nil
}

func platformProtectDirectory(name string) (err error) {
	if err := platformValidatePath(name); err != nil {
		return err
	}
	pointer, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(pointer, windows.READ_CONTROL|windows.WRITE_DAC, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, windows.CloseHandle(handle)) }()
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("managed browser ownership target is not an ordinary directory")
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

type cacheLock struct {
	handle windows.Handle
	once   sync.Once
	err    error
}

func platformLock(root string, create bool) (io.Closer, error) {
	name := filepath.Join(root, lockName)
	if err := platformValidatePath(name); err != nil {
		return nil, err
	}
	pointer, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, err
	}
	mode := uint32(windows.OPEN_EXISTING)
	if create {
		mode = windows.OPEN_ALWAYS
	}
	// No share-delete: the locked pathname cannot be replaced during inspection.
	handle, err := windows.CreateFile(pointer, windows.GENERIC_READ|windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, mode, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		if errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
			return nil, ErrBusy
		}
		return nil, err
	}
	var info windows.ByHandleFileInformation
	err = windows.GetFileInformationByHandle(handle, &info)
	if err == nil && (info.FileAttributes&(windows.FILE_ATTRIBUTE_DIRECTORY|windows.FILE_ATTRIBUTE_REPARSE_POINT) != 0 || info.NumberOfLinks != 1 || info.FileSizeHigh != 0 || info.FileSizeLow != 0) {
		err = errors.New("managed browser lock is not the original empty regular file")
	}
	if err == nil {
		err = windows.LockFileEx(handle, windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &windows.Overlapped{})
	}
	if err != nil {
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			err = ErrBusy
		}
		return nil, errors.Join(fmt.Errorf("managed browser cache lock: %w", err), windows.CloseHandle(handle))
	}
	return &cacheLock{handle: handle}, nil
}

func (lock *cacheLock) Close() error {
	lock.once.Do(func() {
		lock.err = errors.Join(windows.UnlockFileEx(lock.handle, 0, 1, 0, &windows.Overlapped{}), windows.CloseHandle(lock.handle))
	})
	return lock.err
}
