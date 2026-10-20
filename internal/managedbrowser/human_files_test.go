package managedbrowser

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
)

func TestHumanFilesSameNamesEmptyOriginalBytesAndRetention(t *testing.T) {
	store := newHumanFiles(filepath.Join(t.TempDir(), "u"))
	owner := &UserController{}
	tuple := managedprotocol.FileChooserIdentity{LeaseID: "l", Generation: 1, ChooserID: "c"}
	record, err := store.begin(owner, tuple, []managedprotocol.HumanFile{{Name: "相同.txt", Size: 0}, {Name: "相同.txt", Size: 3}}, 3)
	if err != nil {
		t.Fatal(err)
	}
	if record.paths[0] == record.paths[1] || filepath.Base(record.paths[0]) != "相同.txt" || filepath.Base(record.paths[1]) != "相同.txt" {
		t.Fatal("same names collided or were renamed")
	}
	if _, err := store.retain(owner, tuple, record.id); err == nil {
		t.Fatal("incomplete file submitted")
	}
	if _, err := store.append(owner, tuple, record.id, 1, 1, []byte{1}); err == nil {
		t.Fatal("out-of-order chunk accepted")
	}
	if _, err := store.append(&UserController{}, tuple, record.id, 1, 0, []byte{1}); err == nil {
		t.Fatal("replacement controller reused transfer")
	}
	if _, err := store.append(owner, tuple, record.id, 1, 0, []byte{0, 255, 7}); err != nil {
		t.Fatal(err)
	}
	paths, err := store.retain(owner, tuple, record.id)
	if err != nil {
		t.Fatal(err)
	}
	store.retire(owner, tuple, "")
	for i, expected := range [][]byte{{}, {0, 255, 7}} {
		got, err := os.ReadFile(paths[i])
		if err != nil || string(got) != string(expected) {
			t.Fatal("End removed or changed potentially submitted bytes", err)
		}
	}
	if _, err := store.retain(owner, tuple, record.id); err == nil {
		t.Fatal("commit repeated")
	}
	if err := store.closeAfterBrowser(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(paths[1]); !os.IsNotExist(err) {
		t.Fatal("Browser exit did not clean retained file", err)
	}
}

func TestHumanFilesRetireWaitsActualWriteAndRejectsLateSuccess(t *testing.T) {
	store := newHumanFiles(filepath.Join(t.TempDir(), "u"))
	owner := &UserController{}
	tuple := managedprotocol.FileChooserIdentity{LeaseID: "l", Generation: 1, ChooserID: "c"}
	record, err := store.begin(owner, tuple, []managedprotocol.HumanFile{{Name: "a", Size: 1}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	store.write = func(path string, data []byte, offset int64) error {
		close(entered)
		<-release
		return writeHumanChunk(path, data, offset)
	}
	go func() { _, err := store.append(owner, tuple, record.id, 0, 0, []byte("x")); done <- err }()
	<-entered
	store.retire(owner, tuple, "")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if err := store.waitRetired(ctx, owner, &tuple); err == nil {
		t.Fatal("cleanup invented before actual write")
	}
	if _, err := store.retain(owner, tuple, record.id); err == nil {
		t.Fatal("late commit admitted after End")
	}
	once.Do(func() { close(release) })
	if err := <-done; err == nil {
		t.Fatal("late write became a successful chunk")
	}
	if err := store.waitRetired(context.Background(), owner, &tuple); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(record.dir); !os.IsNotExist(err) {
		t.Fatal("original unsent staging remains")
	}
	if err := store.closeAfterBrowser(); err != nil {
		t.Fatal(err)
	}
}

func TestHumanFilesDeadlineDoesNotRefreshAndSessionQuota(t *testing.T) {
	store := newHumanFiles(filepath.Join(t.TempDir(), "u"))
	now := time.Now()
	store.now = func() time.Time { return now }
	owner := &UserController{}
	tuple := managedprotocol.FileChooserIdentity{LeaseID: "l", Generation: 1, ChooserID: "c"}
	record, err := store.begin(owner, tuple, []managedprotocol.HumanFile{{Name: "a", Size: 2}}, 2)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(humanFileLifetime - time.Second)
	if _, err := store.append(owner, tuple, record.id, 0, 0, []byte("x")); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Second)
	if _, err := store.append(owner, tuple, record.id, 0, 1, []byte("y")); err == nil {
		t.Fatal("chunk refreshed original deadline")
	}
	if err := store.waitRetired(context.Background(), owner, &tuple); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	store.bytes = managedprotocol.MaxHumanSessionBytes
	store.mu.Unlock()
	if _, err := store.begin(owner, tuple, []managedprotocol.HumanFile{{Name: "a", Size: 1}}, 1); err == nil {
		t.Fatal("session retained-byte limit ignored")
	}
	if err := store.closeAfterBrowser(); err != nil {
		t.Fatal(err)
	}
}

func TestCancelOldChooserDoesNotWaitForSuccessorWork(t *testing.T) {
	store := newHumanFiles(filepath.Join(t.TempDir(), "u"))
	c := &UserController{files: store}
	old := managedprotocol.FileChooserIdentity{LeaseID: "l", Generation: 1, ChooserID: "old"}
	next := managedprotocol.FileChooserIdentity{LeaseID: "l", Generation: 1, ChooserID: "next"}
	c.mu.Lock()
	oldDone, nextDone := c.startFileOperationLocked(old), c.startFileOperationLocked(next)
	c.mu.Unlock()
	done := make(chan error, 1)
	go func() { done <- c.waitFileScope(context.Background(), &old) }()
	c.finishFileOperation(old, oldDone)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("successor work blocked original cancellation")
	}
	c.finishFileOperation(next, nextDone)
}
