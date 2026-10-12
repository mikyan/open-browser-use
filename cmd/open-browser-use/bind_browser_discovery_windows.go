package main

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

func openBindPortFile(path string) (*os.File, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	var info windows.ByHandleFileInformation
	fileType, typeErr := windows.GetFileType(handle)
	infoErr := windows.GetFileInformationByHandle(handle, &info)
	if typeErr != nil || infoErr != nil || fileType != windows.FILE_TYPE_DISK || info.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		_ = windows.CloseHandle(handle)
		return nil, errors.Join(errors.New("bind-browser: DevToolsActivePort is not an ordinary disk file"), typeErr, infoErr)
	}
	return os.NewFile(uintptr(handle), path), nil
}
