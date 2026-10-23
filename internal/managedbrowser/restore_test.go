package managedbrowser

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func TestManagedRestoreArgumentsRequestNativeRestoreWithoutStartupNavigation(t *testing.T) {
	plain := browserArguments("owned-profile", "owned-extension", "owned-log", false)
	restored := browserArguments("owned-profile", "owned-extension", "owned-log", true)
	if !slices.Contains(plain, "about:blank") || slices.Contains(plain, "--restore-last-session") || slices.Contains(plain, "--hide-crash-restore-bubble") {
		t.Fatalf("default startup changed: %v", plain)
	}
	count, crashCount := 0, 0
	for _, arg := range restored {
		if arg == "--restore-last-session" {
			count++
		}
		if arg == "--hide-crash-restore-bubble" {
			crashCount++
		}
		if !strings.HasPrefix(arg, "--") {
			t.Fatalf("restore also navigates to a startup URL: %q", arg)
		}
	}
	if count != 1 || crashCount != 1 {
		t.Fatalf("native restore request count %d, explicit crash restore count %d", count, crashCount)
	}
	withoutBlank := slices.DeleteFunc(slices.Clone(plain), func(arg string) bool { return arg == "about:blank" })
	withoutRestore := slices.DeleteFunc(slices.Clone(restored), func(arg string) bool { return arg == "--restore-last-session" || arg == "--hide-crash-restore-bubble" })
	if !slices.Equal(withoutBlank, withoutRestore) {
		t.Fatalf("restore changed isolated browser configuration: %v / %v", plain, restored)
	}
	setup := setupBrowserArguments("owned-profile")
	if slices.Contains(setup, "--restore-last-session") || slices.Contains(setup, "--hide-crash-restore-bubble") || setup[len(setup)-1] != "about:blank" {
		t.Fatalf("manual setup requested session restore: %v", setup)
	}
}

func TestManagedRestoreRequiresExactNativeLaunchFlag(t *testing.T) {
	wanted := browserArguments("owned-profile", "owned-extension", "owned-log", true)
	if err := validateBrowserArguments(wanted, wanted); err != nil {
		t.Fatal(err)
	}
	for _, flag := range []string{"--restore-last-session", "--hide-crash-restore-bubble"} {
		for _, replacement := range []string{"", flag + "=false", flag + "=true"} {
			actual := slices.Clone(wanted)
			actual[slices.Index(actual, flag)] = replacement
			if err := validateBrowserArguments(actual, wanted); err == nil {
				t.Fatalf("accepted missing or changed original restore request: %q", replacement)
			}
		}
		if err := validateBrowserArguments(append(slices.Clone(wanted), flag), wanted); err == nil {
			t.Fatalf("accepted duplicate original restore request: %s", flag)
		}
	}
}

func TestManagedRestoreIntentSurvivesStatusWithoutGrantingAnEndpoint(t *testing.T) {
	for _, requested := range []bool{false, true} {
		for _, state := range []string{"ready", "degraded", "closed"} {
			s := Session{info: Info{RunID: "new-run", SocketPath: "original-endpoint", RestoreRequested: requested}, recovery: RecoveryStatus{State: state}}
			info := s.Info()
			if info.RunID != "new-run" || info.RestoreRequested != requested {
				t.Fatalf("restore intent changed run identity: %+v", info)
			}
			if state != "ready" && info.SocketPath != "" {
				t.Fatalf("restore intent exposed an unavailable endpoint: %+v", info)
			}
			data, err := json.Marshal(info)
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(data, &fields); err != nil {
				t.Fatal(err)
			}
			value, present := fields["restoreRequested"]
			if present != requested || requested && string(value) != "true" {
				t.Fatalf("unexpected restore intent publication: %s", data)
			}
			if _, present := fields["restored"]; present {
				t.Fatal("launch intent was published as a restoration result")
			}
		}
	}
}
