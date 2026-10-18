package managedbrowser

import (
	"encoding/json"

	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
)

// Claim before submission, without waiting for the original input's reply.
// Claims survive late status and failed/cancelled callers; neither is permission
// to replay a decision. The native owner checks the original object again.
func (c *UserController) claimDialogLocked(fields map[string]json.RawMessage) error {
	dialog := c.pendingDialog
	if dialog == nil || !managedprotocol.MatchDialogReceipt(fields, &managedprotocol.DialogReceipt{DialogIdentity: dialog.DialogIdentity, Acknowledged: true}) || c.dialogClaims[dialog.DialogIdentity] {
		return &userBridgeError{code: "OBU_HUMAN_DIALOG_STALE"}
	}
	if !managedprotocol.MatchDialogResponse(fields, dialog) {
		return &userBridgeError{code: "OBU_HUMAN_DIALOG_INVALID"}
	}
	if len(c.dialogClaims) >= 1024 {
		return &userBridgeError{code: "OBU_HUMAN_DIALOG_STALE"}
	}
	if c.dialogClaims == nil {
		c.dialogClaims = make(map[managedprotocol.DialogIdentity]bool)
	}
	c.dialogClaims[dialog.DialogIdentity] = true
	return nil
}
