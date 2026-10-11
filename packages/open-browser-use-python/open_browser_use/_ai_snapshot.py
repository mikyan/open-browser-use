"""Finite AI observation metadata; reference identity remains extension-owned."""

from __future__ import annotations

import math
import re
from typing import Any, Literal, TypedDict, cast


class AISnapshotStats(TypedDict):
    bytes: int
    nodes: int
    refs: int
    frames: int


class AISnapshotBox(TypedDict):
    x: float
    y: float
    width: float
    height: float


class AISnapshotViewport(TypedDict):
    width: float
    height: float
    scrollX: float
    scrollY: float
    devicePixelRatio: float


class AISnapshotFrame(TypedDict):
    id: str
    parentId: str | None
    ownerRef: str | None
    viewport: AISnapshotViewport


class AISnapshotRefBox(TypedDict):
    ref: str
    frameId: str
    box: AISnapshotBox


class AISnapshotGeometry(TypedDict):
    coordinateSpace: Literal["frame-viewport-css"]
    frames: list[AISnapshotFrame]
    boxes: list[AISnapshotRefBox]


class _AISnapshotRequired(TypedDict):
    captureId: str
    snapshot: str
    refs: list[str]
    stats: AISnapshotStats
    complete: Literal[True]


class AISnapshot(_AISnapshotRequired, total=False):
    geometry: AISnapshotGeometry


LIMITS = {"maxBytes": 262144, "maxNodes": 5000, "maxRefs": 2000, "maxFrames": 32, "maxDepth": 64}
_REF = re.compile(r"(?:f[1-9][0-9]*)?e[1-9][0-9]*")


def valid_ref(value: Any) -> bool:
    return isinstance(value, str) and len(value) <= 64 and _REF.fullmatch(value) is not None


def validate_capture_ref(capture_id: Any, ref: Any) -> None:
    if not isinstance(capture_id, str) or not 1 <= len(capture_id) <= 128:
        raise ValueError("capture_id must be a non-empty string of at most 128 characters")
    if not valid_ref(ref):
        raise ValueError("ref must be a native snapshot reference of at most 64 characters")


def snapshot_limits(options: dict[str, int | None]) -> tuple[dict[str, int], dict[str, int]]:
    args = {}
    limits = dict(LIMITS)
    for name, value in options.items():
        if value is None:
            continue
        if type(value) is not int or not 1 <= value <= LIMITS[name]:
            raise ValueError(f"{name} must be a positive integer <= {LIMITS[name]}")
        args[name] = value
        limits[name] = value
    return args, limits


def validate_snapshot(value: Any, limits: dict[str, int], boxes: bool = False) -> AISnapshot:
    invalid = RuntimeError("Invalid snapshotAI result")
    fields = {"captureId", "snapshot", "refs", "stats", "complete"} | ({"geometry"} if boxes else set())
    if (not isinstance(value, dict) or set(value) != fields
            or value["complete"] is not True or not isinstance(value["captureId"], str)
            or not 1 <= len(value["captureId"]) <= 128 or not isinstance(value["snapshot"], str)
            or not isinstance(value["refs"], list) or len(value["refs"]) > limits["maxRefs"]
            or any(not valid_ref(ref) for ref in value["refs"])):
        raise invalid
    refs, stats = value["refs"], value["stats"]
    if (len(set(refs)) != len(refs) or not isinstance(stats, dict)
            or set(stats) != {"bytes", "nodes", "refs", "frames"}
            or any(type(count) is not int or count < 0 for count in stats.values())):
        raise invalid
    try:
        byte_count = len(value["snapshot"].encode("utf-8"))
    except UnicodeEncodeError as error:
        raise invalid from error
    if (stats["bytes"] != byte_count or byte_count > limits["maxBytes"]
            or stats["nodes"] > limits["maxNodes"] or stats["refs"] != len(refs)
            or not 1 <= stats["frames"] <= limits["maxFrames"]):
        raise invalid
    if boxes and not valid_geometry(value["geometry"], refs, stats["frames"]):
        raise invalid
    return cast(AISnapshot, value)


def valid_geometry(value: Any, refs: list[str], frame_count: int) -> bool:
    def exact(item: Any, fields: set[str]) -> bool:
        return isinstance(item, dict) and set(item) == fields

    def finite(item: Any) -> bool:
        if type(item) not in (int, float):
            return False
        try:
            return math.isfinite(item)
        except OverflowError:
            return False

    if (not exact(value, {"coordinateSpace", "frames", "boxes"})
            or value["coordinateSpace"] != "frame-viewport-css"
            or not isinstance(value["frames"], list) or len(value["frames"]) != frame_count
            or not isinstance(value["boxes"], list) or len(value["boxes"]) != len(refs)):
        return False
    ref_set, boxes_by_ref, frames, owners = set(refs), {}, set(), set()
    for entry in value["boxes"]:
        if (not exact(entry, {"ref", "frameId", "box"}) or not isinstance(entry["ref"], str)
                or entry["ref"] not in ref_set or entry["ref"] in boxes_by_ref
                or not isinstance(entry["frameId"], str)
                or entry["frameId"] != (entry["ref"].split("e", 1)[0] or "root")
                or not exact(entry["box"], {"x", "y", "width", "height"})
                or not all(finite(number) for number in entry["box"].values())
                or entry["box"]["width"] < 0 or entry["box"]["height"] < 0):
            return False
        boxes_by_ref[entry["ref"]] = entry["frameId"]
    for index, frame in enumerate(value["frames"]):
        if (not exact(frame, {"id", "parentId", "ownerRef", "viewport"})
                or not isinstance(frame["id"], str) or frame["id"] in frames
                or not exact(frame["viewport"], {"width", "height", "scrollX", "scrollY", "devicePixelRatio"})
                or not all(finite(number) for number in frame["viewport"].values())
                or frame["viewport"]["width"] < 0 or frame["viewport"]["height"] < 0
                or frame["viewport"]["devicePixelRatio"] <= 0):
            return False
        if index == 0:
            if frame["id"] != "root" or frame["parentId"] is not None or frame["ownerRef"] is not None:
                return False
        elif (re.fullmatch(r"f([1-9]|[12][0-9]|3[0-2])", frame["id"]) is None
              or not isinstance(frame["parentId"], str) or frame["parentId"] not in frames
              or not isinstance(frame["ownerRef"], str) or frame["ownerRef"] in owners
              or boxes_by_ref.get(frame["ownerRef"]) != frame["parentId"]):
            return False
        frames.add(frame["id"])
        if frame["ownerRef"] is not None:
            owners.add(frame["ownerRef"])
    return all(frame_id in frames for frame_id in boxes_by_ref.values())
