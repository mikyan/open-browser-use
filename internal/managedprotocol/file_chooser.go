package managedprotocol

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
)

const (
	MaxHumanFiles        = 16
	MaxHumanFileBytes    = 32 << 20
	MaxHumanUploadBytes  = 64 << 20
	MaxHumanSessionBytes = 256 << 20
	MaxHumanChunkBytes   = 16 << 10
)

type FileChooserIdentity struct {
	LeaseID    string `json:"leaseId"`
	Generation uint64 `json:"generation"`
	ChooserID  string `json:"chooserId"`
}

type PendingFileChooser struct {
	FileChooserIdentity
	Multiple bool         `json:"multiple"`
	Source   DialogSource `json:"source,omitzero"`
}

type HumanFile struct {
	Name string `json:"name"`
	Size uint64 `json:"size"`
}

type FileTransfer struct {
	FileChooserIdentity
	TransferID string `json:"transferId"`
	FileCount  uint64 `json:"fileCount"`
	TotalBytes uint64 `json:"totalBytes"`
}

type FileChunk struct {
	FileChooserIdentity
	TransferID string `json:"transferId"`
	FileIndex  uint64 `json:"fileIndex"`
	NextOffset uint64 `json:"nextOffset"`
}

type FileChooserReceipt struct {
	FileChooserIdentity
	TransferID   string `json:"transferId"`
	Acknowledged bool   `json:"acknowledged"`
}

type FileChooserCancellation struct {
	FileChooserIdentity
	TransferID string `json:"transferId,omitempty"`
	Cancelled  bool   `json:"cancelled"`
}

func IsHumanFileOperation(operation string) bool {
	switch operation {
	case "humanFileBegin", "humanFileChunk", "humanFileCommit", "humanFileCancel":
		return true
	}
	return false
}

func fileIdentity(f map[string]json.RawMessage) bool {
	return dialogText(f["leaseId"], 128, false, false) && integer(f["generation"], 1, MaxSafeInteger) && dialogText(f["chooserId"], 128, false, false)
}

// A browser File.name is a basename, never permission to address a caller path.
// Keep the original Unicode spelling; reject names Windows would reinterpret.
func HumanFileName(name string) bool {
	raw, _ := json.Marshal(name)
	if !dialogText(raw, 240, false, false) || name == "." || name == ".." || strings.TrimRight(name, " .") != name ||
		strings.ContainsAny(name, `/\<>:"|?*`) {
		return false
	}
	base, _, _ := strings.Cut(name, ".")
	base = strings.ToUpper(strings.TrimRight(base, " "))
	switch base {
	case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$":
		return false
	}
	if strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT") {
		suffix := base[3:]
		if len([]rune(suffix)) == 1 && strings.ContainsAny(suffix, "123456789¹²³") {
			return false
		}
	}
	return true
}

func ParseHumanFiles(raw json.RawMessage) ([]HumanFile, uint64, error) {
	var rows []json.RawMessage
	if bytes.Equal(raw, []byte("null")) || json.Unmarshal(raw, &rows) != nil || len(rows) < 1 || len(rows) > MaxHumanFiles {
		return nil, 0, errors.New("invalid human file list")
	}
	files := make([]HumanFile, 0, len(rows))
	var total uint64
	for _, row := range rows {
		f, err := Object(row)
		var file HumanFile
		if err != nil || !exact(f, []string{"name", "size"}, nil) || !dialogText(f["name"], 240, false, false) ||
			!integer(f["size"], 0, MaxHumanFileBytes) || json.Unmarshal(row, &file) != nil || !HumanFileName(file.Name) {
			return nil, 0, errors.New("invalid human file metadata")
		}
		total += file.Size
		if total > MaxHumanUploadBytes {
			return nil, 0, errors.New("human file byte limit exceeded")
		}
		files = append(files, file)
	}
	return files, total, nil
}

func DecodeHumanFileChunk(raw json.RawMessage) ([]byte, error) {
	var encoded string
	if json.Unmarshal(raw, &encoded) != nil || len(encoded) == 0 || len(encoded) > base64.StdEncoding.EncodedLen(MaxHumanChunkBytes) {
		return nil, errors.New("invalid human file chunk")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(data) == 0 || len(data) > MaxHumanChunkBytes || base64.StdEncoding.EncodeToString(data) != encoded {
		return nil, errors.New("invalid human file chunk")
	}
	return data, nil
}

func validateHumanFileCommand(operation string, f map[string]json.RawMessage) error {
	if !fileIdentity(f) {
		return errors.New("invalid human chooser identity")
	}
	if operation == "humanFileBegin" {
		_, _, err := ParseHumanFiles(f["files"])
		return err
	}
	if operation != "humanFileCancel" || f["transferId"] != nil {
		if !dialogText(f["transferId"], 128, false, false) {
			return errors.New("invalid human file transfer identity")
		}
	}
	if operation == "humanFileChunk" {
		if !integer(f["fileIndex"], 0, MaxHumanFiles-1) || !integer(f["offset"], 0, MaxHumanFileBytes) {
			return errors.New("invalid human file chunk position")
		}
		_, err := DecodeHumanFileChunk(f["data"])
		return err
	}
	return nil
}

func ParsePendingFileChooser(data json.RawMessage, human *HumanState) (*PendingFileChooser, error) {
	if len(data) == 0 || bytes.Equal(data, []byte("null")) {
		return nil, nil
	}
	f, err := Object(data)
	if err != nil || !exact(f, []string{"leaseId", "generation", "chooserId", "multiple"}, []string{"source"}) || !fileIdentity(f) || !boolean(f["multiple"]) {
		return nil, errors.New("invalid pending human file chooser")
	}
	var chooser PendingFileChooser
	_ = json.Unmarshal(data, &chooser)
	if raw, ok := f["source"]; ok {
		chooser.Source, err = parseDialogSource(raw)
		if err != nil {
			return nil, err
		}
	}
	if human == nil || human.FileChooserVersion != 1 || human.Generation == 0 ||
		human.State != "active" && human.State != "preparing" && human.State != "navigating" ||
		chooser.LeaseID != human.LeaseID || chooser.Generation != human.Generation {
		return nil, errors.New("pending chooser lacks original human admission")
	}
	return &chooser, nil
}

// ParseFileResult rejects private paths/handles and never creates native ACKs.
func ParseFileResult(key string, raw json.RawMessage) (any, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	f, err := Object(raw)
	required := []string{"leaseId", "generation", "chooserId"}
	var optional []string
	switch key {
	case "fileChooserClaim":
		required = append(required, "transferId")
	case "fileTransfer":
		required = append(required, "transferId", "fileCount", "totalBytes")
	case "fileChunk":
		required = append(required, "transferId", "fileIndex", "nextOffset")
	case "fileChooserReceipt":
		required = append(required, "transferId", "acknowledged")
	case "fileChooserCancellation":
		required = append(required, "cancelled")
		optional = []string{"transferId"}
	default:
		return nil, errors.New("invalid file receipt kind")
	}
	if err != nil || !exact(f, required, optional) || !fileIdentity(f) ||
		(key != "fileChooserCancellation" || f["transferId"] != nil) && !dialogText(f["transferId"], 128, false, false) {
		return nil, errors.New("invalid human file receipt")
	}
	switch key {
	case "fileTransfer":
		if !integer(f["fileCount"], 1, MaxHumanFiles) || !integer(f["totalBytes"], 0, MaxHumanUploadBytes) {
			return nil, errors.New("invalid file transfer receipt")
		}
	case "fileChunk":
		if !integer(f["fileIndex"], 0, MaxHumanFiles-1) || !integer(f["nextOffset"], 1, MaxHumanFileBytes) {
			return nil, errors.New("invalid file chunk receipt")
		}
	case "fileChooserReceipt":
		if !bytes.Equal(f["acknowledged"], []byte("true")) {
			return nil, errors.New("file selection not acknowledged")
		}
	case "fileChooserCancellation":
		if !bytes.Equal(f["cancelled"], []byte("true")) {
			return nil, errors.New("file cancellation not confirmed")
		}
	}
	// Strictly parsed raw members retain integer identity without float64.
	return f, nil
}

func MatchFileResult(request map[string]json.RawMessage, key string, raw json.RawMessage) bool {
	if result, err := ParseFileResult(key, raw); err != nil || result == nil {
		return false
	}
	fields, _ := Object(raw)
	for _, name := range []string{"leaseId", "generation", "chooserId"} {
		if !bytes.Equal(request[name], fields[name]) {
			// String escaping is not identity. Normalize strings via JSON.
			var a, b any
			if json.Unmarshal(request[name], &a) != nil || json.Unmarshal(fields[name], &b) != nil || a != b {
				return false
			}
		}
	}
	if request["transferId"] != nil || key == "fileChooserCancellation" {
		var a, b string
		_ = json.Unmarshal(request["transferId"], &a)
		_ = json.Unmarshal(fields["transferId"], &b)
		if a != b {
			return false
		}
	}
	if key == "fileTransfer" {
		files, total, err := ParseHumanFiles(request["files"])
		var got FileTransfer
		_ = json.Unmarshal(raw, &got)
		return err == nil && got.FileCount == uint64(len(files)) && got.TotalBytes == total
	}
	if key == "fileChunk" {
		var index, offset uint64
		_ = json.Unmarshal(request["fileIndex"], &index)
		_ = json.Unmarshal(request["offset"], &offset)
		data, err := DecodeHumanFileChunk(request["data"])
		var got FileChunk
		_ = json.Unmarshal(raw, &got)
		return err == nil && got.FileIndex == index && got.NextOffset == offset+uint64(len(data))
	}
	return true
}
