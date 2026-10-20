package managedbrowser

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
)

type fileClaim struct {
	metadata   managedprotocol.PendingFileChooser
	transferID string
	begun      bool
	terminal   bool
}

func fileTuple(fields map[string]json.RawMessage) managedprotocol.FileChooserIdentity {
	var tuple managedprotocol.FileChooserIdentity
	_ = json.Unmarshal(fields["leaseId"], &tuple.LeaseID)
	_ = json.Unmarshal(fields["generation"], &tuple.Generation)
	_ = json.Unmarshal(fields["chooserId"], &tuple.ChooserID)
	return tuple
}

func (c *UserController) observeFileChooserLocked(chooser *managedprotocol.PendingFileChooser) error {
	if chooser != nil {
		claim, seen := c.fileClaims[chooser.FileChooserIdentity]
		if seen && claim.metadata != *chooser || !seen && len(c.fileClaims) >= 1024 {
			return errors.New("original human chooser metadata changed or capacity exhausted")
		}
		if !seen {
			if c.fileClaims == nil {
				c.fileClaims = make(map[managedprotocol.FileChooserIdentity]fileClaim)
			}
			c.fileClaims[chooser.FileChooserIdentity] = fileClaim{metadata: *chooser}
		}
	}
	for tuple, claim := range c.fileClaims {
		if chooser == nil || chooser.FileChooserIdentity != tuple {
			claim.terminal = true
			c.fileClaims[tuple] = claim
		}
	}
	c.pendingFileChooser = chooser
	if c.files != nil {
		c.files.retireExcept(c, chooser)
	}
	return nil
}

func (c *UserController) retireFilesLocked() {
	c.fileRevoked = true
	for tuple, claim := range c.fileClaims {
		claim.terminal = true
		c.fileClaims[tuple] = claim
	}
	c.pendingFileChooser = nil
	if c.files != nil {
		c.files.retire(c, managedprotocol.FileChooserIdentity{}, "")
	}
}

func (c *UserController) currentFileLocked(tuple managedprotocol.FileChooserIdentity) (fileClaim, error) {
	claim, known := c.fileClaims[tuple]
	h := c.humanStatus
	if c.closing || c.fileRevoked || !known || claim.terminal || c.files == nil || !c.humanStatusCurrent || h == nil ||
		h.FileChooserVersion != 1 || h.LeaseID != tuple.LeaseID || h.Generation != tuple.Generation ||
		c.pendingFileChooser == nil || c.pendingFileChooser.FileChooserIdentity != tuple {
		return claim, fileError("STALE")
	}
	return claim, nil
}

func (c *UserController) fileCommand(ctx context.Context, fields map[string]json.RawMessage, operation string) (json.RawMessage, error) {
	tuple := fileTuple(fields)
	var id string
	_ = json.Unmarshal(fields["transferId"], &id)
	c.mu.Lock()
	claim, err := c.currentFileLocked(tuple)
	if err == nil && operation == "humanFileBegin" && claim.begun {
		err = fileError("STALE")
	}
	if err == nil && operation != "humanFileBegin" && operation != "humanFileCancel" && (!claim.begun || claim.transferID == "" || claim.transferID != id) {
		err = fileError("STALE")
	}
	if err == nil && operation == "humanFileCancel" && id != "" && claim.transferID != id {
		err = fileError("STALE")
	}
	if err != nil {
		c.mu.Unlock()
		return nil, err
	}
	if operation == "humanFileCancel" {
		claim.terminal = true
		c.fileClaims[tuple] = claim
		c.files.retire(c, tuple, "")
		c.mu.Unlock()
		// Cleanup is independently dispatchable, even while Begin or a disk
		// chunk is pending. Its logical receipt never means files:[] was sent.
		result, err := c.filePrivate(ctx, fields, "fileChooserCancellation")
		err = errors.Join(err, c.waitFileScope(ctx, &tuple))
		return result, err
	}
	if operation == "humanFileBegin" {
		files, _, parseErr := managedprotocol.ParseHumanFiles(fields["files"])
		if parseErr != nil || !claim.metadata.Multiple && len(files) != 1 {
			c.mu.Unlock()
			return nil, fileError("INVALID")
		}
		claim.begun = true
		c.fileClaims[tuple] = claim
	}
	// Adds and retirement are ordered by c.mu; End rejects new admissions
	// before joining these original disk/claim/commit operations.
	done := c.startFileOperationLocked(tuple)
	c.mu.Unlock()
	defer c.finishFileOperation(tuple, done)
	switch operation {
	case "humanFileBegin":
		files, total, _ := managedprotocol.ParseHumanFiles(fields["files"])
		record, err := c.files.begin(c, tuple, files, total)
		if err != nil {
			return nil, err
		}
		c.mu.Lock()
		claim, err := c.currentFileLocked(tuple)
		if err == nil {
			claim.transferID = record.id
			c.fileClaims[tuple] = claim
		}
		c.mu.Unlock()
		if err != nil || ctx.Err() != nil {
			c.files.retire(c, tuple, record.id)
			return nil, fileError("STALE")
		}
		private := filePrivateFields(fields)
		private["transferId"], _ = json.Marshal(record.id)
		result, err := c.filePrivate(ctx, private, "fileChooserClaim")
		if err != nil {
			c.files.retire(c, tuple, record.id)
			return nil, err
		}
		c.mu.Lock()
		_, err = c.currentFileLocked(tuple)
		c.mu.Unlock()
		if err != nil {
			c.files.retire(c, tuple, record.id)
			return nil, err
		}
		envelope, _ := userObject(result)
		delete(envelope, "fileChooserClaim")
		envelope["fileTransfer"], _ = json.Marshal(managedprotocol.FileTransfer{FileChooserIdentity: tuple, TransferID: record.id, FileCount: uint64(len(files)), TotalBytes: total})
		return json.Marshal(envelope)
	case "humanFileChunk":
		var index, offset uint64
		_ = json.Unmarshal(fields["fileIndex"], &index)
		_ = json.Unmarshal(fields["offset"], &offset)
		data, _ := managedprotocol.DecodeHumanFileChunk(fields["data"])
		next, err := c.files.append(c, tuple, id, index, offset, data)
		if err != nil {
			return nil, err
		}
		c.mu.Lock()
		_, err = c.currentFileLocked(tuple)
		status := append(json.RawMessage(nil), c.fileStatus...)
		c.mu.Unlock()
		if err != nil || ctx.Err() != nil {
			return nil, fileError("STALE")
		}
		return json.Marshal(map[string]any{"status": status, "fileChunk": managedprotocol.FileChunk{FileChooserIdentity: tuple, TransferID: id, FileIndex: index, NextOffset: next}})
	case "humanFileCommit":
		return c.filePrivate(ctx, fields, "fileChooserReceipt")
	}
	return nil, fileError("INVALID")
}

func filePrivateFields(fields map[string]json.RawMessage) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage)
	for _, name := range []string{"operation", "leaseId", "generation", "chooserId", "transferId"} {
		if value := fields[name]; value != nil {
			out[name] = append(json.RawMessage(nil), value...)
		}
	}
	return out
}

func (c *UserController) filePrivate(ctx context.Context, fields map[string]json.RawMessage, receipt string) (json.RawMessage, error) {
	tuple := fileTuple(fields)
	params := filePrivateFields(fields)
	var operation, id string
	_ = json.Unmarshal(fields["operation"], &operation)
	_ = json.Unmarshal(fields["transferId"], &id)
	c.mu.Lock()
	if c.closing || userSubmissionError(ctx) != nil {
		c.mu.Unlock()
		return nil, fileError("STALE")
	}
	if operation != "humanFileCancel" {
		if _, err := c.currentFileLocked(tuple); err != nil {
			c.mu.Unlock()
			return nil, err
		}
	}
	if operation == "humanFileCommit" {
		paths, err := c.files.retain(c, tuple, id)
		if err != nil {
			c.mu.Unlock()
			return nil, err
		}
		claim := c.fileClaims[tuple]
		claim.terminal = true
		c.fileClaims[tuple] = claim
		params["files"], _ = json.Marshal(paths)
	}
	params["channelKey"], _ = json.Marshal(c.channelKey)
	call, err := c.evaluateLocked(ctx, "request", params)
	if err == nil {
		c.trackCallLocked(call)
	}
	c.mu.Unlock()
	if err != nil {
		return nil, err
	}
	data, err := call.wait(ctx)
	if err != nil && operation == "humanFileCommit" && errors.Is(context.Cause(ctx), managedprotocol.ErrHumanGenerationRetired) {
		// The original set-files may itself navigate. Only this already-sent
		// call retains its original deadline; never retry or admit new chunks.
		original := context.WithoutCancel(ctx)
		cancel := func() {}
		if deadline, ok := ctx.Deadline(); ok {
			original, cancel = context.WithDeadline(original, deadline)
		}
		data, err = call.wait(original)
		cancel()
	}
	if err != nil {
		return nil, err
	}
	result, err := bridgeValue(data)
	if err != nil {
		return nil, err
	}
	envelope, err := userObject(result)
	if err != nil || !managedprotocol.MatchFileResult(params, receipt, envelope[receipt]) {
		return nil, errors.New("original human file receipt mismatch")
	}
	c.mu.Lock()
	err = c.validateStatusLocked(envelope["status"])
	c.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (c *UserController) startFileOperationLocked(tuple managedprotocol.FileChooserIdentity) chan struct{} {
	if c.fileOperations == nil {
		c.fileOperations = make(map[managedprotocol.FileChooserIdentity]map[chan struct{}]bool)
	}
	if c.fileOperations[tuple] == nil {
		c.fileOperations[tuple] = make(map[chan struct{}]bool)
	}
	done := make(chan struct{})
	c.fileOperations[tuple][done] = true
	return done
}
func (c *UserController) finishFileOperation(tuple managedprotocol.FileChooserIdentity, done chan struct{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.fileOperations[tuple], done)
	if len(c.fileOperations[tuple]) == 0 {
		delete(c.fileOperations, tuple)
	}
	close(done)
}
func (c *UserController) waitFiles(ctx context.Context) error { return c.waitFileScope(ctx, nil) }
func (c *UserController) waitFileScope(ctx context.Context, tuple *managedprotocol.FileChooserIdentity) error {
	if c.files == nil {
		return nil
	}
	c.mu.Lock()
	var pending []<-chan struct{}
	for identity, operations := range c.fileOperations {
		if tuple == nil || *tuple == identity {
			for done := range operations {
				pending = append(pending, done)
			}
		}
	}
	c.mu.Unlock()
	for _, done := range pending {
		select {
		case <-done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return c.files.waitRetired(ctx, c, tuple)
}
