import assert from "node:assert/strict";
import test from "node:test";
import { assertHumanClipboardRuntime, clipboardFailure, validateHumanClipboardInput, validateHumanClipboardResult } from "./managed-human-clipboard.js";

const input = (operation = "copy") => ({ type: "key", action: "down", key: operation === "copy" ? "c" : "X",
  code: operation === "copy" ? "KeyC" : "KeyX", windowsVirtualKeyCode: operation === "copy" ? 67 : 88, modifiers: 2, clipboardTransfer: operation });
test("ordinary inputs do not acquire clipboard authority; exact real Ctrl/Meta C/X identify the requested operation", () => {
  assert.equal(validateHumanClipboardInput({ type: "text", text: "copy" }), null);
  for (const operation of ["copy", "cut"]) for (const modifiers of [2, 4]) {
    assert.equal(validateHumanClipboardInput({ ...input(operation), modifiers }), operation);
  }
  for (const change of [
    { clipboardTransfer: null }, { clipboardTransfer: true }, { clipboardTransfer: "COPY" },
    { type: "text" }, { action: "up" }, { code: "KeyV" }, { key: "x" }, { windowsVirtualKeyCode: 88 },
    { modifiers: 0 }, { modifiers: 6 }, { modifiers: 10 }, { modifiers: 12 }, { modifiers: 3 },
    { repeat: true }, { repeat: false }, { repeat: null }
  ]) assert.throws(() => validateHumanClipboardInput({ ...input(), ...change }), /INVALID/);
});

test("bounded result shapes preserve genuine empty text but reject invalid Unicode, byte excess and unsolicited fields", () => {
  for (const text of ["", "中文\n🙂", "a".repeat(65536)]) {
    const result = { operation: "cut", status: "ready", text };
    const copied = validateHumanClipboardResult(result, "cut");
    assert.deepEqual(copied, result); assert.notEqual(copied, result);
  }
  assert.deepEqual(validateHumanClipboardResult({ operation: "copy", status: "unchanged" }, "copy"), { operation: "copy", status: "unchanged" });
  for (const result of [
    null, { operation: "copy", status: "ready" },
    { operation: "cut", status: "ready", text: "" },
    { operation: "copy", status: "ready", text: "\ud800" },
    { operation: "copy", status: "ready", text: "\udc00" },
    { operation: "copy", status: "ready", text: "中".repeat(21846) },
    { operation: "copy", status: "ready", text: "", code: "DENIED" },
    { operation: "copy", status: "unchanged", text: "" },
    { operation: "copy", status: "failed", code: "READ_FAILED", text: "" },
    { operation: "copy", status: "failed", code: "arbitrary message" },
    { operation: "copy", status: "ready", text: "", origin: "https://page.example" }
  ]) assert.throws(() => validateHumanClipboardResult(result, "copy"), /INVALID|LIMIT/);
});

test("failure projection is bounded metadata, never arbitrary native errors or contents", () => {
  for (const code of ["UNSUPPORTED", "DENIED", "BUSY", "CANCELLED", "TIMEOUT", "CHANGED", "LIMIT", "READ_FAILED"]) {
    assert.deepEqual(clipboardFailure(new Error(`OBU_CLIPBOARD_${code}: private contents`), "copy"), { operation: "copy", status: "failed", code });
  }
  assert.equal(clipboardFailure(new Error("private contents"), "cut").code, "READ_FAILED");
  assert.equal(clipboardFailure(new DOMException("private", "NotAllowedError"), "copy").code, "DENIED");
  assert.equal(clipboardFailure(new DOMException("private", "InvalidStateError"), "copy").code, "CHANGED");
  assert.throws(() => clipboardFailure(new Error("private"), "paste"), /INVALID/);
});

test("mechanism requires exact native version and revision instead of a user agent approximation", () => {
  for (const product of ["Chrome/156.0.8078.4", "HeadlessChrome/156.0.8078.4"]) {
    assert.doesNotThrow(() => assertHumanClipboardRuntime({ product, revision: "@f842f52ef39fd97b449eb27cff414bf05a98ddce" }));
  }
  assert.doesNotThrow(() => assertHumanClipboardRuntime({ product: "Chrome/156.0.8078.12", revision: "@634b046faf2137b83af71c87baf362b533af9104" }));
  for (const version of [null, {}, { product: "Chrome/156.0.8078.4", revision: "f842f52ef39fd97b449eb27cff414bf05a98ddce" },
    { product: "Chrome/156.0.8078.12", revision: "@f842f52ef39fd97b449eb27cff414bf05a98ddce" }]) {
    assert.throws(() => assertHumanClipboardRuntime(version), /UNSUPPORTED/);
  }
});
