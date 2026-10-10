//go:build windows

package transport

import (
	"fmt"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestNamedPipeHasCurrentUserOnlyProtectedACL(t *testing.T) {
	path := NewEndpoint("", fmt.Sprintf("acl-%d-%d", os.Getpid(), time.Now().UnixNano()))
	listener, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() { conn, _ := listener.Accept(); accepted <- conn }()
	client, err := DialTimeout(path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server := <-accepted
	if server == nil {
		t.Fatal("pipe accept failed")
	}
	defer server.Close()
	fd := client.(interface{ Fd() uintptr }).Fd()
	sd, err := windows.GetSecurityInfo(windows.Handle(fd), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sddl := sd.String()
	if !strings.Contains(sddl, "D:P") || strings.Count(sddl, "(") != 1 || !strings.Contains(sddl, ";;;"+user.User.Sid.String()+")") {
		t.Fatalf("unexpected pipe permissions: %s", sddl)
	}
	if second, err := Listen(path); err == nil {
		second.Close()
		t.Fatal("must not replace a live pipe")
	}
}
