package managedbrowser

import (
	"context"
	"encoding/json"
	"errors"
)

// readOriginalBrowserVersion uses this controller's original Browser root,
// never an extension debugger session, navigator value, or previous controller.
// The private open envelope receives only these bounded native fields; the
// extension separately decides which exact runtime supports clipboard fencing.
func (c *UserController) readOriginalBrowserVersion(ctx context.Context) (map[string]string, error) {
	var data json.RawMessage
	if err := c.cdp.call(ctx, "", "Browser.getVersion", map[string]any{}, &data); err != nil {
		return nil, err
	}
	fields, err := userObject(data)
	if err != nil {
		return nil, errors.New("managed user original browser version is invalid")
	}
	version := make(map[string]string, 2)
	for _, name := range []string{"product", "revision"} {
		var value string
		if json.Unmarshal(fields[name], &value) != nil || len(value) < 1 || len(value) > 256 {
			return nil, errors.New("managed user original browser version is invalid")
		}
		for _, char := range []byte(value) {
			if char <= 32 || char >= 127 {
				return nil, errors.New("managed user original browser version is invalid")
			}
		}
		version[name] = value
	}
	return version, nil
}
