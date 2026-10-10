package host

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ifuryst/open-browser-use/internal/transport"
)

const EndpointRecordSuffix = ".endpoint.json"

// EndpointRecordPath gives each pipe its own discovery record so restarting one
// browser profile cannot hide every other profile when active.json disappears.
func EndpointRecordPath(dir, endpoint string) string {
	digest := sha256.Sum256([]byte(endpoint))
	return filepath.Join(socketDir(dir), fmt.Sprintf("%x%s", digest[:16], EndpointRecordSuffix))
}

func WriteEndpointRecord(dir, endpoint string) error {
	if !transport.IsNamedPipe(endpoint) {
		return nil // Unix socket directory entries already provide discovery.
	}
	return writeSocketRecord(EndpointRecordPath(dir, endpoint), ActiveSocketRecord{
		SocketPath: endpoint, PID: os.Getpid(), StartedAt: time.Now().UTC(),
	})
}

func ReadEndpointRecord(path string) (ActiveSocketRecord, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return ActiveSocketRecord{}, err
	}
	if !info.Mode().IsRegular() || info.Size() > 4096 {
		return ActiveSocketRecord{}, fmt.Errorf("invalid endpoint record")
	}
	file, err := os.Open(path)
	if err != nil {
		return ActiveSocketRecord{}, err
	}
	defer file.Close()
	payload, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil {
		return ActiveSocketRecord{}, err
	}
	var record ActiveSocketRecord
	if len(payload) > 4096 || json.Unmarshal(payload, &record) != nil || !transport.IsNamedPipe(record.SocketPath) {
		return ActiveSocketRecord{}, fmt.Errorf("invalid named pipe endpoint record")
	}
	expected := EndpointRecordPath(filepath.Dir(path), record.SocketPath)
	if !strings.EqualFold(filepath.Base(path), filepath.Base(expected)) {
		return ActiveSocketRecord{}, fmt.Errorf("endpoint record filename does not match endpoint")
	}
	return record, nil
}

func RemoveEndpointRecord(dir, endpoint string) error {
	if !transport.IsNamedPipe(endpoint) {
		return nil
	}
	path := EndpointRecordPath(dir, endpoint)
	record, err := ReadEndpointRecord(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if record.SocketPath != endpoint {
		return nil
	}
	return os.Remove(path)
}

func writeSocketRecord(path string, record ActiveSocketRecord) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".endpoint-*")
	if err != nil {
		return err
	}
	tempPath := file.Name()
	defer os.Remove(tempPath)
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return err
	}
	_, writeErr := file.Write(append(payload, '\n'))
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(tempPath, path)
}
