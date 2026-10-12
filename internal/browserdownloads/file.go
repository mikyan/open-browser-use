package browserdownloads

import "os"

func readableFile(path string) error {
	before, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() {
		return failure("FILE_UNAVAILABLE", "native path is not a regular file")
	}
	file, err := openFile(path)
	if err != nil {
		return err
	}
	after, statErr := file.Stat()
	closeErr := file.Close()
	if statErr != nil {
		return statErr
	}
	if !after.Mode().IsRegular() || !os.SameFile(before, after) {
		return failure("FILE_UNAVAILABLE", "native file changed while opening")
	}
	return closeErr
}
