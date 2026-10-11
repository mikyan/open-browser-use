package obu

import (
	"errors"
	"time"
)

// CreateTabOptions explicitly opts into a new unfocused window for this tab.
// False preserves the original createTab wire request.
type CreateTabOptions struct{ BackgroundWindow bool }
type NewTabOptions struct {
	URL              string
	WaitUntil        string
	Timeout          time.Duration
	BackgroundWindow bool
}

func ValidateCreateTabParams(params Params) error {
	if value, exists := params["backgroundWindow"]; exists {
		if _, valid := value.(bool); !valid {
			return errors.New("backgroundWindow must be a boolean")
		}
	}
	return nil
}
func createTabParams(backgroundWindow bool) Params {
	if backgroundWindow {
		return Params{"backgroundWindow": true}
	}
	return Params{}
}
func (c *Client) CreateTabWithOptions(options CreateTabOptions) (any, error) {
	return c.Request("createTab", createTabParams(options.BackgroundWindow))
}
func (c *Client) requireBackgroundWindow(scope Params, deadline time.Time) error {
	info, err := c.requestLocked("getInfo", scopedParams(scope, nil), deadline)
	if err != nil {
		return err
	}
	object, _ := info.(map[string]any)
	metadata, _ := object["metadata"].(map[string]any)
	if metadata["backgroundWindowVersion"] != float64(1) {
		return errors.New("OBU_BACKGROUND_WINDOW_UNSUPPORTED: extension does not advertise backgroundWindowVersion 1")
	}
	return nil
}
