"""Bounded, copied locator trees; native selector parsing stays in the engine."""

from copy import deepcopy
from typing import Any


def copy_steps(steps: list[dict[str, Any]], *, nested: bool = False) -> list[dict[str, Any]]:
    count = 0

    def copy(chain: list[dict[str, Any]], depth: int) -> list[dict[str, Any]]:
        nonlocal count
        if not isinstance(chain, list) or len(chain) > 32 or (depth > 0 and not chain) or depth > 8:
            raise ValueError("Locator tree exceeds chain/depth limits or has an empty operand")
        result = []
        element = False
        for step in chain:
            count += 1
            if not isinstance(step, dict) or count > 128:
                raise ValueError("Locator tree exceeds 128 steps")
            kind = step.get("kind")
            if (nested or depth > 0) and kind in ("frame", "ref"):
                raise ValueError("Nested locators cannot contain frame or ref steps")
            if kind in ("filter", "nth", "first", "last", "and", "or") and not element:
                raise ValueError("Locator operation requires a preceding element")
            element = kind != "frame"
            item = {key: deepcopy(value) for key, value in step.items() if key not in ("has", "hasNot", "locator")}
            if kind == "filter":
                if "visible" in step and not isinstance(step["visible"], bool):
                    raise ValueError("visible must be boolean")
                for key in ("has", "hasNot"):
                    if key in step:
                        item[key] = copy(step[key], depth + 1)
            elif kind in ("and", "or"):
                item["locator"] = copy(step.get("locator"), depth + 1)
            result.append(item)
        return result

    return copy(steps, 0)


def relative_steps(outer: list[dict[str, Any]], inner: list[dict[str, Any]], *, relative: bool) -> list[dict[str, Any]]:
    if any(step.get("kind") == "ref" for step in outer + inner):
        raise ValueError("Ref locators cannot be composed")
    def prefix(chain: list[dict[str, Any]]) -> int:
        return max((i + 1 for i, step in enumerate(chain) if step.get("kind") == "frame"), default=0)
    outer_end, inner_end = prefix(outer), prefix(inner)
    if (not relative or inner_end > 0) and outer[:outer_end] != inner[:inner_end]:
        raise ValueError("Locator operands must have the same frame prefix")
    operand = inner[inner_end:]
    if not operand:
        raise ValueError("Locator operand must be a nonempty element chain")
    return copy_steps(operand, nested=True)


def combined_budget(*chains: list[dict[str, Any]]) -> None:
    def count(chain: list[dict[str, Any]]) -> int:
        return sum(1 + sum(count(step[key]) for key in ("has", "hasNot", "locator") if key in step) for step in chain)
    if sum(count(chain) for chain in chains) > 128:
        raise ValueError("Action locator trees exceed 128 steps")
