package obu

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"
)

// AISnapshotOptions may lower the extension's hard capture limits. Zero values
// omit an option. Timeout uses the normal action deadline plus response margin.
type AISnapshotOptions struct {
	MaxBytes, MaxNodes, MaxRefs, MaxFrames, MaxDepth int
	Timeout                                          time.Duration
	Boxes                                            bool
}

type AISnapshotStats struct {
	Bytes  int `json:"bytes"`
	Nodes  int `json:"nodes"`
	Refs   int `json:"refs"`
	Frames int `json:"frames"`
}

type AISnapshot struct {
	CaptureID string              `json:"captureId"`
	Snapshot  string              `json:"snapshot"`
	Refs      []string            `json:"refs"`
	Stats     AISnapshotStats     `json:"stats"`
	Complete  bool                `json:"complete"`
	Geometry  *AISnapshotGeometry `json:"geometry,omitempty"`
}

var aiRefPattern = regexp.MustCompile(`^(?:f[1-9][0-9]*)?e[1-9][0-9]*$`)

func validAIRef(ref string) bool { return len(ref) <= 64 && aiRefPattern.MatchString(ref) }

func aiCaptureLimits(option AISnapshotOptions) (Params, map[string]int, error) {
	limits := map[string]int{"maxBytes": 262144, "maxNodes": 5000, "maxRefs": 2000, "maxFrames": 32, "maxDepth": 64}
	args := Params{}
	if option.Boxes {
		args["boxes"] = true
	}
	for name, value := range map[string]int{"maxBytes": option.MaxBytes, "maxNodes": option.MaxNodes, "maxRefs": option.MaxRefs, "maxFrames": option.MaxFrames, "maxDepth": option.MaxDepth} {
		if value == 0 {
			continue
		}
		if value < 1 || value > limits[name] {
			return nil, nil, fmt.Errorf("%s must be a positive integer <= %d", name, limits[name])
		}
		args[name], limits[name] = value, value
	}
	return args, limits, nil
}

// SnapshotAI returns a complete recursive observation, or an explicit failure.
// Every new snapshot and frame lifecycle change invalidates previous captures.
func (t *Tab) SnapshotAI(options ...AISnapshotOptions) (AISnapshot, error) {
	if len(options) > 1 {
		return AISnapshot{}, errors.New("SnapshotAI accepts at most one options value")
	}
	option := AISnapshotOptions{}
	if len(options) == 1 {
		option = options[0]
	}
	args, limits, err := aiCaptureLimits(option)
	if err != nil {
		return AISnapshot{}, err
	}
	value, err := t.Action("snapshotAI", BrowserActionOptions{Args: args, Timeout: option.Timeout})
	if err != nil {
		return AISnapshot{}, err
	}
	return decodeAISnapshot(value, limits, option.Boxes)
}

func (p *TabPlaywright) SnapshotAI(options ...AISnapshotOptions) (AISnapshot, error) {
	return p.tab.SnapshotAI(options...)
}

func exactAIFields(value map[string]json.RawMessage, names ...string) bool {
	if len(value) != len(names) {
		return false
	}
	for _, name := range names {
		if _, exists := value[name]; !exists {
			return false
		}
	}
	return true
}

func decodeAISnapshot(value any, limits map[string]int, withBoxes ...bool) (AISnapshot, error) {
	invalid := errors.New("invalid snapshotAI result")
	boxes := len(withBoxes) == 1 && withBoxes[0]
	encoded, err := json.Marshal(value)
	if err != nil {
		return AISnapshot{}, invalid
	}
	// encoding/json normally accepts case-insensitive struct field names. The
	// public wire schema is exact, including required zero-valued counters.
	var fields, counters map[string]json.RawMessage
	names := []string{"captureId", "snapshot", "refs", "stats", "complete"}
	if boxes {
		names = append(names, "geometry")
	}
	if json.Unmarshal(encoded, &fields) != nil || !exactAIFields(fields, names...) ||
		json.Unmarshal(fields["stats"], &counters) != nil || !exactAIFields(counters, "bytes", "nodes", "refs", "frames") {
		return AISnapshot{}, invalid
	}
	var result struct {
		CaptureID *string  `json:"captureId"`
		Snapshot  *string  `json:"snapshot"`
		Refs      []string `json:"refs"`
		Stats     *struct {
			Bytes  *int `json:"bytes"`
			Nodes  *int `json:"nodes"`
			Refs   *int `json:"refs"`
			Frames *int `json:"frames"`
		} `json:"stats"`
		Complete *bool           `json:"complete"`
		Geometry json.RawMessage `json:"geometry"`
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&result) != nil || result.CaptureID == nil || *result.CaptureID == "" || len(*result.CaptureID) > 128 ||
		result.Snapshot == nil || result.Refs == nil || len(result.Refs) > limits["maxRefs"] || result.Stats == nil || result.Complete == nil || !*result.Complete {
		return AISnapshot{}, invalid
	}
	stats := result.Stats
	if stats.Bytes == nil || stats.Nodes == nil || stats.Refs == nil || stats.Frames == nil ||
		*stats.Bytes != len(*result.Snapshot) || *stats.Bytes > limits["maxBytes"] ||
		*stats.Nodes < 0 || *stats.Nodes > limits["maxNodes"] || *stats.Refs != len(result.Refs) ||
		*stats.Frames < 1 || *stats.Frames > limits["maxFrames"] {
		return AISnapshot{}, invalid
	}
	seen := map[string]bool{}
	for _, ref := range result.Refs {
		if !validAIRef(ref) || seen[ref] {
			return AISnapshot{}, invalid
		}
		seen[ref] = true
	}
	var geometry *AISnapshotGeometry
	if boxes {
		geometry, err = decodeAIGeometry(result.Geometry, result.Refs, *stats.Frames)
		if err != nil {
			return AISnapshot{}, invalid
		}
	}
	return AISnapshot{CaptureID: *result.CaptureID, Snapshot: *result.Snapshot, Refs: result.Refs,
		Stats: AISnapshotStats{Bytes: *stats.Bytes, Nodes: *stats.Nodes, Refs: *stats.Refs, Frames: *stats.Frames}, Complete: true, Geometry: geometry}, nil
}

// GetByRef addresses the original Element in the given capture. It never
// recaptures or locates a replacement by text. Invalid builders fail on action.
func (t *Tab) GetByRef(captureID, ref string) *Locator {
	locator := &Locator{Tab: t, steps: []Params{{"kind": "ref", "captureId": captureID, "ref": ref}}}
	if captureID == "" || len(captureID) > 128 {
		locator.err = errors.New("captureId must be a non-empty string of at most 128 characters")
	} else if !validAIRef(ref) {
		locator.err = errors.New("ref must be a native snapshot reference of at most 64 characters")
	}
	return locator
}

func (p *TabPlaywright) GetByRef(captureID, ref string) *Locator {
	return p.tab.GetByRef(captureID, ref)
}
