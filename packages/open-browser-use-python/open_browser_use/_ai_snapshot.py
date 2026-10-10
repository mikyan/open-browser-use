"""Finite AI observation metadata; reference identity remains extension-owned."""

from __future__ import annotations

import re
from typing import Any, Literal, TypedDict, cast


class AISnapshotStats(TypedDict):
    bytes: int
    nodes: int
    refs: int
    frames: int


class AISnapshot(TypedDict):
    captureId: str
    snapshot: str
    refs: list[str]
    stats: AISnapshotStats
    complete: Literal[True]


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


def validate_snapshot(value: Any, limits: dict[str, int]) -> AISnapshot:
    invalid = RuntimeError("Invalid snapshotAI result")
    if (not isinstance(value, dict) or set(value) != {"captureId", "snapshot", "refs", "stats", "complete"}
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
    return cast(AISnapshot, value)
