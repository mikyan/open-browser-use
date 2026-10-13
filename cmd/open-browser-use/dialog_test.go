package main

import "testing"

func TestDialogNamedMCPToolsPresent(t *testing.T) {
	for _, name := range []string{"arm_dialog", "collect_dialog", "cancel_dialog"} {
		found := false
		for _, tool := range mcpTools() {
			if tool.Name == name {
				found = true
			}
		}
		if !found {
			t.Errorf("missing named tool %s", name)
		}
	}
}
