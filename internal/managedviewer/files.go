package managedviewer

import (
	"encoding/json"
	"errors"

	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
)

type viewerFileClaim struct {
	metadata   managedprotocol.PendingFileChooser
	transferID string
	begun      bool
	terminal   bool
}

func (c *connection) observeFileChooserLocked(chooser *managedprotocol.PendingFileChooser) error {
	if chooser != nil {
		claim, seen := c.fileClaims[chooser.FileChooserIdentity]
		if seen && claim.metadata != *chooser || !seen && len(c.fileClaims) >= 1024 {
			return &dialogSourceStateError{epoch: c.humanEpoch}
		}
		if !seen {
			if c.fileClaims == nil {
				c.fileClaims = make(map[managedprotocol.FileChooserIdentity]viewerFileClaim)
			}
			c.fileClaims[chooser.FileChooserIdentity] = viewerFileClaim{metadata: *chooser}
		}
	}
	for tuple, claim := range c.fileClaims {
		if chooser == nil || chooser.FileChooserIdentity != tuple {
			claim.terminal = true
			c.fileClaims[tuple] = claim
		}
	}
	c.pendingFileChooser = chooser
	return nil
}

func (c *connection) admitFile(request *command) string {
	fields, _ := object(request.payload)
	var tuple managedprotocol.FileChooserIdentity
	_ = json.Unmarshal(request.payload, &tuple)
	var id string
	_ = json.Unmarshal(fields["transferId"], &id)
	c.controlMu.Lock()
	defer c.controlMu.Unlock()
	current := c.pendingFileChooser
	claim, seen := c.fileClaims[tuple]
	if !c.humanClaimed || c.humanStarting || c.humanRevoked || c.ctx.Err() != nil || c.humanFileVersion != 1 ||
		current == nil || current.FileChooserIdentity != tuple || !seen || claim.terminal ||
		tuple.LeaseID != c.humanLease || tuple.Generation != c.humanGeneration || tuple.Generation <= c.humanRetiredGeneration {
		return "HUMAN_FILE_STALE"
	}
	switch request.operation {
	case "humanFileBegin":
		files, _, err := managedprotocol.ParseHumanFiles(fields["files"])
		if err != nil || claim.begun || !current.Multiple && len(files) != 1 {
			return "HUMAN_FILE_INVALID"
		}
		claim.begun = true
	case "humanFileCancel":
		if id != "" && id != claim.transferID {
			return "HUMAN_FILE_STALE"
		}
		claim.terminal = true
	default:
		if !claim.begun || claim.transferID == "" || claim.transferID != id {
			return "HUMAN_FILE_STALE"
		}
		if request.operation == "humanFileCommit" {
			claim.terminal = true
		}
	}
	c.fileClaims[tuple] = claim
	request.ctx, request.epoch, request.generation = c.inputCtx, c.humanEpoch, c.humanGeneration
	if request.operation == "humanFileCancel" {
		request.ctx = c.humanCtx // independent cleanup, not the input lane
	}
	return ""
}

func (c *connection) acceptFileResult(request command, result map[string]json.RawMessage) error {
	key := map[string]string{"humanFileBegin": "fileTransfer", "humanFileChunk": "fileChunk",
		"humanFileCommit": "fileChooserReceipt", "humanFileCancel": "fileChooserCancellation"}[request.operation]
	fields, _ := object(request.payload)
	if !managedprotocol.MatchFileResult(fields, key, result[key]) {
		return errors.New("original human file receipt mismatch")
	}
	if request.operation == "humanFileBegin" {
		var receipt managedprotocol.FileTransfer
		_ = json.Unmarshal(result[key], &receipt)
		c.controlMu.Lock()
		defer c.controlMu.Unlock()
		claim, known := c.fileClaims[receipt.FileChooserIdentity]
		// An original reply remains a receipt, but cannot revive Cancel/End or
		// attach its transfer to a successor generation/connection.
		if known && !claim.terminal && request.epoch == c.humanEpoch && !c.humanRevoked &&
			receipt.LeaseID == c.humanLease && receipt.Generation == c.humanGeneration {
			if claim.transferID != "" && claim.transferID != receipt.TransferID {
				return errors.New("original human transfer identity changed")
			}
			claim.transferID = receipt.TransferID
			c.fileClaims[receipt.FileChooserIdentity] = claim
		}
	}
	return nil
}

func fileUnsentCode(err error) string {
	var coded interface{ UserErrorCode() string }
	if !errors.As(err, &coded) {
		return ""
	}
	switch coded.UserErrorCode() {
	case "OBU_HUMAN_FILE_STALE":
		return "HUMAN_FILE_STALE"
	case "OBU_HUMAN_FILE_INVALID", "OBU_HUMAN_FILE_LIMIT", "OBU_HUMAN_FILE_EXPIRED", "OBU_HUMAN_FILE_BUSY", "OBU_HUMAN_FILE_INCOMPLETE", "OBU_HUMAN_FILE_STORAGE":
		return "HUMAN_FILE_REJECTED"
	}
	return ""
}
