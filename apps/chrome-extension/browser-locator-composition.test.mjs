import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { BrowserActionEngine, validateBrowserAction, validateLocator, resolveBrowserLocator, visitLocatorSelectors } from "./browser-action-engine.js";
import { validateMediaDownload } from "./browser-media-source.js";
import { patchCrxAISnapshot } from "../../scripts/patch-ai-snapshot.mjs";

const require = createRequire(new URL("./package.json", import.meta.url));
const packageDir = path.dirname(require.resolve("playwright-crx/package.json"));
const entry = await fs.readFile(path.join(packageDir, "lib/index.mjs"), "utf8");
const chunk = /from ["']\.\/([^"']+\.mjs)/.exec(entry)[1];
const upstream = await fs.readFile(path.join(packageDir, "lib", chunk), "utf8");
function slice(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Pinned locator fixture changed: ${start}`);
  return source.slice(first, last);
}
const patched = patchCrxAISnapshot(upstream);
const parser = slice(patched, "const between = function(num, first, last) {", "\nfunction parseAttributeSelector(selector, allowUnquotedStrings) {");
const guard = slice(patched, "export function assertOpenBrowserUseSelector(", "\nconst obuSnapshotCaps").replace("export function", "function");
const assertSelector = vm.runInNewContext(parser + guard + "\nassertOpenBrowserUseSelector;", {
  __publicField: (object, key, value) => { object[key] = value; }
});
const native = vm.runInNewContext(
  slice(upstream, "function escapeRegexForSelector(re2) {", "function trimString(input, cap, suffix =") +
  slice(upstream, "function getByAttributeTextSelector(attrName, text, options2) {", "class Tracing2 extends") +
  "\n({Locator, FrameLocator, getByRoleSelector, getByLabelSelector});", { isString: value => typeof value === "string" });
const css = selector => ({ kind: "css", selector });
const request = (locator, extra = {}) => ({ session_id: "s", turn_id: "t", control_epoch: 1, tabId: 7, action: "count", locator, ...extra });
const nested = (steps, kind = "filter", key = "has") => [css("article"), kind === "filter" ? { kind, [key]: steps } : { kind, locator: steps }];
const runtimeHooks = { setOpenBrowserUseEventFilter() {}, setOpenBrowserUseCommandObserver() {} };

function nativePage(methods = {}) {
  const frame = { _platform: {}, ...methods };
  return {
    on() {}, off() {},
    locator: value => new native.Locator(frame, value),
    frameLocator: value => new native.FrameLocator(frame, value),
    getByRole: (role, options) => new native.Locator(frame, native.getByRoleSelector(role, options)),
    getByLabel: (label, options) => new native.Locator(frame, native.getByLabelSelector(label, options))
  };
}

test("recursive wire limits include drag destination and freeze every operand", () => {
  let tree = [css("button")];
  for (let i = 0; i < 8; i++) tree = nested(tree);
  assert.doesNotThrow(() => validateLocator(tree));
  assert.throws(() => validateLocator(nested(tree)), /nesting/);
  const leaf = Array.from({ length: 32 }, () => css("div"));
  const root = Array.from({ length: 29 }, () => css("div"));
  root.push({ kind: "filter", has: leaf }, { kind: "or", locator: leaf }, { kind: "and", locator: leaf });
  assert.doesNotThrow(() => validateBrowserAction(request(root)));
  assert.throws(() => validateBrowserAction(request(root, { action: "dragTo", args: { target: [css("button")] } })), /128 total/);
  const input = nested([{ kind: "role", role: "button", name: "Save" }]);
  const output = validateBrowserAction(request(input));
  input[1].has[0].name = "Changed";
  assert.equal(output.locator[1].has[0].name, "Save");
  assert.ok(Object.isFrozen(output.locator) && Object.isFrozen(output.locator[1]) && Object.isFrozen(output.locator[1].has) && Object.isFrozen(output.locator[1].has[0]));
});

test("malformed and frame/ref-bearing nested operands fail before runtime load", async () => {
  let loaded = 0;
  const engine = new BrowserActionEngine({ loadRuntime: () => { loaded++; throw new Error("unexpected runtime load"); } });
  for (const operand of [[], null, {}, [{ kind: "frame", selector: "iframe" }, css("button")], [{ kind: "ref", captureId: "x", ref: "e1" }], [{ kind: "nth", index: 0 }]]) {
    for (const kind of ["filter", "and", "or"]) await assert.rejects(engine.dispatch(request(nested(operand, kind))));
  }
  for (const steps of [[{ kind: "and", locator: [css("button")] }], [css("a"), { kind: "filter", visible: "true" }], [css("a"), { kind: "filter", has: [css("button")], unknown: true }]])
    await assert.rejects(engine.dispatch(request(steps)));
  assert.equal(loaded, 0);
});

test("queued actions retain the validated nested selector and mixed selection values", async () => {
  const calls = [];
  const page = nativePage({ selectOption: async (selector, values) => { calls.push({ selector, values }); return ["saved"]; } });
  const engine = new BrowserActionEngine({ loadRuntime: async () => ({ ...runtimeHooks, assertOpenBrowserUseSelector: assertSelector }) });
  engine.pages.set(7, Promise.resolve({ page }));
  let release;
  engine.queues.set(7, new Promise(resolve => { release = resolve; }));
  const locator = nested([css("option.saved")]);
  const values = ["Original label", { value: "saved", index: 0 }];
  const pending = engine.dispatch(request(locator, { action: "selectOption", args: { values } }));
  locator[1].has[0].selector = "custom=unvalidated";
  locator.push({ kind: "or", locator: [css("other")] });
  values[0] = "Changed label";
  values[1].value = "changed";
  release();
  assert.deepEqual((await pending).value, ["saved"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].selector, 'article >> internal:has="option.saved"');
  assert.deepEqual(calls[0].values, [{ valueOrLabel: "Original label" }, { value: "saved", index: 0 }]);
});

test("real pinned locators compose relative operands without duplicating OOPIF enter-frame selectors", () => {
  const steps = validateLocator([
    { kind: "frame", selector: "#outer" }, { kind: "frame", selector: "#child" },
    { kind: "role", role: "row" },
    { kind: "filter", visible: false, has: [{ kind: "role", role: "checkbox", name: "Choose", exact: true }], hasNot: [css("[data-expired]")] },
    { kind: "and", locator: [css(".editable")] },
    { kind: "or", locator: [{ kind: "role", role: "row", name: "Fallback" }] }, { kind: "nth", index: 0 }
  ]);
  const result = resolveBrowserLocator(nativePage(), steps)._selector;
  assert.equal(result.split("internal:control=enter-frame").length - 1, 2);
  assert.match(result, /internal:has=/); assert.match(result, /internal:has-not=/);
  assert.match(result, /visible=false/); assert.match(result, /internal:and=/); assert.match(result, /internal:or=/);
  assert.match(result, /nth=0$/);
  assert.doesNotThrow(() => assertSelector(result, true));
  const nestedParts = [];
  visitLocatorSelectors(steps, (selector, relative) => nestedParts.push([selector, relative]));
  assert.deepEqual(nestedParts, [["#outer", false], ["#child", false], ["[data-expired]", true], [".editable", true]]);
});

test("all nested selectors and drag operands run native policy guards before attachment", async () => {
  for (const [selector, restricted, error] of [
    ["aria-ref=e1", false, /REF_SELECTOR_REQUIRES_CAPTURE/],
    ["custom=secret", true, /SITE_ACCESS_UNSUPPORTED/],
    ['iframe >> internal:control=enter-frame >> input', false, /LOCATOR_FRAME_MISMATCH/],
    ['article >> internal:has="iframe >> internal:control=enter-frame >> input"', false, /LOCATOR_FRAME_MISMATCH/]
  ]) {
    for (const kind of ["filter", "and", "or"]) {
      for (const drag of [false, true]) {
        let attaches = 0;
        const engine = new BrowserActionEngine({ restrictedSelectors: () => restricted, loadRuntime: async () => ({ ...runtimeHooks, assertOpenBrowserUseSelector: assertSelector, crx: { start: async () => ({ attach: async () => { attaches++; } }) } }) });
        const tree = nested(nested([css(selector)], "filter", "hasNot"), kind);
        const params = drag ? request([css("source")], { action: "dragTo", args: { target: tree } }) : request(tree);
        await assert.rejects(engine.dispatch(params), error);
        assert.equal(attaches, 0);
      }
    }
  }
});

test("media uses the same recursively frozen chain and stricter parser across nested operands", async () => {
  const raw = nested([css("img")]);
  const params = validateMediaDownload({ session_id: "s", turn_id: "t", control_epoch: 1, tabId: 7, locator: raw });
  raw[1].has[0].selector = "custom=changed";
  assert.equal(params.locator[1].has[0].selector, "img");
  for (const selector of ["custom=secret", "aria-ref=e1", "iframe >> internal:control=enter-frame >> img"]) {
    let read = 0;
    const engine = new BrowserActionEngine({ loadRuntime: async () => ({ ...runtimeHooks, assertOpenBrowserUseSelector: assertSelector, readMediaSource: async () => { read++; } }) });
    engine.pages.set(7, Promise.resolve({ page: nativePage() }));
    const request = { ...params, locator: nested([css(selector)]) };
    await assert.rejects(engine.resolveMediaSource(request, { deadlineAt: performance.now() + 1000, check: async () => {} }), /SITE_ACCESS_UNSUPPORTED|REF_SELECTOR_REQUIRES_CAPTURE|LOCATOR_FRAME_MISMATCH/);
    assert.equal(read, 0);
  }
});

test("mixed select inputs preserve native string value-or-label and combined constraints", () => {
  const code = slice(upstream, "class ValidationError extends Error {", "scheme.StackFrame = tObject({") +
    slice(upstream, "scheme.FrameSelectOptionParams = tObject({", "scheme.FrameSelectOptionResult = tObject({") +
    slice(upstream, "function convertSelectOptionValues(values) {", "function filePayloadExceedsSizeLimit(payloads) {") +
    "\n({convertSelectOptionValues, check: scheme.FrameSelectOptionParams});";
  const select = vm.runInNewContext(code, { assert, ElementHandle2: class {}, isString: value => typeof value === "string" });
  const injectedLine = upstream.split("\n").find(line => line.startsWith("const source$4 = "));
  const injected = vm.runInNewContext(injectedLine.slice("const source$4 = ".length, -1));
  const selectOptions = vm.runInNewContext(`({${slice(injected, "selectOptions(node, optionsToSelect) {", "  fill(node, value) {")}}).selectOptions`, { Node: class {}, Event });
  const selected = values => {
    const input = validateBrowserAction(request([css("select")], { action: "selectOption", args: { values } }));
    const converted = select.check({ selector: "select", timeout: 10, ...select.convertSelectOptionValues(input.args.values) }, "params", { isUnderTest: () => false });
    const events = [], node = { nodeName: "SELECT", multiple: true, options: [
      { value: "v1", label: "Label-only" }, { value: "v2", label: "Shared" }, { value: "v3", label: "Shared" }
    ], dispatchEvent: event => events.push(event.type) };
    Object.defineProperty(node, "value", { set: () => node.options.forEach(option => { option.selected = false; }) });
    const result = selectOptions.call({ retarget: value => value, createStacklessError: value => new Error(value) }, node, converted.options ?? []);
    return { result: Array.isArray(result) ? Array.from(result) : result, events };
  };
  assert.deepEqual(selected(["Label-only", { value: "v3", label: "Shared", index: 2 }]), { result: ["v1", "v3"], events: ["input", "change"] });
  assert.deepEqual(selected([{ index: 0 }, "v2"]).result, ["v1", "v2"]);
  assert.equal(selected({ value: "v2", label: "Shared", index: 2 }).result, "error:optionsnotfound");
  assert.deepEqual(selected([]).result, []);
  for (const values of [{}, { valueOrLabel: "private" }, { value: "v1", unknown: 1 }, { index: true }, { index: -1 }, { index: 1.5 }, { index: Number.MAX_SAFE_INTEGER + 1 }, { label: null }, [null]])
    assert.throws(() => validateBrowserAction(request([css("select")], { action: "selectOption", args: { values } })));
});
