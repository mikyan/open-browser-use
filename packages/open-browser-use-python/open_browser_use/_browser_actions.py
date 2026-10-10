"""Serializable locators evaluated by the extension's Playwright engine."""

from __future__ import annotations

from typing import Any

from ._ai_snapshot import validate_capture_ref
from ._downloads import OpenBrowserUseDownload, download_file_params


def action_options(options: dict[str, Any]) -> dict[str, Any]:
    names = {"full_page": "fullPage", "omit_background": "omitBackground",
             "click_count": "clickCount", "source_position": "sourcePosition", "target_position": "targetPosition"}
    return {names.get(key, key): value for key, value in options.items()}


class BrowserMouse:
    def __init__(self, tab: Any) -> None:
        self._tab = tab

    def move(self, x: float, y: float, *, steps: int = 1, timeout_ms: int | None = None) -> None:
        self._tab.action("mouse.move", args={"x": x, "y": y, "steps": steps}, timeout_ms=timeout_ms)

    def click(self, x: float, y: float, *, timeout_ms: int | None = None, **options: Any) -> None:
        self._tab.action("mouse.click", args={"x": x, "y": y, **action_options(options)}, timeout_ms=timeout_ms)

    def wheel(self, delta_x: float, delta_y: float, *, timeout_ms: int | None = None) -> None:
        self._tab.action("mouse.wheel", args={"deltaX": delta_x, "deltaY": delta_y}, timeout_ms=timeout_ms)

    def down(self, *, timeout_ms: int | None = None, **options: Any) -> None:
        self._tab.action("mouse.down", args=action_options(options), timeout_ms=timeout_ms)

    def up(self, *, timeout_ms: int | None = None, **options: Any) -> None:
        self._tab.action("mouse.up", args=action_options(options), timeout_ms=timeout_ms)


class BrowserKeyboard:
    def __init__(self, tab: Any) -> None:
        self._tab = tab

    def press(self, key: str, *, delay: float = 0, timeout_ms: int | None = None) -> None:
        self._tab.action("keyboard.press", args={"key": key, "delay": delay}, timeout_ms=timeout_ms)

    def type(self, text: str, *, delay: float = 0, timeout_ms: int | None = None) -> None:
        self._tab.action("keyboard.type", args={"text": text, "delay": delay}, timeout_ms=timeout_ms)

    def insert_text(self, text: str, *, timeout_ms: int | None = None) -> None:
        self._tab.action("keyboard.insertText", args={"text": text}, timeout_ms=timeout_ms)


class LocatorFactory:
    def __init__(self, tab: Any, steps: list[dict[str, Any]] | None = None) -> None:
        self._tab = tab
        self._steps = steps or []
        if any(step.get("kind") == "ref" for step in self._steps):
            if len(self._steps) != 1:
                raise ValueError("Ref locators cannot be chained")
            validate_capture_ref(self._steps[0].get("captureId"), self._steps[0].get("ref"))

    def _append(self, step: dict[str, Any]) -> "OpenBrowserUseLocator":
        if any(existing.get("kind") == "ref" for existing in self._steps):
            raise ValueError("Ref locators cannot be chained")
        return OpenBrowserUseLocator(self._tab, [*self._steps, step])

    def get_by_ref(self, capture_id: str, ref: str) -> "OpenBrowserUseLocator":
        if self._steps:
            raise ValueError("Ref locators must be created directly from a tab")
        return self._append({"kind": "ref", "captureId": capture_id, "ref": ref})

    def locator(self, selector: str) -> "OpenBrowserUseLocator":
        if not selector:
            raise ValueError("locator requires a selector")
        return self._append({"kind": "css", "selector": selector})

    def frame_locator(self, selector: str) -> "OpenBrowserUseLocator":
        if not selector:
            raise ValueError("frame_locator requires a selector")
        return self._append({"kind": "frame", "selector": selector})

    def get_by_role(self, role: str, *, name: str | None = None,
                    exact: bool = False) -> "OpenBrowserUseLocator":
        step: dict[str, Any] = {"kind": "role", "role": role, "exact": exact}
        if name is not None:
            step["name"] = name
        return self._append(step)

    def get_by_text(self, text: str, *, exact: bool = False) -> "OpenBrowserUseLocator":
        return self._append({"kind": "text", "value": text, "exact": exact})

    def get_by_label(self, text: str, *, exact: bool = False) -> "OpenBrowserUseLocator":
        return self._append({"kind": "label", "value": text, "exact": exact})

    def get_by_placeholder(self, text: str, *, exact: bool = False) -> "OpenBrowserUseLocator":
        return self._append({"kind": "placeholder", "value": text, "exact": exact})

    def get_by_alt_text(self, text: str, *, exact: bool = False) -> "OpenBrowserUseLocator":
        return self._append({"kind": "altText", "value": text, "exact": exact})

    def get_by_title(self, text: str, *, exact: bool = False) -> "OpenBrowserUseLocator":
        return self._append({"kind": "title", "value": text, "exact": exact})

    def get_by_test_id(self, value: str) -> "OpenBrowserUseLocator":
        return self._append({"kind": "testId", "value": value})


class OpenBrowserUseLocator(LocatorFactory):
    def __init__(self, tab: Any, selector: str | list[dict[str, Any]]) -> None:
        if isinstance(selector, str):
            if not selector:
                raise ValueError("locator requires a selector")
            super().__init__(tab, [{"kind": "css", "selector": selector}])
        else:
            super().__init__(tab, selector)

    @property
    def first(self) -> "OpenBrowserUseLocator":
        return self._append({"kind": "first"})

    @property
    def last(self) -> "OpenBrowserUseLocator":
        return self._append({"kind": "last"})

    def nth(self, index: int) -> "OpenBrowserUseLocator":
        return self._append({"kind": "nth", "index": index})

    def filter(self, *, has_text: str | None = None,
               has_not_text: str | None = None) -> "OpenBrowserUseLocator":
        step: dict[str, Any] = {"kind": "filter"}
        if has_text is not None:
            step["hasText"] = has_text
        if has_not_text is not None:
            step["hasNotText"] = has_not_text
        return self._append(step)

    def _action(self, action: str, args: dict[str, Any] | None = None,
                timeout_ms: int | None = None) -> Any:
        return self._tab.action(action, locator=self._steps, args=action_options(args or {}), timeout_ms=timeout_ms)

    def click(self, *, timeout_ms: int | None = None, **options: Any) -> None:
        self._action("click", options, timeout_ms)

    def download_media(self, *, filename: str | None = None, timeout_ms: int | None = None) -> OpenBrowserUseDownload:
        """Start a new GET from the exact image's selected HTTP(S) source."""
        if not self._steps:
            raise ValueError("download_media requires a nonempty locator")
        return self._tab.browser.client._download(self._tab.id, "downloadMedia",
            {**download_file_params(filename, timeout_ms), "locator": self._steps})

    def dblclick(self, *, timeout_ms: int | None = None, **options: Any) -> None:
        self._action("dblclick", options, timeout_ms)

    def hover(self, *, timeout_ms: int | None = None, **options: Any) -> None:
        self._action("hover", options, timeout_ms)

    def drag_to(self, target: "OpenBrowserUseLocator", *, timeout_ms: int | None = None, **options: Any) -> None:
        if (not isinstance(target, OpenBrowserUseLocator) or self._tab.id != target._tab.id
                or self._tab.browser.client is not target._tab.browser.client):
            raise ValueError("drag_to requires a target in the same tab and client")
        self._action("dragTo", {**options, "target": target._steps}, timeout_ms)

    def focus(self, *, timeout_ms: int | None = None) -> None:
        self._action("focus", timeout_ms=timeout_ms)

    def scroll_into_view_if_needed(self, *, timeout_ms: int | None = None) -> None:
        self._action("scrollIntoViewIfNeeded", timeout_ms=timeout_ms)

    def press_sequentially(self, text: str, *, delay: float = 0, timeout_ms: int | None = None) -> None:
        self._action("pressSequentially", {"text": text, "delay": delay}, timeout_ms)

    def fill(self, value: str, *, timeout_ms: int | None = None) -> None:
        self._action("fill", {"value": value}, timeout_ms)

    def press(self, key: str, *, timeout_ms: int | None = None) -> None:
        self._action("press", {"key": key}, timeout_ms)

    def check(self, *, timeout_ms: int | None = None) -> None:
        self._action("check", timeout_ms=timeout_ms)

    def uncheck(self, *, timeout_ms: int | None = None) -> None:
        self._action("uncheck", timeout_ms=timeout_ms)

    def set_checked(self, checked: bool, *, timeout_ms: int | None = None) -> None:
        self._action("setChecked", {"checked": checked}, timeout_ms)

    def select_option(self, values: Any, *, timeout_ms: int | None = None) -> list[str]:
        return self._action("selectOption", {"values": values}, timeout_ms)

    def wait_for(self, state: str = "visible", *, timeout_ms: int | None = None) -> None:
        self._action("waitFor", {"state": state}, timeout_ms)

    def count(self) -> int:
        return self._action("count")

    def inner_text(self, timeout_ms: int | None = None) -> str:
        return self._action("innerText", timeout_ms=timeout_ms)

    def text_content(self, *, timeout_ms: int | None = None) -> str | None:
        return self._action("textContent", timeout_ms=timeout_ms)

    def input_value(self, *, timeout_ms: int | None = None) -> str:
        return self._action("inputValue", timeout_ms=timeout_ms)

    def get_attribute(self, name: str, *, timeout_ms: int | None = None) -> str | None:
        return self._action("getAttribute", {"name": name}, timeout_ms)

    def is_visible(self) -> bool:
        return self._action("isVisible")

    def is_enabled(self, *, timeout_ms: int | None = None) -> bool:
        return self._action("isEnabled", timeout_ms=timeout_ms)

    def is_checked(self, *, timeout_ms: int | None = None) -> bool:
        return self._action("isChecked", timeout_ms=timeout_ms)

    def bounding_box(self, *, timeout_ms: int | None = None) -> dict[str, float] | None:
        return self._action("boundingBox", timeout_ms=timeout_ms)

    def all_inner_texts(self) -> list[str]:
        return self._action("allInnerTexts")

    def all_text_contents(self) -> list[str]:
        return self._action("allTextContents")

    def aria_snapshot(self, *, timeout_ms: int | None = None) -> str:
        return self._action("snapshot", timeout_ms=timeout_ms)

    def screenshot(self, *, timeout_ms: int | None = None, **options: Any) -> dict[str, str]:
        """Return {base64, mimeType}; the caller decides where to save the image."""
        return self._action("screenshot", options, timeout_ms)
