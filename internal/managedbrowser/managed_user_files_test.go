package managedbrowser

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
)

func fileFixtureState(f *userFixture, sequence uint64, chooser string) map[string]any {
	state := humanFixtureState(f)
	state["eventSequence"] = sequence
	state["human"].(map[string]any)["fileChooserVersion"] = 1
	state["pendingFileChooser"] = nil
	if chooser != "" {
		state["pendingFileChooser"] = map[string]any{"leaseId": "original-lease", "generation": 1, "chooserId": chooser, "multiple": true}
	}
	return state
}

func fileFixtureReply(f *userFixture, req userTestRequest, key string, state map[string]any) {
	receipt := map[string]json.RawMessage{}
	for _, name := range []string{"leaseId", "generation", "chooserId", "transferId"} {
		if req.Arguments[name] != nil {
			receipt[name] = req.Arguments[name]
		}
	}
	if key == "fileChooserReceipt" {
		receipt["acknowledged"] = json.RawMessage("true")
	} else if key == "fileChooserCancellation" {
		receipt["cancelled"] = json.RawMessage("true")
	}
	f.evaluated(req, map[string]any{"status": state, key: receipt})
}

func openFileFixture(t *testing.T, intercept func(*userFixture, userTestRequest) bool) (*UserController, *userFixture) {
	return openFileFixtureWithState(t, intercept, fileFixtureState)
}

func directoryFixtureState(f *userFixture, sequence uint64, chooser string) map[string]any {
	state := fileFixtureState(f, sequence, chooser)
	state["human"].(map[string]any)["fileChooserVersion"] = 2
	if chooser != "" {
		pending := state["pendingFileChooser"].(map[string]any)
		pending["directory"], pending["multiple"] = true, false
	}
	return state
}

func openFileFixtureWithState(t *testing.T, intercept func(*userFixture, userTestRequest) bool, state func(*userFixture, uint64, string) map[string]any) (*UserController, *userFixture) {
	t.Helper()
	store := newHumanFiles(filepath.Join(t.TempDir(), "u"))
	t.Cleanup(func() {
		if err := store.closeAfterBrowser(); err != nil {
			t.Error(err)
		}
	})
	f := newUserFixture(t, intercept, false)
	c := f.open()
	c.mu.Lock()
	c.files = store
	raw, _ := json.Marshal(state(f, 10, "chooser"))
	err := c.validateStatusLocked(raw)
	c.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	return c, f
}

func fileRequest(operation, extra string) json.RawMessage {
	return json.RawMessage(`{"operation":"` + operation + `","leaseId":"original-lease","generation":1,"chooserId":"chooser"` + extra + `}`)
}

func beginFixtureFiles(t *testing.T, c *UserController) string {
	t.Helper()
	result, err := c.Command(context.Background(), fileRequest("humanFileBegin", `,"files":[{"name":"same.txt","size":0},{"name":"same.txt","size":3}]`))
	if err != nil {
		t.Fatal(err)
	}
	var receipt struct{ FileTransfer managedprotocol.FileTransfer }
	_ = json.Unmarshal(result, &receipt)
	if receipt.FileTransfer.FileCount != 2 || receipt.FileTransfer.TotalBytes != 3 || receipt.FileTransfer.TransferID == "" {
		t.Fatal("missing staging receipt")
	}
	return receipt.FileTransfer.TransferID
}

func TestManagedFileBytesStayInGoAndCommitOwnPathsOnce(t *testing.T) {
	var requests []userTestRequest
	var mutex sync.Mutex
	c, _ := openFileFixture(t, func(f *userFixture, req userTestRequest) bool {
		if !managedprotocol.IsHumanFileOperation(req.Operation) {
			return false
		}
		mutex.Lock()
		requests = append(requests, req)
		mutex.Unlock()
		switch req.Operation {
		case "humanFileBegin":
			if req.Arguments["files"] != nil || req.Arguments["data"] != nil {
				t.Error("bytes or client metadata reached private claim")
			}
			fileFixtureReply(f, req, "fileChooserClaim", fileFixtureState(f, 11, "chooser"))
		case "humanFileCommit":
			var paths []string
			if json.Unmarshal(req.Arguments["files"], &paths) != nil || len(paths) != 2 || paths[0] == paths[1] {
				t.Fatal("wrong private paths")
			}
			for i, expected := range []string{"", "abc"} {
				data, err := os.ReadFile(paths[i])
				if err != nil || string(data) != expected || filepath.Base(paths[i]) != "same.txt" {
					t.Error("original bytes/name lost", err)
				}
			}
			fileFixtureReply(f, req, "fileChooserReceipt", fileFixtureState(f, 12, ""))
		default:
			t.Error("unexpected private file command", req.Operation)
		}
		return true
	})
	id := beginFixtureFiles(t, c)
	if _, err := c.Command(context.Background(), fileRequest("humanFileChunk", `,"transferId":"`+id+`","fileIndex":1,"offset":0,"data":"YWJj"`)); err != nil {
		t.Fatal(err)
	}
	result, err := c.Command(context.Background(), fileRequest("humanFileCommit", `,"transferId":"`+id+`"`))
	if err != nil {
		t.Fatal(err)
	}
	if string(result) == "" {
		t.Fatal("missing original ACK")
	}
	if _, err := c.Command(context.Background(), fileRequest("humanFileCommit", `,"transferId":"`+id+`"`)); err == nil {
		t.Fatal("native commit replayed")
	}
	mutex.Lock()
	defer mutex.Unlock()
	operations := []string{}
	for _, r := range requests {
		operations = append(operations, r.Operation)
	}
	if !reflect.DeepEqual(operations, []string{"humanFileBegin", "humanFileCommit"}) {
		t.Fatal("chunks left Go or commit repeated", operations)
	}
}

func TestManagedFileCancelWhileBeginPendingJoinsOriginalAndDoesNotRevive(t *testing.T) {
	held := make(chan userTestRequest, 1)
	cancelSent := make(chan struct{})
	c, f := openFileFixture(t, func(f *userFixture, req userTestRequest) bool {
		switch req.Operation {
		case "humanFileBegin":
			held <- req
			return true
		case "humanFileCancel":
			if req.Arguments["transferId"] != nil {
				t.Error("invented unknown transfer ID")
			}
			fileFixtureReply(f, req, "fileChooserCancellation", fileFixtureState(f, 12, ""))
			close(cancelSent)
			return true
		}
		return false
	})
	beginDone, cancelDone := make(chan error, 1), make(chan error, 1)
	go func() {
		_, err := c.Command(context.Background(), fileRequest("humanFileBegin", `,"files":[{"name":"empty","size":0}]`))
		beginDone <- err
	}()
	original := userWait(t, held)
	go func() {
		_, err := c.Command(context.Background(), fileRequest("humanFileCancel", ""))
		cancelDone <- err
	}()
	userWait(t, cancelSent)
	select {
	case <-cancelDone:
		t.Fatal("Cancel forgot original Begin claim call")
	default:
	}
	fileFixtureReply(f, original, "fileChooserClaim", fileFixtureState(f, 11, "chooser"))
	if err := userWait(t, beginDone); err == nil {
		t.Fatal("late Begin revived cancelled chooser")
	}
	if err := userWait(t, cancelDone); err != nil {
		t.Fatal(err)
	}
	c.files.mu.Lock()
	left := len(c.files.records)
	c.files.mu.Unlock()
	if left != 0 {
		t.Fatal("cancelled pending Begin left staging")
	}
}

func TestManagedFileCommitLateACKSurvivesEndButFilesWaitBrowserExit(t *testing.T) {
	commit := make(chan userTestRequest, 1)
	endSeen := make(chan struct{})
	c, f := openFileFixture(t, func(f *userFixture, req userTestRequest) bool {
		switch req.Operation {
		case "humanFileBegin":
			fileFixtureReply(f, req, "fileChooserClaim", fileFixtureState(f, 11, "chooser"))
			return true
		case "humanFileCommit":
			commit <- req
			return true
		case "humanEnd":
			state := fileFixtureState(f, 13, "")
			state["human"], state["selectedTabId"] = nil, nil
			state["humanCleanup"] = map[string]any{"leaseId": "original-lease", "cleanupConfirmed": true}
			f.evaluated(req, map[string]any{"status": state})
			close(endSeen)
			return true
		}
		return false
	})
	id := beginFixtureFiles(t, c)
	_, err := c.Command(context.Background(), fileRequest("humanFileChunk", `,"transferId":"`+id+`","fileIndex":1,"offset":0,"data":"YWJj"`))
	if err != nil {
		t.Fatal(err)
	}
	commitDone, endDone := make(chan error, 1), make(chan error, 1)
	go func() {
		_, err := c.Command(context.Background(), fileRequest("humanFileCommit", `,"transferId":"`+id+`"`))
		commitDone <- err
	}()
	original := userWait(t, commit)
	go func() {
		_, err := c.Command(context.Background(), json.RawMessage(`{"operation":"humanEnd","leaseId":"original-lease"}`))
		endDone <- err
	}()
	userWait(t, endSeen)
	select {
	case <-endDone:
		t.Fatal("End forgot original commit")
	default:
	}
	fileFixtureReply(f, original, "fileChooserReceipt", fileFixtureState(f, 12, ""))
	if err := userWait(t, commitDone); err != nil {
		t.Fatal("original ACK lost after End", err)
	}
	if err := userWait(t, endDone); err != nil {
		t.Fatal(err)
	}
	var paths []string
	_ = json.Unmarshal(original.Arguments["files"], &paths)
	if data, err := os.ReadFile(paths[1]); err != nil || string(data) != "abc" {
		t.Fatal("End destroyed uploaded bytes")
	}
}

func TestManagedFileReceiptMismatchAndTimeoutCannotReleaseAttemptedFiles(t *testing.T) {
	for _, mode := range []string{"wrong-id", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			committed := make(chan userTestRequest, 1)
			c, f := openFileFixture(t, func(f *userFixture, req userTestRequest) bool {
				switch req.Operation {
				case "humanFileBegin":
					fileFixtureReply(f, req, "fileChooserClaim", fileFixtureState(f, 11, "chooser"))
					return true
				case "humanFileCommit":
					committed <- req
					if mode == "wrong-id" {
						req.Arguments["transferId"] = json.RawMessage(`"foreign"`)
						fileFixtureReply(f, req, "fileChooserReceipt", fileFixtureState(f, 12, ""))
					}
					return true
				}
				return false
			})
			id := beginFixtureFiles(t, c)
			_, err := c.Command(context.Background(), fileRequest("humanFileChunk", `,"transferId":"`+id+`","fileIndex":1,"offset":0,"data":"YWJj"`))
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
			defer cancel()
			_, err = c.Command(ctx, fileRequest("humanFileCommit", `,"transferId":"`+id+`"`))
			if err == nil {
				t.Fatal("unknown or foreign commit ACK accepted")
			}
			original := userWait(t, committed)
			c.files.retire(c, managedprotocol.FileChooserIdentity{}, "")
			var paths []string
			_ = json.Unmarshal(original.Arguments["files"], &paths)
			if _, err := os.Stat(paths[1]); err != nil {
				t.Fatal("unknown native outcome deleted file", err)
			}
			if mode == "timeout" {
				fileFixtureReply(f, original, "fileChooserReceipt", fileFixtureState(f, 12, ""))
			}
		})
	}
}

func TestManagedFileCommitGenerationRetirementKeepsOriginalDeadlineAndACK(t *testing.T) {
	commit := make(chan userTestRequest, 1)
	c, f := openFileFixture(t, func(f *userFixture, req userTestRequest) bool {
		switch req.Operation {
		case "humanFileBegin":
			fileFixtureReply(f, req, "fileChooserClaim", fileFixtureState(f, 11, "chooser"))
			return true
		case "humanFileCommit":
			commit <- req
			return true
		}
		return false
	})
	id := beginFixtureFiles(t, c)
	if _, err := c.Command(context.Background(), fileRequest("humanFileChunk", `,"transferId":"`+id+`","fileIndex":1,"offset":0,"data":"YWJj"`)); err != nil {
		t.Fatal(err)
	}
	originalDeadline, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	ctx, retire := context.WithCancelCause(originalDeadline)
	defer retire(context.Canceled)
	done := make(chan error, 1)
	go func() {
		_, err := c.Command(ctx, fileRequest("humanFileCommit", `,"transferId":"`+id+`"`))
		done <- err
	}()
	original := userWait(t, commit)
	retire(managedprotocol.ErrHumanGenerationRetired)
	select {
	case err := <-done:
		fileFixtureReply(f, original, "fileChooserReceipt", fileFixtureState(f, 12, ""))
		t.Fatal("navigation discarded original native commit receipt", err)
	case <-time.After(20 * time.Millisecond):
	}
	fileFixtureReply(f, original, "fileChooserReceipt", fileFixtureState(f, 12, ""))
	if err := userWait(t, done); err != nil {
		t.Fatal("original native ACK lost", err)
	}
}

func TestManagedFileCloseCannotConfirmFailedStagingRemoval(t *testing.T) {
	f := newUserFixture(t, nil, false)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	identity := f.identity
	identity.ChannelID = ""
	c, err := openUserController(ctx, f.endpoint(), identity, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		f.ownerOnce.Do(func() { close(f.owner) })
		_ = c.Close(context.Background())
	})
	store := newHumanFiles(filepath.Join(t.TempDir(), "u"))
	c.mu.Lock()
	c.files = store
	c.mu.Unlock()
	record, err := store.begin(c, managedprotocol.FileChooserIdentity{LeaseID: "original-lease", Generation: 1, ChooserID: "chooser"}, []managedprotocol.HumanFile{{Name: "a", Size: 0}}, 0)
	if err != nil {
		t.Fatal(err)
	}
	// An unexpected non-directory ancestor makes the original removal fail;
	// this does not delete or address anything outside this test's own root.
	blocked := filepath.Join(store.root, "blocked")
	if err := os.WriteFile(blocked, []byte("ordinary file"), 0600); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	record.dir = filepath.Join(blocked, "child")
	store.mu.Unlock()
	closeErr := c.Close(ctx)
	userWait(t, c.cleanupDone)
	if closeErr == nil || errors.Is(closeErr, context.DeadlineExceeded) {
		t.Fatal("Close hid actual staging removal failure", closeErr)
	}
	if err := c.Close(ctx); err == nil {
		t.Fatal("completed transport cleanup erased staging failure")
	}
	c.mu.Lock()
	var receipt struct{ CleanupConfirmed bool }
	_ = json.Unmarshal(c.cleanupReceipt, &receipt)
	c.mu.Unlock()
	if receipt.CleanupConfirmed {
		t.Fatal("failed staging removal published cleanupConfirmed")
	}
}

func TestManagedDirectoryModeComesFromOriginalChooserBeforeBegin(t *testing.T) {
	for _, mode := range []string{"v1-file", "v2-file", "v2-directory"} {
		t.Run(mode, func(t *testing.T) {
			state := func(f *userFixture, n uint64, id string) map[string]any {
				if mode == "v1-file" {
					return fileFixtureState(f, n, id)
				}
				s := directoryFixtureState(f, n, id)
				if id != "" && mode == "v2-file" {
					s["pendingFileChooser"].(map[string]any)["directory"] = false
				}
				return s
			}
			c, _ := openFileFixtureWithState(t, func(f *userFixture, req userTestRequest) bool {
				if managedprotocol.IsHumanFileOperation(req.Operation) {
					t.Error("invalid mode reached native channel")
					return true
				}
				return false
			}, state)
			files := `[{"name":"a","size":0,"relativePath":"root/a"}]`
			if mode == "v2-directory" {
				files = `[{"name":"a","size":0}]`
			}
			if _, err := c.Command(context.Background(), fileRequest("humanFileBegin", `,"files":`+files)); err == nil {
				t.Fatal("manifest overrode native chooser mode")
			}
			c.mu.Lock()
			defer c.mu.Unlock()
			for _, claim := range c.fileClaims {
				if claim.begun {
					t.Fatal("invalid manifest consumed native claim")
				}
			}
			if len(c.files.records) != 0 {
				t.Fatal("invalid manifest allocated storage")
			}
		})
	}
}

func TestManagedDirectoryCommitUsesOneOwnedRootDespiteMultipleFalse(t *testing.T) {
	var committedRoot string
	c, _ := openFileFixtureWithState(t, func(f *userFixture, req userTestRequest) bool {
		switch req.Operation {
		case "humanFileBegin":
			if req.Arguments["files"] != nil || req.Arguments["relativePath"] != nil {
				t.Error("caller paths reached private claim")
			}
			fileFixtureReply(f, req, "fileChooserClaim", directoryFixtureState(f, 11, "chooser"))
			return true
		case "humanFileCommit":
			var roots []string
			if json.Unmarshal(req.Arguments["files"], &roots) != nil || len(roots) != 1 {
				t.Error("directory commit did not carry one root")
				return true
			}
			committedRoot = roots[0]
			if filepath.Base(committedRoot) != "资料" {
				t.Error("original root name lost")
			}
			for relative, want := range map[string]string{"甲/同名.txt": "abc", "乙/同名.txt": "", "空": ""} {
				data, err := os.ReadFile(filepath.Join(committedRoot, filepath.FromSlash(relative)))
				if err != nil || string(data) != want {
					t.Error("wrong original nested bytes", relative, err)
				}
			}
			fileFixtureReply(f, req, "fileChooserReceipt", directoryFixtureState(f, 12, ""))
			return true
		}
		return false
	}, directoryFixtureState)
	result, err := c.Command(context.Background(), fileRequest("humanFileBegin", `,"files":[{"name":"同名.txt","size":3,"relativePath":"资料/甲/同名.txt"},{"name":"同名.txt","size":0,"relativePath":"资料/乙/同名.txt"},{"name":"空","size":0,"relativePath":"资料/空"}]`))
	if err != nil {
		t.Fatal("directory wrongly interpreted as single-file chooser", err)
	}
	var receipt struct{ FileTransfer managedprotocol.FileTransfer }
	if err := json.Unmarshal(result, &receipt); err != nil {
		t.Fatal(err)
	}
	id := receipt.FileTransfer.TransferID
	if id == "" || receipt.FileTransfer.FileCount != 3 || receipt.FileTransfer.TotalBytes != 3 {
		t.Fatal("incorrect directory transfer receipt")
	}
	if _, err := c.Command(context.Background(), fileRequest("humanFileChunk", `,"transferId":"`+id+`","fileIndex":0,"offset":0,"data":"YWJj"`)); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Command(context.Background(), fileRequest("humanFileCommit", `,"transferId":"`+id+`"`)); err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	c.retireFilesLocked()
	c.mu.Unlock()
	if data, err := os.ReadFile(filepath.Join(committedRoot, "甲", "同名.txt")); err != nil || string(data) != "abc" {
		t.Fatal("revocation deleted already submitted tree", err)
	}
	if _, err := c.Command(context.Background(), fileRequest("humanFileCommit", `,"transferId":"`+id+`"`)); err == nil {
		t.Fatal("directory commit replayed")
	}
}

func TestManagedDirectoryChooserCannotChangeModeAtSameIdentity(t *testing.T) {
	c, f := openFileFixtureWithState(t, nil, directoryFixtureState)
	changed := directoryFixtureState(f, 11, "chooser")
	changed["pendingFileChooser"].(map[string]any)["directory"] = false
	raw, _ := json.Marshal(changed)
	c.mu.Lock()
	err := c.validateStatusLocked(raw)
	c.mu.Unlock()
	if err == nil {
		t.Fatal("original chooser directory mode changed")
	}
}
