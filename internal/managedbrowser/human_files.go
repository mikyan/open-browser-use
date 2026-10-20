package managedbrowser

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
)

const humanFileLifetime = 10 * time.Minute

// humanFiles belongs to one owned Browser, not its replaceable worker/viewer.
// Once a private commit may have been sent, its files survive even a lost ACK.
type humanFiles struct {
	mu      sync.Mutex
	root    string
	records map[string]*humanFileRecord
	bytes   uint64
	closed  bool
	jobs    sync.WaitGroup
	errors  []error
	now     func() time.Time
	write   func(string, []byte, int64) error
}

type humanFileRecord struct {
	mu       sync.Mutex // actual disk operations, independent of caller timeout
	owner    *UserController
	identity managedprotocol.FileChooserIdentity
	id       string
	dir      string
	files    []managedprotocol.HumanFile
	paths    []string
	offsets  []uint64
	total    uint64
	deadline time.Time
	timer    *time.Timer
	busy     bool
	ready    bool
	retired  bool
	retained bool
	deleting bool
	done     chan struct{}
}

func newHumanFiles(root string) *humanFiles {
	return &humanFiles{root: root, records: make(map[string]*humanFileRecord), now: time.Now, write: writeHumanChunk}
}

func writeHumanChunk(path string, data []byte, offset int64) error {
	file, err := os.OpenFile(path, os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	n, writeErr := file.WriteAt(data, offset)
	if writeErr == nil && n != len(data) {
		writeErr = errors.New("short file write")
	}
	return errors.Join(writeErr, file.Close())
}

func fileError(code string) error { return &userBridgeError{code: "OBU_HUMAN_FILE_" + code} }

func (s *humanFiles) begin(owner *UserController, identity managedprotocol.FileChooserIdentity, files []managedprotocol.HumanFile, total uint64) (*humanFileRecord, error) {
	id, err := randomID()
	if err != nil {
		return nil, fileError("STORAGE")
	}
	s.mu.Lock()
	if s.closed || len(s.records) >= 128 || total > managedprotocol.MaxHumanSessionBytes-s.bytes {
		s.mu.Unlock()
		return nil, fileError("LIMIT")
	}
	for _, previous := range s.records {
		if previous.owner == owner && previous.identity == identity {
			s.mu.Unlock()
			return nil, fileError("STALE")
		}
	}
	r := &humanFileRecord{owner: owner, identity: identity, id: id, dir: filepath.Join(s.root, id),
		files: append([]managedprotocol.HumanFile(nil), files...), offsets: make([]uint64, len(files)), total: total,
		deadline: s.now().Add(humanFileLifetime), busy: true, done: make(chan struct{})}
	r.mu.Lock()
	s.records[id], s.bytes = r, s.bytes+total
	s.jobs.Add(1)
	s.mu.Unlock()
	defer s.jobs.Done()
	err = s.create(r)
	r.mu.Unlock()
	s.mu.Lock()
	r.busy = false
	if err == nil && !r.retired && !s.closed && s.now().Before(r.deadline) {
		r.ready = true
		r.timer = time.AfterFunc(r.deadline.Sub(s.now()), func() { s.retire(owner, identity, id) })
	} else {
		r.retired = true
		s.removeLocked(r)
	}
	live := r.ready && !r.retired
	s.mu.Unlock()
	if err != nil {
		return nil, fileError("STORAGE")
	}
	if !live {
		return nil, fileError("STALE")
	}
	return r, nil
}

func (s *humanFiles) create(r *humanFileRecord) error {
	if err := platformValidatePath(s.root); err != nil {
		return err
	}
	if err := os.MkdirAll(s.root, 0o700); err != nil {
		return err
	}
	if err := platformProtectDirectory(s.root); err != nil {
		return err
	}
	if err := os.Mkdir(r.dir, 0o700); err != nil {
		return err
	}
	for i, metadata := range r.files {
		directory := filepath.Join(r.dir, fmt.Sprint(i))
		if err := os.Mkdir(directory, 0o700); err != nil {
			return err
		}
		name := filepath.Join(directory, metadata.Name)
		if err := platformValidatePath(name); err != nil {
			return err
		}
		file, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return err
		}
		if err := file.Close(); err != nil {
			return err
		}
		r.paths = append(r.paths, name)
	}
	return nil
}

// lookupLocked never rebinds an old transfer to a replacement worker or chooser.
func (s *humanFiles) lookupLocked(owner *UserController, identity managedprotocol.FileChooserIdentity, id string) (*humanFileRecord, error) {
	r := s.records[id]
	if s.closed || r == nil || r.owner != owner || r.identity != identity || r.retired || r.retained || !r.ready {
		return nil, fileError("STALE")
	}
	if !s.now().Before(r.deadline) {
		r.retired = true
		s.removeLocked(r)
		return nil, fileError("EXPIRED")
	}
	return r, nil
}

func (s *humanFiles) append(owner *UserController, identity managedprotocol.FileChooserIdentity, id string, index, offset uint64, data []byte) (uint64, error) {
	s.mu.Lock()
	r, err := s.lookupLocked(owner, identity, id)
	if err == nil && (r.busy || index >= uint64(len(r.files)) || r.offsets[index] != offset || uint64(len(data)) > r.files[index].Size-offset) {
		err = fileError("INVALID")
	}
	if err == nil {
		for i := uint64(0); i < index; i++ {
			if r.offsets[i] != r.files[i].Size {
				err = fileError("INVALID")
			}
		}
	}
	if err != nil {
		s.mu.Unlock()
		return 0, err
	}
	r.busy = true
	r.mu.Lock()
	s.jobs.Add(1)
	s.mu.Unlock()
	defer s.jobs.Done()
	err = s.write(r.paths[index], data, int64(offset))
	r.mu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	r.busy = false
	if err != nil {
		r.retired = true
		s.removeLocked(r)
		return 0, fileError("STORAGE")
	}
	r.offsets[index] += uint64(len(data))
	if r.retired || s.closed || !s.now().Before(r.deadline) {
		r.retired = true
		s.removeLocked(r)
		return 0, fileError("STALE")
	}
	return r.offsets[index], nil
}

// retain is called under the original controller admission immediately before
// its private commit. Even an error/lost worker afterwards cannot delete files
// which a still-live page may read after End or a later Agent form submission.
func (s *humanFiles) retain(owner *UserController, identity managedprotocol.FileChooserIdentity, id string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, err := s.lookupLocked(owner, identity, id)
	if err != nil {
		return nil, err
	}
	if r.busy {
		return nil, fileError("BUSY")
	}
	for i, file := range r.files {
		if r.offsets[i] != file.Size {
			return nil, fileError("INCOMPLETE")
		}
	}
	r.retained = true
	if r.timer != nil {
		r.timer.Stop()
	}
	return append([]string(nil), r.paths...), nil
}

// Revocation is synchronous. Cleanup waits for the actual disk operation and
// does not occupy the native End/cancel lane.
func (s *humanFiles) retire(owner *UserController, identity managedprotocol.FileChooserIdentity, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.records {
		if r.owner == owner && (identity.LeaseID == "" || r.identity == identity) && (id == "" || r.id == id) && !r.retained {
			r.retired = true
			s.removeLocked(r)
		}
	}
}

func (s *humanFiles) retireExcept(owner *UserController, current *managedprotocol.PendingFileChooser) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.records {
		if r.owner == owner && !r.retained && (current == nil || current.FileChooserIdentity != r.identity) {
			r.retired = true
			s.removeLocked(r)
		}
	}
}

func (s *humanFiles) removeLocked(r *humanFileRecord) {
	if r.deleting || r.retained {
		return
	}
	r.deleting = true
	if r.timer != nil {
		r.timer.Stop()
	}
	s.jobs.Add(1)
	go func() {
		defer s.jobs.Done()
		defer close(r.done)
		r.mu.Lock()
		err := platformValidatePath(r.dir)
		if err == nil {
			err = os.RemoveAll(r.dir)
		}
		r.mu.Unlock()
		s.mu.Lock()
		defer s.mu.Unlock()
		if err != nil {
			s.errors = append(s.errors, errors.New("human upload staging cleanup failed"))
			return
		}
		delete(s.records, r.id)
		s.bytes -= r.total
	}()
}

// Only Session.shutdown may invoke this after the owned Browser/Job has ended,
// or after startup failed before any Browser was created.
func (s *humanFiles) closeAfterBrowser() error {
	s.mu.Lock()
	s.closed = true
	for _, r := range s.records {
		r.retired, r.retained = true, false
		s.removeLocked(r)
	}
	s.mu.Unlock()
	s.jobs.Wait()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.errors) != 0 || len(s.records) != 0 {
		return errors.Join(append(s.errors, errors.New("human upload cleanup unconfirmed"))...)
	}
	if err := platformValidatePath(s.root); err != nil {
		return err
	}
	if err := os.Remove(s.root); err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.New("human upload directory cleanup failed")
	}
	return nil
}

func (s *humanFiles) waitRetired(ctx context.Context, owner *UserController, tuple *managedprotocol.FileChooserIdentity) error {
	s.mu.Lock()
	var pending []<-chan struct{}
	for _, r := range s.records {
		if r.owner == owner && r.deleting && (tuple == nil || *tuple == r.identity) {
			pending = append(pending, r.done)
		}
	}
	s.mu.Unlock()
	for _, done := range pending {
		select {
		case <-done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.errors) != 0 {
		return errors.New("human upload cleanup unconfirmed")
	}
	return nil
}
