package main

import (
	"fmt"
	"strconv"
	"strings"
)

func backgroundWindowParams(enabled bool) map[string]any {
	if enabled {
		return map[string]any{"backgroundWindow": true}
	}
	return map[string]any{}
}

// Remove the creation-only flag before the shared positional URL parser runs.
func backgroundWindowArg(args []string) (bool, []string, error) {
	enabled := false
	cleaned := make([]string, 0, len(args))
	for _, arg := range args {
		if arg == "--background-window" {
			enabled = true
			continue
		}
		if value, ok := strings.CutPrefix(arg, "--background-window="); ok {
			parsed, err := strconv.ParseBool(value)
			if err != nil {
				return false, nil, fmt.Errorf("invalid --background-window boolean: %w", err)
			}
			enabled = parsed
			continue
		}
		cleaned = append(cleaned, arg)
	}
	return enabled, cleaned, nil
}
