package browserdownloads

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func loopbackListeners(t *testing.T) (net.Listener, net.Listener, string) {
	t.Helper()
	ipv6, err := net.Listen("tcp6", "[::1]:0")
	if err != nil {
		t.Skipf("IPv6 loopback is unavailable: %v", err)
	}
	t.Cleanup(func() { _ = ipv6.Close() })
	port := strconv.Itoa(ipv6.Addr().(*net.TCPAddr).Port)
	ipv4, err := net.Listen("tcp4", "127.0.0.1:"+port)
	if err != nil {
		t.Fatal("cannot reserve corresponding IPv4 endpoint", err)
	}
	t.Cleanup(func() { _ = ipv4.Close() })
	return ipv4, ipv6, "ws://127.0.0.1:" + port + "/devtools/browser/test-browser"
}

func TestDiscoveredDualStackNeverRebindsAfterTCPConnected(t *testing.T) {
	for _, mode := range []string{"success", "denied", "redirect", "bad-upgrade", "reset", "identity"} {
		t.Run(mode, func(t *testing.T) {
			ipv4, ipv6, endpoint := loopbackListeners(t)
			var v4Upgrades, v6Upgrades atomic.Int32
			v6 := newPeerWithListener(t, "other-profile", nil, func(http.ResponseWriter, *http.Request) bool {
				v6Upgrades.Add(1)
				return true
			}, ipv6)
			v4 := newPeerWithListener(t, "original-profile", func(p *browserPeer, r nativeRequest) bool {
				if mode == "identity" && r.Method == "Runtime.evaluate" {
					wrong := testIdentity
					wrong.PortID = "other-native-port"
					p.respond(r, map[string]any{"result": map[string]any{"type": "object", "value": wrong}})
					return true
				}
				return false
			}, func(w http.ResponseWriter, r *http.Request) bool {
				v4Upgrades.Add(1)
				switch mode {
				case "denied":
					http.Error(w, "user denied original approval", http.StatusForbidden)
					return false
				case "redirect":
					http.Redirect(w, r, strings.Replace(v6.url(), "ws:", "http:", 1), http.StatusTemporaryRedirect)
					return false
				case "bad-upgrade":
					w.WriteHeader(http.StatusOK)
					return false
				case "reset":
					conn, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
					} else {
						_ = conn.Close()
					}
					return false
				}
				return true
			}, ipv4)
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			m, err := DialWithOptions(ctx, endpoint, testIdentity, DialOptions{LoopbackFallback: true})
			if mode == "success" {
				if err != nil {
					t.Fatal(err)
				}
				defer m.Close()
			} else if m != nil || err == nil {
				t.Fatal("failed original connection was replaced", m, err)
			}
			if v4Upgrades.Load() != 1 || v6Upgrades.Load() != 0 || len(v6.snapshot()) != 0 {
				t.Fatal("connection/permission/identity fallback", v4Upgrades.Load(), v6Upgrades.Load(), v6.snapshot())
			}
			if mode != "success" {
				for _, r := range v4.snapshot() {
					if r.Method == "Browser.setDownloadBehavior" {
						t.Fatal("failed identity configured downloads")
					}
				}
			}
		})
	}
}

func TestExplicitIPv4URLNeverFallsBackToIPv6(t *testing.T) {
	ipv4, ipv6, endpoint := loopbackListeners(t)
	_ = ipv4.Close()
	var upgrades atomic.Int32
	p := newPeerWithListener(t, "", nil, func(http.ResponseWriter, *http.Request) bool { upgrades.Add(1); return true }, ipv6)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for _, options := range []bool{false, true} {
		var m *Manager
		var err error
		if options {
			m, err = DialWithOptions(ctx, endpoint, testIdentity, DialOptions{LoopbackFallback: false})
		} else {
			m, err = Dial(ctx, endpoint, testIdentity)
		}
		if m != nil || err == nil {
			t.Fatal("explicit IPv4 endpoint fell back", m, err)
		}
	}
	if upgrades.Load() != 0 || len(p.snapshot()) != 0 {
		t.Fatal("explicit endpoint contacted IPv6", upgrades.Load())
	}
}

func refusedDialError() error {
	return &net.OpError{Op: "dial", Net: "tcp", Err: &os.SyscallError{Syscall: "connect", Err: connectionRefused}}
}

func TestDiscoveredLoopbackOnlyExactRefusalAllowsFallback(t *testing.T) {
	for _, tc := range []struct {
		name     string
		err      error
		fallback bool
	}{
		{"native-refused", refusedDialError(), true},
		{"text-is-not-native-error", errors.New("connection refused"), false},
		{"read-is-not-connect", &net.OpError{Op: "read", Net: "tcp", Err: connectionRefused}, false},
		{"bare-errno", connectionRefused, false},
		{"permission", &net.OpError{Op: "dial", Net: "tcp", Err: os.ErrPermission}, false},
		{"cancelled", context.Canceled, false},
		{"deadline", context.DeadlineExceeded, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			var calls []string
			fallbackErr := errors.New("original IPv6 failure")
			_, err := dialDiscoveredLoopback(ctx, "127.0.0.1:54321", func(actual context.Context, network, address string) (net.Conn, error) {
				deadline, _ := actual.Deadline()
				original, _ := ctx.Deadline()
				if !deadline.Equal(original) {
					t.Error("deadline renewed")
				}
				calls = append(calls, network+" "+address)
				if len(calls) == 1 {
					return nil, tc.err
				}
				return nil, fallbackErr
			})
			want := []string{"tcp4 127.0.0.1:54321"}
			if tc.fallback {
				want = append(want, "tcp6 [::1]:54321")
				if !errors.Is(err, fallbackErr) || !strings.Contains(err.Error(), "original IPv6 failure") {
					t.Fatal("lost IPv6 failure", err)
				}
			} else if err != tc.err {
				t.Fatal("original error changed", err)
			}
			if !reflect.DeepEqual(calls, want) {
				t.Fatal(calls, want)
			}
		})
	}
}

func TestDiscoveredLoopbackOriginalCancellationAndDeadline(t *testing.T) {
	for _, stage := range []string{"before-first", "after-refusal", "late-ipv4", "late-ipv6"} {
		t.Run(stage, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if stage == "before-first" {
				cancel()
			}
			client, server := net.Pipe()
			defer client.Close()
			defer server.Close()
			calls := 0
			conn, err := dialDiscoveredLoopback(ctx, "127.0.0.1:54321", func(context.Context, string, string) (net.Conn, error) {
				calls++
				if stage == "after-refusal" {
					cancel()
					return nil, refusedDialError()
				}
				if stage == "late-ipv6" && calls == 1 {
					return nil, refusedDialError()
				}
				cancel()
				return client, nil
			})
			if conn != nil || !errors.Is(err, context.Canceled) {
				t.Fatal(conn, err)
			}
			want := 1
			if stage == "before-first" {
				want = 0
			}
			if stage == "late-ipv6" {
				want = 2
			}
			if calls != want {
				t.Fatal("canceled setup continued", calls)
			}
			if strings.HasPrefix(stage, "late-") {
				_ = server.SetReadDeadline(time.Now().Add(time.Second))
				_, err := server.Read(make([]byte, 1))
				if err == nil || err.Error() != "EOF" {
					t.Fatal("late connection leaked", err)
				}
			}
		})
	}
	ctx := deadlineOnlyContext{context.Background(), time.Now().Add(20 * time.Millisecond)}
	calls := 0
	_, err := dialDiscoveredLoopback(ctx, "127.0.0.1:54321", func(context.Context, string, string) (net.Conn, error) {
		calls++
		afterDeadline(ctx.deadline.Add(time.Millisecond))
		return nil, refusedDialError()
	})
	if calls != 1 || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("expired deadline retried despite delayed cancellation", calls, err)
	}
}

func TestDiscoveredLoopbackOptionsRequireExactIPv4FileEndpoint(t *testing.T) {
	for _, endpoint := range []string{"ws://[::1]:9222/devtools/browser/id", "ws://127.0.0.2:9222/devtools/browser/id", "wss://127.0.0.1:9222/devtools/browser/id", "ws://localhost:9222/devtools/browser/id"} {
		if err := ValidateDialOptions(endpoint, DialOptions{LoopbackFallback: true}); err == nil {
			t.Fatal("invalid discovery endpoint accepted", endpoint)
		}
	}
}

func TestDiscoveredIPv6ApprovalUsesRemainingOriginalBudget(t *testing.T) {
	for _, mode := range []string{"deny", "expire-approval", "expire-identity"} {
		t.Run(mode, func(t *testing.T) {
			ipv4, ipv6, endpoint := loopbackListeners(t)
			_ = ipv4.Close()
			var upgrades atomic.Int32
			p := newPeerWithListener(t, "", func(_ *browserPeer, r nativeRequest) bool { return r.Method == "Target.getTargets" }, func(w http.ResponseWriter, r *http.Request) bool {
				upgrades.Add(1)
				if mode == "deny" {
					http.Error(w, "denied", http.StatusForbidden)
					return false
				}
				if mode == "expire-approval" {
					<-r.Context().Done()
					return false
				}
				timer := time.NewTimer(150 * time.Millisecond)
				defer timer.Stop()
				select {
				case <-timer.C:
					return true
				case <-r.Context().Done():
					return false
				}
			}, ipv6)
			ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
			defer cancel()
			m, err := DialWithOptions(ctx, endpoint, testIdentity, DialOptions{LoopbackFallback: true})
			if m != nil || err == nil {
				t.Fatal("unsuccessful setup became ready", m, err)
			}
			if mode != "deny" && !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal("original deadline lost", err)
			}
			if upgrades.Load() != 1 {
				t.Fatal("approval replayed", upgrades.Load())
			}
			requests := p.snapshot()
			if mode == "expire-identity" {
				if len(requests) != 1 || requests[0].Method != "Target.getTargets" {
					t.Fatal(requests)
				}
			} else if len(requests) != 0 {
				t.Fatal("failed approval sent native commands", requests)
			}
		})
	}
}

func TestDiscoveredIPv6OnlyBrowserKeepsOneIdentityAndConfiguration(t *testing.T) {
	ipv4, ipv6, endpoint := loopbackListeners(t)
	if err := ipv4.Close(); err != nil {
		t.Fatal(err)
	}
	var upgrades atomic.Int32
	p := newPeerWithListener(t, "original-profile", nil, func(_ http.ResponseWriter, r *http.Request) bool {
		upgrades.Add(1)
		if r.URL.Path != "/devtools/browser/test-browser" {
			t.Error("discovery changed original browser path", r.URL.Path)
		}
		return true
	}, ipv6)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	m, err := DialWithOptions(ctx, endpoint, testIdentity, DialOptions{LoopbackFallback: true})
	if err != nil {
		t.Fatal("IPv6-only discovered Browser could not bind", err)
	}
	defer m.Close()
	var methods []string
	for _, r := range p.snapshot() {
		methods = append(methods, r.Method)
	}
	want := []string{"Target.getTargets", "Target.attachToTarget", "Runtime.evaluate", "Target.detachFromTarget", "Browser.setDownloadBehavior"}
	if upgrades.Load() != 1 || !reflect.DeepEqual(methods, want) {
		t.Fatal("discovery retried HTTP/identity/configuration", upgrades.Load(), methods)
	}
}
