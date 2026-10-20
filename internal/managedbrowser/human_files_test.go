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

func TestHumanDirectoryStagingReturnsOneRootAndRetainsOriginalTree(t *testing.T) {
	store := newHumanFiles(filepath.Join(t.TempDir(), "u"))
	owner := &UserController{}
	tuple := managedprotocol.FileChooserIdentity{LeaseID: "l", Generation: 1, ChooserID: "directory"}
	files := []managedprotocol.HumanFile{
		{Name: "同名.txt", Size: 3, RelativePath: "资料/甲/同名.txt"},
		{Name: "同名.txt", Size: 2, RelativePath: "资料/乙/同名.txt"},
		{Name: "空.txt", Size: 0, RelativePath: "资料/空.txt"},
	}
	r, err := store.begin(owner, tuple, files, 5)
	if err != nil {
		t.Fatal(err)
	}
	for i, bytes := range [][]byte{{0, 255, 7}, {1, 2}} {
		if _, err := store.append(owner, tuple, r.id, uint64(i), 0, bytes); err != nil {
			t.Fatal(err)
		}
	}
	paths, err := store.retain(owner, tuple, r.id)
	if err != nil || len(paths) != 1 || paths[0] != filepath.Join(r.dir, "资料") {
		t.Fatal("commit did not return the one owned directory root", paths, err)
	}
	store.retireExcept(owner, nil)
	for i, bytes := range [][]byte{{0, 255, 7}, {1, 2}, {}} {
		path := filepath.Join(r.dir, filepath.FromSlash(files[i].RelativePath))
		got, err := os.ReadFile(path)
		if err != nil || string(got) != string(bytes) {
			t.Fatal("original file hierarchy or bytes changed after End", path, err)
		}
	}
	// Cancelling a later chooser must not remove the previous selection's tree.
	next := tuple
	next.ChooserID = "cancelled"
	uncommitted, err := store.begin(owner, next, files, 5)
	if err != nil {
		t.Fatal(err)
	}
	store.retire(owner, next, "")
	if err := store.waitRetired(context.Background(), owner, &next); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(uncommitted.dir); !os.IsNotExist(err) {
		t.Fatal("cancelled tree survives", err)
	}
	if _, err := os.Stat(paths[0]); err != nil {
		t.Fatal("cancel removed previous committed directory", err)
	}
	if err := store.closeAfterBrowser(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(paths[0]); !os.IsNotExist(err) {
		t.Fatal("Browser exit retained directory", err)
	}
}

func TestHumanDirectoryRevocationWaitsRealNestedWrite(t *testing.T) {
	for _, reason := range []string{"cancel", "navigation", "end"} {
		t.Run(reason, func(t *testing.T) {
			store := newHumanFiles(filepath.Join(t.TempDir(), "u"))
			owner := &UserController{}
			tuple := managedprotocol.FileChooserIdentity{LeaseID: "l", Generation: 1, ChooserID: "c"}
			r, err := store.begin(owner, tuple, []managedprotocol.HumanFile{{Name: "a", Size: 1, RelativePath: "root/nested/a"}}, 1)
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
			go func() { _, err := store.append(owner, tuple, r.id, 0, 0, []byte("x")); done <- err }()
			<-entered
			switch reason {
			case "cancel":
				store.retire(owner, tuple, r.id)
			case "navigation":
				next := managedprotocol.PendingFileChooser{FileChooserIdentity: tuple, Directory: true}
				next.Generation++
				store.retireExcept(owner, &next)
			case "end":
				store.retire(owner, managedprotocol.FileChooserIdentity{}, "")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
			defer cancel()
			if store.waitRetired(ctx, owner, &tuple) == nil {
				t.Fatal("revocation pretended the actual write ended")
			}
			if _, err := store.retain(owner, tuple, r.id); err == nil {
				t.Fatal("revoked tree committed")
			}
			once.Do(func() { close(release) })
			if err := <-done; err == nil {
				t.Fatal("late write resurrected directory")
			}
			if err := store.waitRetired(context.Background(), owner, &tuple); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(r.dir); !os.IsNotExist(err) {
				t.Fatal("nested staging remains", err)
			}
			if err := store.closeAfterBrowser(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestHumanDirectoryStorageRejectsManifestAndChangedDiskBeforeCommit(t *testing.T) {
	store := newHumanFiles(filepath.Join(t.TempDir(), "u"))
	defer func() {
		if err := store.closeAfterBrowser(); err != nil {
			t.Error(err)
		}
	}()
	owner := &UserController{}
	tuple := managedprotocol.FileChooserIdentity{LeaseID: "l", Generation: 1, ChooserID: "c"}
	for _, files := range [][]managedprotocol.HumanFile{
		{{Name: "a", RelativePath: "root/../a"}},
		{{Name: "a", RelativePath: "root/a"}, {Name: "b", RelativePath: "ROOT/b"}},
		{{Name: "a", RelativePath: "root/a"}, {Name: "a", RelativePath: "root/a"}},
	} {
		if _, err := store.begin(owner, tuple, files, 0); err == nil {
			t.Fatal("store created ambiguous caller path")
		}
	}
	if len(store.records) != 0 {
		t.Fatal("rejected manifests consumed transfers")
	}
	r, err := store.begin(owner, tuple, []managedprotocol.HumanFile{{Name: "a", RelativePath: "root/a"}}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(r.paths[0], []byte("unexpected"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.retain(owner, tuple, r.id); err == nil {
		t.Fatal("changed on-disk bytes committed")
	}
	if r.retained {
		t.Fatal("failed precommit validation retained directory")
	}
}

func TestHumanDirectoryCreationUsesExclusiveFiles(t *testing.T) {
	store := newHumanFiles(filepath.Join(t.TempDir(), "u"))
	r := &humanFileRecord{id: "owned-transfer", dir: filepath.Join(store.root, "owned-transfer"), done: make(chan struct{})}
	r.directoryRoot = filepath.Join(r.dir, "root")
	// Bypass admission solely to exercise the storage layer's independent
	// exclusive-create defense against a duplicate leaf in its own private tree.
	r.files = []managedprotocol.HumanFile{{Name: "a", RelativePath: "root/a"}, {Name: "a", RelativePath: "root/a"}}
	if err := store.create(r); !os.IsExist(err) {
		t.Fatal("duplicate leaf did not fail exclusive creation", err)
	}
	if len(r.paths) != 1 {
		t.Fatal("conflicting file was reported created")
	}
	store.records[r.id] = r
	if err := store.closeAfterBrowser(); err != nil {
		t.Fatal(err)
	}
}

func TestHumanDirectoryChunkRechecksActualAncestors(t *testing.T) {
	store := newHumanFiles(filepath.Join(t.TempDir(), "u"))
	owner := &UserController{}
	tuple := managedprotocol.FileChooserIdentity{LeaseID: "l", Generation: 1, ChooserID: "c"}
	r, err := store.begin(owner, tuple, []managedprotocol.HumanFile{{Name: "a", Size: 1, RelativePath: "root/nested/a"}}, 1)
	if err != nil {
		t.Fatal(err)
	}
	// Replace only this test's empty nested directory with an ordinary file.
	// A remembered textual path must not bypass its current ancestor checks.
	if err := os.Remove(r.paths[0]); err != nil {
		t.Fatal(err)
	}
	parent := filepath.Dir(r.paths[0])
	if err := os.Remove(parent); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(parent, []byte("ordinary ancestor"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.append(owner, tuple, r.id, 0, 0, []byte("x")); err == nil {
		t.Fatal("chunk ignored changed on-disk ancestor")
	}
	if err := store.waitRetired(context.Background(), owner, &tuple); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(r.dir); !os.IsNotExist(err) {
		t.Fatal("failed write retained its uncommitted tree", err)
	}
	if err := store.closeAfterBrowser(); err != nil {
		t.Fatal(err)
	}
}
