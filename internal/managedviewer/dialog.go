package managedviewer

import (
	"errors"

	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
)

// Dialog decisions use the bounded concurrent work lane, not the input lane:
// the dialog itself may prevent the original input's native ACK from arriving.
// A newer dialog also must not wait for a closed dialog's outstanding ACK.
func (c *connection) admitDialog(request *command) string {
	fields, err := object(request.payload)
	if err != nil {
		return "HUMAN_DIALOG_INVALID"
	}
	c.controlMu.Lock()
	defer c.controlMu.Unlock()
	dialog := c.pendingDialog
	// A proved dialog can precede geometry or the successor frame. The exact
	// pending tuple and original Begin admission authorize only this decision;
	// ordinary input still requires humanActive and its native frame.
	if !c.humanClaimed || c.humanStarting || c.humanRevoked || c.ctx.Err() != nil || dialog == nil ||
		dialog.LeaseID != c.humanLease || dialog.Generation != c.humanGeneration || dialog.Generation <= c.humanRetiredGeneration ||
		!managedprotocol.MatchDialogReceipt(fields, &managedprotocol.DialogReceipt{DialogIdentity: dialog.DialogIdentity, Acknowledged: true}) || c.dialogClaims[dialog.DialogIdentity] {
		return "HUMAN_DIALOG_STALE"
	}
	if !managedprotocol.MatchDialogResponse(fields, dialog) {
		return "HUMAN_DIALOG_INVALID"
	}
	if len(c.dialogClaims) >= 1024 {
		return "HUMAN_DIALOG_STALE"
	}
	if c.dialogClaims == nil {
		c.dialogClaims = make(map[managedprotocol.DialogIdentity]bool)
	}
	c.dialogClaims[dialog.DialogIdentity] = true
	// Generation changes revoke unsent decisions at the native boundary. A
	// submitted response retains its own receipt; it never borrows input ACKs.
	request.ctx, request.epoch, request.generation = c.humanCtx, c.humanEpoch, c.humanGeneration
	return ""
}

func dialogUnsentCode(err error) string {
	var coded interface{ UserErrorCode() string }
	if !errors.As(err, &coded) {
		return ""
	}
	switch coded.UserErrorCode() {
	case "OBU_HUMAN_DIALOG_STALE":
		return "HUMAN_DIALOG_STALE"
	case "OBU_HUMAN_DIALOG_INVALID":
		return "HUMAN_DIALOG_INVALID"
	}
	return ""
}
