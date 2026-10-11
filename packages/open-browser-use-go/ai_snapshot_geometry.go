package obu

import (
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strings"
)

// AISnapshotGeometry contains capture-time, unclipped bounds in each frame's
// own CSS viewport. It is not an atomic layout or a top-frame click position.
type AISnapshotGeometry struct {
	CoordinateSpace string             `json:"coordinateSpace"`
	Frames          []AISnapshotFrame  `json:"frames"`
	Boxes           []AISnapshotRefBox `json:"boxes"`
}

type AISnapshotFrame struct {
	ID       string             `json:"id"`
	ParentID *string            `json:"parentId"`
	OwnerRef *string            `json:"ownerRef"`
	Viewport AISnapshotViewport `json:"viewport"`
}

type AISnapshotViewport struct {
	Width            float64 `json:"width"`
	Height           float64 `json:"height"`
	ScrollX          float64 `json:"scrollX"`
	ScrollY          float64 `json:"scrollY"`
	DevicePixelRatio float64 `json:"devicePixelRatio"`
}

type AISnapshotBox struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type AISnapshotRefBox struct {
	Ref     string        `json:"ref"`
	FrameID string        `json:"frameId"`
	Box     AISnapshotBox `json:"box"`
}

var aiFramePattern = regexp.MustCompile(`^f([1-9]|[12][0-9]|3[0-2])$`)

func exactGeometryFields(value any, names ...string) (map[string]any, bool) {
	object, ok := value.(map[string]any)
	if !ok || len(object) != len(names) {
		return nil, false
	}
	for _, name := range names {
		if _, ok := object[name]; !ok {
			return nil, false
		}
	}
	return object, true
}

func finiteGeometryFields(value any, names ...string) (map[string]any, bool) {
	object, ok := exactGeometryFields(value, names...)
	if !ok {
		return nil, false
	}
	for _, value := range object {
		number, ok := value.(float64)
		if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
			return nil, false
		}
	}
	return object, true
}

func decodeAIGeometry(encoded json.RawMessage, refs []string, frameCount int) (*AISnapshotGeometry, error) {
	invalid := errors.New("invalid snapshotAI geometry")
	var value any
	if json.Unmarshal(encoded, &value) != nil {
		return nil, invalid
	}
	geometry, ok := exactGeometryFields(value, "coordinateSpace", "frames", "boxes")
	if !ok || geometry["coordinateSpace"] != "frame-viewport-css" {
		return nil, invalid
	}
	frameList, framesOK := geometry["frames"].([]any)
	boxList, boxesOK := geometry["boxes"].([]any)
	if !framesOK || len(frameList) != frameCount || !boxesOK || len(boxList) != len(refs) {
		return nil, invalid
	}
	refSet, boxes, frames, owners := map[string]bool{}, map[string]string{}, map[string]bool{}, map[string]bool{}
	for _, ref := range refs {
		refSet[ref] = true
	}
	for _, value := range boxList {
		entry, ok := exactGeometryFields(value, "ref", "frameId", "box")
		if !ok {
			return nil, invalid
		}
		ref, refOK := entry["ref"].(string)
		frameID, frameOK := entry["frameId"].(string)
		_, duplicate := boxes[ref]
		expectedFrame := strings.SplitN(ref, "e", 2)[0]
		if expectedFrame == "" {
			expectedFrame = "root"
		}
		box, boxOK := finiteGeometryFields(entry["box"], "x", "y", "width", "height")
		if !refOK || !refSet[ref] || duplicate || !frameOK || frameID != expectedFrame || !boxOK ||
			box["width"].(float64) < 0 || box["height"].(float64) < 0 {
			return nil, invalid
		}
		boxes[ref] = frameID
	}
	for index, value := range frameList {
		frame, ok := exactGeometryFields(value, "id", "parentId", "ownerRef", "viewport")
		if !ok {
			return nil, invalid
		}
		id, idOK := frame["id"].(string)
		viewport, viewportOK := finiteGeometryFields(frame["viewport"], "width", "height", "scrollX", "scrollY", "devicePixelRatio")
		if !idOK || frames[id] || !viewportOK || viewport["width"].(float64) < 0 || viewport["height"].(float64) < 0 || viewport["devicePixelRatio"].(float64) <= 0 {
			return nil, invalid
		}
		if index == 0 {
			if id != "root" || frame["parentId"] != nil || frame["ownerRef"] != nil {
				return nil, invalid
			}
		} else {
			parent, parentOK := frame["parentId"].(string)
			owner, ownerOK := frame["ownerRef"].(string)
			if !aiFramePattern.MatchString(id) || !parentOK || !frames[parent] || !ownerOK || owners[owner] || boxes[owner] != parent {
				return nil, invalid
			}
			owners[owner] = true
		}
		frames[id] = true
	}
	for _, frameID := range boxes {
		if !frames[frameID] {
			return nil, invalid
		}
	}
	var result AISnapshotGeometry
	if json.Unmarshal(encoded, &result) != nil {
		return nil, invalid
	}
	return &result, nil
}
