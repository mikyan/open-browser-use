package managedviewer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
)

// These exercise the real HTTP/WebSocket admission and projection with an
// explicitly simulated backend, not native file selection or upload acceptance.
func viewerFileState(chooser string, sequence uint64) json.RawMessage {
	f, _ := object(humanTestState(true, 0))
	state, _ := object(f["status"])
	h, _ := object(state["human"])
	h["fileChooserVersion"] = jsonBytes(1)
	state["human"], state["eventSequence"] = jsonBytes(h), jsonBytes(sequence)
	state["pendingFileChooser"] = jsonBytes(nil)
	if chooser != "" {
		state["pendingFileChooser"] = jsonBytes(map[string]any{
			"leaseId": humanTestLease, "generation": 1, "chooserId": chooser, "multiple": true,
			"source": map[string]any{"origin": "https://fixture.invalid", "frame": "child"},
		})
	}
	f["status"] = jsonBytes(state)
	return jsonBytes(f)
}

func viewerFileRequest(id uint64, operation, extra string) string {
	return fmt.Sprintf(`{"id":%d,"operation":%q,"leaseId":%q,"generation":1,"chooserId":"chooser"%s}`, id, operation, humanTestLease, extra)
}

func viewerFileReply(request json.RawMessage, chooser string, sequence uint64) json.RawMessage {
	f, _ := object(viewerFileState(chooser, sequence))
	fields, _ := object(request)
	receipt := map[string]any{"leaseId": fields["leaseId"], "generation": fields["generation"], "chooserId": fields["chooserId"]}
	var key string
	switch humanTestOperation(request) {
	case "humanFileBegin":
		key = "fileTransfer"
		receipt["transferId"], receipt["fileCount"], receipt["totalBytes"] = "transfer", 2, 3
	case "humanFileChunk":
		key = "fileChunk"
		receipt["transferId"], receipt["fileIndex"], receipt["nextOffset"] = fields["transferId"], fields["fileIndex"], 3
	case "humanFileCommit":
		key = "fileChooserReceipt"
		receipt["transferId"], receipt["acknowledged"] = fields["transferId"], true
	case "humanFileCancel":
		key = "fileChooserCancellation"
		receipt["cancelled"] = true
		if fields["transferId"] != nil {
			receipt["transferId"] = fields["transferId"]
		}
	}
	f[key] = jsonBytes(receipt)
	return jsonBytes(f)
}

func viewerFileBackend() *testBackend {
	b := humanTestBackend()
	base := b.command
	b.command = func(ctx context.Context, request json.RawMessage) (json.RawMessage, error) {
		switch humanTestOperation(request) {
		case "humanBegin", "status":
			return viewerFileState("chooser", 2), nil
		case "humanFileBegin", "humanFileChunk":
			return viewerFileReply(request, "chooser", 5), nil
		case "humanFileCommit", "humanFileCancel":
			return viewerFileReply(request, "", 6), nil
		}
		return base(ctx, request)
	}
	return b
}

const viewerFileMetadata = `,"files":[{"name":"same.txt","size":0},{"name":"same.txt","size":3}]`

const viewerDirectoryMetadata = `,"files":[{"name":"same.txt","size":0,"relativePath":"资料/甲/same.txt"},{"name":"same.txt","size":3,"relativePath":"资料/乙/same.txt"}]`

func viewerFileVersion(data json.RawMessage, version uint64, directory, multiple bool) json.RawMessage {
	f, _ := object(data)
	state, _ := object(f["status"])
	if string(state["human"]) != "null" {
		h, _ := object(state["human"])
		h["fileChooserVersion"] = jsonBytes(version)
		state["human"] = jsonBytes(h)
	}
	if string(state["pendingFileChooser"]) != "null" && state["pendingFileChooser"] != nil {
		chooser, _ := object(state["pendingFileChooser"])
		chooser["multiple"] = jsonBytes(multiple)
		delete(chooser, "directory")
		if version == 2 {
			chooser["directory"] = jsonBytes(directory)
		}
		state["pendingFileChooser"] = jsonBytes(chooser)
	}
	f["status"] = jsonBytes(state)
	return jsonBytes(f)
}

func viewerVersionedFileBackend(version uint64, directory, multiple bool) *testBackend {
	b := viewerFileBackend()
	base := b.command
	b.command = func(ctx context.Context, request json.RawMessage) (json.RawMessage, error) {
		data, err := base(ctx, request)
		if err != nil {
			return nil, err
		}
		return viewerFileVersion(data, version, directory, multiple), nil
	}
	return b
}

func TestHumanFilesWebSocketRoundTripAndStrictOriginalReceipts(t *testing.T) {
	b := viewerFileBackend()
	c := humanTestBegin(t, b, startTest(t, b, nil))
	for i, operation := range []string{"humanFileBegin", "humanFileChunk", "humanFileCommit"} {
		extra := viewerFileMetadata
		key := "fileTransfer"
		if operation == "humanFileChunk" {
			extra, key = `,"transferId":"transfer","fileIndex":1,"offset":0,"data":"YWJj"`, "fileChunk"
		} else if operation == "humanFileCommit" {
			extra, key = `,"transferId":"transfer"`, "fileChooserReceipt"
		}
		id := uint64(i + 2)
		send(t, c, viewerFileRequest(id, operation, extra))
		humanTestCall(t, b, operation)
		result, _ := object(humanTestSuccess(t, c, id))
		if result[key] == nil || strings.Contains(string(result[key]), "path") {
			t.Fatalf("missing exact public receipt or private paths: %s", result[key])
		}
	}
	send(t, c, viewerFileRequest(5, "humanFileCommit", `,"transferId":"transfer"`))
	humanTestError(t, c, 5, "HUMAN_FILE_STALE")
}

func TestHumanFileCancelBypassesInputAndPendingBeginWithoutLateRevival(t *testing.T) {
	b := viewerFileBackend()
	base := b.command
	inputRelease, beginRelease := make(chan struct{}), make(chan struct{})
	var inputOnce, beginOnce sync.Once
	b.command = func(ctx context.Context, request json.RawMessage) (json.RawMessage, error) {
		switch humanTestOperation(request) {
		case "humanInput":
			<-inputRelease
			return humanTestInputResult(request), nil
		case "humanFileBegin":
			<-beginRelease
			return viewerFileReply(request, "chooser", 4), nil
		}
		return base(ctx, request)
	}
	s := startTest(t, b, nil)
	t.Cleanup(func() {
		inputOnce.Do(func() { close(inputRelease) })
		beginOnce.Do(func() { close(beginRelease) })
	})
	c := humanTestBegin(t, b, s)
	send(t, c, humanTestInput(2, 1))
	humanTestCall(t, b, "humanInput")
	send(t, c, viewerFileRequest(3, "humanFileBegin", viewerFileMetadata))
	humanTestCall(t, b, "humanFileBegin")
	send(t, c, viewerFileRequest(4, "humanFileCancel", ""))
	humanTestCall(t, b, "humanFileCancel")
	humanTestSuccess(t, c, 4)
	beginOnce.Do(func() { close(beginRelease) })
	humanTestSuccess(t, c, 3) // Original receipt does not reactivate its claim.
	send(t, c, viewerFileRequest(5, "humanFileChunk", `,"transferId":"transfer","fileIndex":1,"offset":0,"data":"YWJj"`))
	humanTestError(t, c, 5, "HUMAN_FILE_STALE")
	send(t, c, fmt.Sprintf(`{"id":6,"operation":"humanEnd","leaseId":%q}`, humanTestLease))
	humanTestCall(t, b, "humanEnd")
	humanTestSuccess(t, c, 6)
	inputOnce.Do(func() { close(inputRelease) })
	humanTestSuccess(t, c, 2) // An original input ACK remains its original ACK.
}

func TestHumanFileForeignScopeAndMismatchedReceiptCannotSubmit(t *testing.T) {
	for _, bad := range []string{"lease", "generation", "chooser", "receipt"} {
		t.Run(bad, func(t *testing.T) {
			b := viewerFileBackend()
			base := b.command
			b.command = func(ctx context.Context, request json.RawMessage) (json.RawMessage, error) {
				result, err := base(ctx, request)
				if bad == "receipt" && humanTestOperation(request) == "humanFileBegin" {
					result = json.RawMessage(strings.Replace(string(result), `"fileCount":2`, `"fileCount":1`, 1))
				}
				return result, err
			}
			c := humanTestBegin(t, b, startTest(t, b, nil))
			request := viewerFileRequest(2, "humanFileBegin", viewerFileMetadata)
			switch bad {
			case "lease":
				request = strings.Replace(request, humanTestLease, "foreign", 1)
			case "generation":
				request = strings.Replace(request, `"generation":1`, `"generation":2`, 1)
			case "chooser":
				request = strings.Replace(request, `"chooserId":"chooser"`, `"chooserId":"foreign"`, 1)
			}
			send(t, c, request)
			if bad == "receipt" {
				humanTestCall(t, b, "humanFileBegin")
				humanTestError(t, c, 2, "OPERATION_UNCONFIRMED")
				humanTestCall(t, b, "select")
			} else {
				humanTestError(t, c, 2, "HUMAN_FILE_STALE")
				select {
				case call := <-b.calls:
					t.Fatalf("foreign file reached backend: %s", call)
				default:
				}
			}
		})
	}
}

func TestHumanFileCapabilityAndChooserMetadataRemainPinned(t *testing.T) {
	for _, change := range []string{"capability", "source", "multiple"} {
		t.Run(change, func(t *testing.T) {
			b := viewerFileBackend()
			c := humanTestBegin(t, b, startTest(t, b, nil))
			f, _ := object(viewerFileState("chooser", 5))
			state, _ := object(f["status"])
			if change == "capability" {
				h, _ := object(state["human"])
				delete(h, "fileChooserVersion")
				state["human"] = jsonBytes(h)
				state["pendingFileChooser"] = jsonBytes(nil)
			} else {
				chooser, _ := object(state["pendingFileChooser"])
				if change == "source" {
					delete(chooser, "source")
				} else {
					chooser["multiple"] = jsonBytes(false)
				}
				state["pendingFileChooser"] = jsonBytes(chooser)
			}
			f["status"] = jsonBytes(state)
			publishGeneration(b, jsonBytes(f))
			if change == "capability" {
				for string(readMessage(t, c)["type"]) != `"state"` {
				}
			} else {
				humanTestCall(t, b, "select")
			}
			send(t, c, viewerFileRequest(2, "humanFileBegin", viewerFileMetadata))
			humanTestError(t, c, 2, "HUMAN_FILE_STALE")
		})
	}
}

func TestHumanFileLegacyAdmissionAndOlderChooserState(t *testing.T) {
	b := humanTestBackend()
	c := humanTestBegin(t, b, startTest(t, b, nil))
	send(t, c, viewerFileRequest(2, "humanFileBegin", viewerFileMetadata))
	humanTestError(t, c, 2, "HUMAN_FILE_STALE")

	b2 := viewerFileBackend()
	base := b2.command
	b2.command = func(ctx context.Context, request json.RawMessage) (json.RawMessage, error) {
		if humanTestOperation(request) == "humanBegin" {
			return viewerFileState("chooser", 10), nil
		}
		return base(ctx, request)
	}
	c2 := humanTestBegin(t, b2, startTest(t, b2, nil))
	older, _ := object(viewerFileState("chooser", 9))
	state, _ := object(older["status"])
	chooser, _ := object(state["pendingFileChooser"])
	delete(chooser, "source")
	state["pendingFileChooser"] = jsonBytes(chooser)
	older["status"] = jsonBytes(state)
	publishGeneration(b2, jsonBytes(older))
	for string(readMessage(t, c2)["type"]) != `"state"` {
	}
	send(t, c2, viewerFileRequest(2, "humanFileBegin", viewerFileMetadata))
	humanTestCall(t, b2, "humanFileBegin")
	humanTestSuccess(t, c2, 2)
}

func TestHumanFileModuleServedFromOriginalViewer(t *testing.T) {
	s := startTest(t, newBackend(), nil)
	response, err := http.Get(s.origin + "/human-files.js")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/javascript") ||
		!strings.Contains(string(data), "globalThis.ManagedHumanFiles") {
		t.Fatal("original embedded file module was not served", response.StatusCode, err)
	}
}

func TestHumanFileOriginalCommitGetsViewerGenerationCauseAndKeepsLateReceipt(t *testing.T) {
	b := viewerFileBackend()
	base := b.command
	cause := make(chan error, 1)
	b.command = func(ctx context.Context, request json.RawMessage) (json.RawMessage, error) {
		if humanTestOperation(request) != "humanFileCommit" {
			return base(ctx, request)
		}
		<-ctx.Done()
		cause <- context.Cause(ctx)
		// Models the original UserController join: a native commit ACK remains
		// tied to the old chooser, never to the successor document.
		return viewerFileReply(request, "", 6), nil
	}
	c := humanTestBegin(t, b, startTest(t, b, nil))
	send(t, c, viewerFileRequest(2, "humanFileBegin", viewerFileMetadata))
	humanTestCall(t, b, "humanFileBegin")
	humanTestSuccess(t, c, 2)
	send(t, c, viewerFileRequest(3, "humanFileCommit", `,"transferId":"transfer"`))
	humanTestCall(t, b, "humanFileCommit")
	next, _ := object(viewerFileState("", 20))
	state, _ := object(next["status"])
	human, _ := object(state["human"])
	human["generation"], human["state"], human["viewport"] = jsonBytes(2), jsonBytes("navigating"), jsonBytes(nil)
	state["human"] = jsonBytes(human)
	next["status"] = jsonBytes(state)
	publishGeneration(b, jsonBytes(next))
	humanTestSuccess(t, c, 3)
	if got := <-cause; !errors.Is(got, managedprotocol.ErrHumanGenerationRetired) {
		t.Fatal("viewer did not preserve its actual generation-retirement cause", got)
	}
	send(t, c, viewerFileRequest(4, "humanFileCommit", `,"transferId":"transfer"`))
	humanTestError(t, c, 4, "HUMAN_FILE_STALE")
}

func TestHumanFileProjectionPreservesVersionedDirectoryMode(t *testing.T) {
	for _, mode := range []struct {
		name      string
		version   uint64
		directory bool
	}{{"v1", 1, false}, {"v2-file", 2, false}, {"v2-directory", 2, true}} {
		t.Run(mode.name, func(t *testing.T) {
			data := viewerFileVersion(viewerFileState("chooser", 2), mode.version, mode.directory, false)
			projected, err := publicState(data)
			if err != nil {
				t.Fatal(err)
			}
			fields, _ := object(projected)
			chooser, _ := object(fields["pendingFileChooser"])
			if mode.version == 1 && chooser["directory"] != nil || mode.version == 2 && string(chooser["directory"]) != fmt.Sprint(mode.directory) {
				t.Fatal("projection lost or invented directory mode", string(projected))
			}
			// A capable status without a chooser must still explicitly clear the
			// previous displayed chooser, including when its source omitted null.
			envelope, _ := object(data)
			state, _ := object(envelope["status"])
			delete(state, "pendingFileChooser")
			envelope["status"] = jsonBytes(state)
			projected, err = publicState(jsonBytes(envelope))
			if err != nil {
				t.Fatal(err)
			}
			fields, _ = object(projected)
			if string(fields["pendingFileChooser"]) != "null" {
				t.Fatal("missing explicit chooser retirement", string(projected))
			}
		})
	}
}

func TestHumanDirectoryWebSocketAdmissionUsesOriginalMode(t *testing.T) {
	for _, mode := range []struct {
		name      string
		version   uint64
		directory bool
	}{{"v1-file", 1, false}, {"v2-file", 2, false}, {"v2-directory-single-flag", 2, true}} {
		t.Run(mode.name, func(t *testing.T) {
			b := viewerVersionedFileBackend(mode.version, mode.directory, !mode.directory)
			c := humanTestBegin(t, b, startTest(t, b, nil))
			good, bad := viewerFileMetadata, viewerDirectoryMetadata
			if mode.directory {
				good, bad = bad, good
			}
			send(t, c, viewerFileRequest(2, "humanFileBegin", bad))
			humanTestError(t, c, 2, "HUMAN_FILE_INVALID")
			select {
			case call := <-b.calls:
				t.Fatalf("wrong manifest mode reached backend: %s", call)
			default:
			}
			// Rejection did not consume the one original chooser claim.
			send(t, c, viewerFileRequest(3, "humanFileBegin", good))
			original := humanTestCall(t, b, "humanFileBegin")
			if mode.directory && !strings.Contains(string(original), `"relativePath":"资料/乙/same.txt"`) {
				t.Fatal("original relative hierarchy was rewritten", string(original))
			}
			humanTestSuccess(t, c, 3)
			send(t, c, viewerFileRequest(4, "humanFileChunk", `,"transferId":"transfer","fileIndex":1,"offset":0,"data":"YWJj"`))
			humanTestCall(t, b, "humanFileChunk")
			humanTestSuccess(t, c, 4)
			send(t, c, viewerFileRequest(5, "humanFileCommit", `,"transferId":"transfer"`))
			humanTestCall(t, b, "humanFileCommit")
			result, _ := object(humanTestSuccess(t, c, 5))
			if result["fileChooserReceipt"] == nil {
				t.Fatal("missing original commit receipt")
			}
			send(t, c, viewerFileRequest(6, "humanFileCommit", `,"transferId":"transfer"`))
			humanTestError(t, c, 6, "HUMAN_FILE_STALE")
		})
	}
}

func TestHumanDirectoryModeChangeRevokesOriginalChooser(t *testing.T) {
	for _, original := range []bool{false, true} {
		t.Run(fmt.Sprint(original), func(t *testing.T) {
			b := viewerVersionedFileBackend(2, original, true)
			c := humanTestBegin(t, b, startTest(t, b, nil))
			changed := viewerFileVersion(viewerFileState("chooser", 5), 2, !original, true)
			publishGeneration(b, changed)
			humanTestCall(t, b, "select")
			metadata := viewerFileMetadata
			if original {
				metadata = viewerDirectoryMetadata
			}
			send(t, c, viewerFileRequest(2, "humanFileBegin", metadata))
			humanTestError(t, c, 2, "HUMAN_FILE_STALE")
		})
	}
}

func TestHumanDirectoryCancelPendingBeginCannotReviveTransfer(t *testing.T) {
	b := viewerVersionedFileBackend(2, true, false)
	base := b.command
	release := make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	b.command = func(ctx context.Context, request json.RawMessage) (json.RawMessage, error) {
		if humanTestOperation(request) == "humanFileBegin" {
			<-release
			return viewerFileVersion(viewerFileReply(request, "chooser", 4), 2, true, false), nil
		}
		return base(ctx, request)
	}
	c := humanTestBegin(t, b, startTest(t, b, nil))
	send(t, c, viewerFileRequest(2, "humanFileBegin", viewerDirectoryMetadata))
	humanTestCall(t, b, "humanFileBegin")
	send(t, c, viewerFileRequest(3, "humanFileCancel", ""))
	humanTestCall(t, b, "humanFileCancel")
	humanTestSuccess(t, c, 3)
	once.Do(func() { close(release) })
	humanTestSuccess(t, c, 2)
	send(t, c, viewerFileRequest(4, "humanFileChunk", `,"transferId":"transfer","fileIndex":1,"offset":0,"data":"YWJj"`))
	humanTestError(t, c, 4, "HUMAN_FILE_STALE")
}
