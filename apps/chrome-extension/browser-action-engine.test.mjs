import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { BrowserActionEngine, validateBrowserAction, BROWSER_ENGINE_INFO } from "./browser-action-engine.js";

const request = (action, extra = {}) => ({ session_id: "test-session", turn_id: "test-turn", tabId: 42, action, ...extra });
const locator = [{ kind: "role", role: "button", name: "Submit", exact: true }];

const refLocator = capture => [{ kind: "ref", captureId: capture.captureId, ref: "e1" }];
function aiFixture(methods) {
  const f = fixture(methods);
  const events = new EventEmitter();
  f.page.on = events.on.bind(events);
  f.page.off = events.off.bind(events);
  f.page.emit = events.emit.bind(events);
  const snapshot = '- button "Submit" [ref=e1]';
  f.runtime.captureAISnapshot = async () => ({ snapshot, refs: ["e1"], stats: {
    bytes: Buffer.byteLength(snapshot), nodes: 2, refs: 1, frames: 1
  }, complete: true, refFrames: new Map([["e1", {}]]) });
  f.runtime.scrollAIRefIntoView = async (_page, _ref, _capture, { check }) => check();
  return f;
}

test("AI options and singleton reference selectors are finite before runtime attachment", async () => {
  let loads = 0;
  const engine = new BrowserActionEngine({ loadRuntime: async () => { loads++; } });
  for (const args of [{ maxBytes: 0 }, { maxNodes: 5001 }, { maxRefs: 1.1 }, { maxDepth: null }, { maxFrames: 33 }, { unknown: 1 }, { boxes: null }, { boxes: "true" }, { boxes: 1 }])
    await assert.rejects(engine.dispatch(request("snapshotAI", { args })));
  await assert.rejects(engine.dispatch(request("snapshotAI", { locator })));
  for (const descriptor of [
    [{ kind: "ref", captureId: "x", ref: "e1\n" }],
    [{ kind: "ref", captureId: "", ref: "e1" }],
    [{ kind: "ref", captureId: "x", ref: "e1" }, { kind: "first" }],
    [{ kind: "css", selector: "body" }, { kind: "ref", captureId: "x", ref: "e1" }]
  ]) await assert.rejects(engine.dispatch(request("click", { locator: descriptor })));
  assert.equal(loads, 0);
});

test("native selector guards run for CSS, frame and drag destinations before attachment", async () => {
  for (const action of [
    request("count", { locator: [{ kind: "css", selector: "aria-ref=e1" }] }),
    request("count", { locator: [{ kind: "frame", selector: "aria-ref=e1" }, ...locator] }),
    request("dragTo", { locator, args: { target: [{ kind: "css", selector: "aria-ref=e1" }] } })
  ]) {
    const f = fixture();
    let attached = false;
    f.app.attach = async () => { attached = true; return f.page; };
    const checked = [];
    f.runtime.assertOpenBrowserUseSelector = selector => {
      checked.push(selector);
      throw new Error("OBU_REF_SELECTOR_REQUIRES_CAPTURE");
    };
    const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
    await assert.rejects(engine.dispatch(action), /OBU_REF_SELECTOR_REQUIRES_CAPTURE/);
    assert.deepEqual(checked, ["aria-ref=e1"]);
    assert.equal(attached, false);
    assert.equal(f.calls.length, 0);
  }
});

test("restricted selector policy reaches CSS, frame and drag guards before native attachment", async () => {
  for (const action of [
    request("count", { locator: [{ kind: "css", selector: "custom=target" }] }),
    request("count", { locator: [{ kind: "frame", selector: "custom=target" }, ...locator] }),
    request("dragTo", { locator, args: { target: [{ kind: "css", selector: "custom=target" }] } })
  ]) {
    const f = fixture(), checked = [];
    let attached = false, restricted = false;
    f.app.attach = async () => { attached = true; return f.page; };
    f.runtime.assertOpenBrowserUseSelector = (selector, mode) => {
      checked.push([selector, mode]);
      if (mode) throw new Error("OBU_SITE_ACCESS_UNSUPPORTED");
    };
    const engine = new BrowserActionEngine({
      loadRuntime: async () => { restricted = true; return f.runtime; }, restrictedSelectors: () => restricted
    });
    await assert.rejects(engine.dispatch(action), /OBU_SITE_ACCESS_UNSUPPORTED/);
    assert.deepEqual(checked, [["custom=target", true]]);
    assert.equal(attached, false);
  }
});

test("standalone engine selector guard defaults to unrestricted without adding wire fields", async () => {
  const f = fixture({ count: async () => 1 }), checked = [];
  f.runtime.assertOpenBrowserUseSelector = (selector, restricted) => checked.push([selector, restricted]);
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  assert.equal((await engine.dispatch(request("count", { locator: [{ kind: "css", selector: "button" }] }))).value, 1);
  assert.deepEqual(checked, [["button", false]]);
  assert.throws(() => validateBrowserAction(request("count", { locator, restrictedSelectors: false })), /does not support restrictedSelectors/);
});

test("boxes opt-in reaches the bounded runtime without a rendering lease or a renewed deadline", async () => {
  const f = aiFixture();
  const capturedOptions = [], original = f.runtime.captureAISnapshot;
  let renderingLeases = 0;
  f.runtime.captureAISnapshot = async (page, options) => {
    capturedOptions.push(options);
    const result = await original(page, options);
    if (options.boxes) result.geometry = { coordinateSpace: "frame-viewport-css",
      frames: [{ id: "root", parentId: null, ownerRef: null, viewport: { width: 640, height: 480, scrollX: 0, scrollY: 0, devicePixelRatio: 1.5 } }],
      boxes: [{ ref: "e1", frameId: "root", box: { x: 10, y: 20, width: 80, height: 30 } }] };
    return result;
  };
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime, aroundAction: async ({ run }) => { renderingLeases++; return run(); } });
  for (const boxes of [undefined, false, true]) {
    const value = (await engine.dispatch(request("snapshotAI", { args: boxes === undefined ? {} : { boxes }, timeoutMs: 500 }))).value;
    assert.equal(Object.hasOwn(value, "geometry"), boxes === true);
    assert.equal(capturedOptions.at(-1).boxes === true, boxes === true);
    assert.ok(capturedOptions.at(-1).timeoutMs > 0 && capturedOptions.at(-1).timeoutMs <= 500);
  }
  assert.equal(renderingLeases, 0);
  assert.equal(BROWSER_ENGINE_INFO.capabilities.snapshotBoxes, 1);
  const originalCapture = f.runtime.captureAISnapshot;
  f.runtime.captureAISnapshot = async (...args) => {
    const result = await originalCapture(...args);
    f.page.emit("framenavigated", {});
    return result;
  };
  await assert.rejects(engine.dispatch(request("snapshotAI", { args: { boxes: true } })), /OBU_CAPTURE_EXPIRED/);
});

test("capture refs route only emitted elements and ordinary snapshots invalidate the capture", async () => {
  const f = aiFixture({ innerText: async () => "Submit", ariaSnapshot: async () => '- button "Submit"' });
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  const first = (await engine.dispatch(request("snapshotAI"))).value;
  assert.equal((await engine.dispatch(request("innerText", { locator: refLocator(first) }))).value, "Submit");
  assert.ok(f.calls.some(([method, args]) => method === "locator" && args[0] === "aria-ref=e1"));
  assert.equal(first.refFrames, undefined);
  await assert.rejects(engine.dispatch(request("click", { locator: [{ kind: "ref", captureId: first.captureId, ref: "e999" }] })), /OBU_REF_NOT_IN_CAPTURE/);
  assert.equal((await engine.dispatch(request("snapshot", { locator: refLocator(first) }))).value, '- button "Submit"');
  await assert.rejects(engine.dispatch(request("innerText", { locator: refLocator(first) })), /OBU_CAPTURE_EXPIRED/);
  const next = (await engine.dispatch(request("snapshotAI"))).value;
  assert.notEqual(next.captureId, first.captureId);
  f.runtime.captureAISnapshot = async () => { throw new Error("OBU_SNAPSHOT_LIMIT"); };
  await assert.rejects(engine.dispatch(request("snapshotAI")), /OBU_SNAPSHOT_LIMIT/);
  await assert.rejects(engine.dispatch(request("innerText", { locator: refLocator(next) })), /OBU_CAPTURE_EXPIRED/);
});

test("frame events expire captures while a successful ref click may itself navigate", async () => {
  const f = aiFixture({ click: async () => f.page.emit("framenavigated", {}) });
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  const first = (await engine.dispatch(request("snapshotAI"))).value;
  await engine.dispatch(request("click", { locator: refLocator(first) }));
  await assert.rejects(engine.dispatch(request("click", { locator: refLocator(first) })), /OBU_CAPTURE_EXPIRED/);
  assert.equal(f.calls.filter(([method]) => method === "click").length, 1);
  const capture = f.runtime.captureAISnapshot;
  f.runtime.captureAISnapshot = async (...args) => { f.page.emit("frameattached", {}); return capture(...args); };
  await assert.rejects(engine.dispatch(request("snapshotAI")), /OBU_CAPTURE_EXPIRED/);
});

test("ref screenshots pre-scroll real frame identities and cannot continue after invalidation", async () => {
  const f = aiFixture({ screenshot: async () => Buffer.from("png") });
  let remaining;
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  const capture = (await engine.dispatch(request("snapshotAI"))).value;
  f.runtime.scrollAIRefIntoView = async (page, ref, metadata, { timeoutMs, check }) => {
    assert.equal(page, f.page); assert.equal(ref, "e1"); assert.ok(metadata.refFrames.has(ref));
    remaining = timeoutMs; await check();
    f.page.emit("framenavigated", {});
    await check();
  };
  await assert.rejects(engine.dispatch(request("screenshot", { locator: refLocator(capture), timeoutMs: 200 })), /OBU_CAPTURE_EXPIRED/);
  assert.ok(remaining > 0 && remaining <= 200);
  assert.ok(!f.calls.some(([method]) => method === "screenshot"));
});

test("ref drag cannot press a source after navigation during target preflight", async () => {
  const f = aiFixture({ waitFor: async () => f.page.emit("framenavigated", {}) });
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  const capture = (await engine.dispatch(request("snapshotAI"))).value;
  await assert.rejects(engine.dispatch(request("dragTo", { locator: refLocator(capture), args: { target: locator } })), /OBU_CAPTURE_EXPIRED/);
  assert.ok(!f.calls.some(([method]) => method === "dragTo"));
});

test("late AI capture cannot publish after its deadline or leak into a successor attachment", async () => {
  const f = aiFixture();
  const capture = f.runtime.captureAISnapshot;
  let finish;
  f.runtime.captureAISnapshot = () => new Promise(resolve => { finish = async () => resolve(await capture()); });
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  await assert.rejects(engine.dispatch(request("snapshotAI", { timeoutMs: 15 })), /timed out/);
  assert.equal(engine.pages.size, 0);
  await finish();
  f.runtime.captureAISnapshot = capture;
  const fresh = (await engine.dispatch(request("snapshotAI"))).value;
  assert.equal(fresh.refs[0], "e1");
  await engine.detach(42);
  await assert.rejects(engine.dispatch(request("count", { locator: refLocator(fresh) })), /OBU_CAPTURE_EXPIRED/);
});

test("finite action contract rejects executable and unbounded input before loading the engine", async () => {
  let loads = 0;
  const engine = new BrowserActionEngine({ loadRuntime: () => { loads++; throw new Error("unexpected runtime load"); } });
  for (const invalid of [
    request("evaluate", { args: { expression: "document.body" } }),
    request("constructor"), request("click", { locator, args: { evaluate: true } }),
    request("click", { locator: [{ kind: "__proto__" }] }),
    request("click", { locator, timeoutMs: 0 }), request("click", { locator, timeoutMs: 120001 }),
    request("fill", { locator, args: {} }), request("press", { locator, args: { key: null } }),
    request("mouse.click", { args: { x: NaN, y: 2 } }), request("snapshot", { args: { mode: "ai" } })
  ]) await assert.rejects(engine.dispatch(invalid));
  assert.equal(loads, 0);
  assert.deepEqual(await engine.dispatch(request("engineInfo")), { value: BROWSER_ENGINE_INFO, engine: BROWSER_ENGINE_INFO });
  assert.equal(loads, 0);
});

test("contract validates frame locator chains and preserves semantic descriptors", () => {
  const chain = [
    { kind: "frame", selector: "#cross-origin" }, { kind: "label", value: "Name", exact: true }, { kind: "nth", index: 0 }
  ];
  assert.deepEqual(validateBrowserAction(request("fill", { locator: chain, args: { value: "" } })).locator, chain);
  assert.throws(() => validateBrowserAction(request("click", { locator: [{ kind: "frame", selector: "iframe" }] })), /element locator/);
  assert.throws(() => validateBrowserAction(request("snapshot", { locator: [{ kind: "nth", index: 0 }] })), /earlier element/);
  assert.deepEqual(validateBrowserAction(request("selectOption", { locator, args: { values: { label: "A", index: 1 } } })).args.values, [{ label: "A", index: 1 }]);
});

test("locator and frame screenshots reject page-only options before attachment", async () => {
  let loads = 0;
  const engine = new BrowserActionEngine({ loadRuntime: async () => { loads++; } });
  for (const selected of [locator, [{ kind: "frame", selector: "#child" }]]) {
    for (const args of [{ fullPage: true }, { fullPage: false }, { clip: { x: 0, y: 0, width: 10, height: 10 } }]) {
      await assert.rejects(engine.dispatch(request("screenshot", { locator: selected, args })), /Locator screenshots do not support fullPage or clip/);
    }
  }
  assert.equal(loads, 0);
  for (const args of [{ fullPage: true }, { fullPage: false }, { clip: { x: 0, y: 0, width: 10, height: 10 } }]) {
    assert.deepEqual(validateBrowserAction(request("screenshot", { args })).args, args);
  }
  const args = { type: "jpeg", quality: 80, omitBackground: false };
  assert.deepEqual(validateBrowserAction(request("screenshot", { locator, args })).args, args);
});

test("diagnostics rejects unbounded or malformed cursors before attaching", async () => {
  let loads = 0;
  const engine = new BrowserActionEngine({ loadRuntime: async () => { loads++; } });
  for (const args of [
    { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: "2" }, { body: true },
    { after: null }, { after: {} }, { after: { captureId: "capture", sequence: -1 } },
    { after: { captureId: "capture", sequence: Number.MAX_SAFE_INTEGER + 1 } },
    { after: { captureId: "capture", sequence: 1, owner: "other" } }
  ]) await assert.rejects(engine.dispatch(request("diagnostics", { args })));
  await assert.rejects(engine.dispatch(request("diagnostics", { locator })));
  assert.equal(loads, 0);
});

test("diagnostic buffers are isolated across detach, external forget, and unexpected owner changes", async () => {
  const f = fixture();
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  const first = (await engine.dispatch(request("diagnostics", { control_epoch: 1 }))).value;
  await assert.rejects(engine.dispatch(request("diagnostics", { control_epoch: 2 })), /OWNER_CHANGED/);
  const next = (await engine.dispatch(request("diagnostics", { control_epoch: 2 }))).value;
  assert.notEqual(next.captureId, first.captureId);
  await assert.rejects(engine.dispatch(request("diagnostics", { control_epoch: 2, args: { after: first.cursor } })), /EXPIRED/);
  engine.forget(42);
  const afterForget = (await engine.dispatch(request("diagnostics", { control_epoch: 2 }))).value;
  assert.notEqual(afterForget.captureId, next.captureId);
  await engine.detach(42);
  const afterDetach = (await engine.dispatch(request("diagnostics", { control_epoch: 2 }))).value;
  assert.notEqual(afterDetach.captureId, afterForget.captureId);
});

test("drag target is a finite element descriptor on the same tab, validated before attachment", () => {
  for (const target of [undefined, [], [{ kind: "frame", selector: "iframe" }], [{ kind: "evaluate", expression: "document" }], [{ kind: "css", selector: "#drop", tabId: 99 }]])
    assert.throws(() => validateBrowserAction(request("dragTo", { locator, args: { target } })));
  const target = [{ kind: "frame", selector: "iframe" }, { kind: "css", selector: "#drop" }];
  assert.deepEqual(validateBrowserAction(request("dragTo", { locator, args: { target, targetPosition: { x: 5, y: 9 } } })).args.target, target);
  assert.throws(() => validateBrowserAction(request("dragTo", { locator, args: { target, targetPosition: { x: 0, y: NaN } } })));
  assert.throws(() => validateBrowserAction(request("goBack", { locator })));
  assert.throws(() => validateBrowserAction(request("mouse.down", { args: { button: "all" } })));
});

test("navigation and input additions call their real Playwright entry points once", async () => {
  const f = fixture();
  f.page.url = () => "http://fixture/after";
  for (const action of ["goBack", "goForward", "reload"]) f.page[action] = async options => { f.calls.push([action, options]); return action === "goBack" ? null : { status: () => 200 }; };
  const wrapped = [];
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime, aroundAction: async ({ params, run }) => { wrapped.push(params.action); return run(); } });
  for (const action of ["goBack", "goForward", "reload"]) {
    const result = await engine.dispatch(request(action, { args: { waitUntil: "domcontentloaded" } }));
    assert.deepEqual(result.value, { url: "http://fixture/after", status: action === "goBack" ? null : 200 });
    assert.equal(f.calls.filter(([method]) => method === action).length, 1);
  }
  await engine.dispatch(request("dragTo", { locator, args: { target: [{ kind: "css", selector: "#drop" }], force: false } }));
  await engine.dispatch(request("scrollIntoViewIfNeeded", { locator }));
  await engine.dispatch(request("focus", { locator }));
  await engine.dispatch(request("pressSequentially", { locator, args: { text: "Ab", delay: 2 } }));
  assert.deepEqual(wrapped, ["dragTo", "scrollIntoViewIfNeeded"]);
  assert.equal(f.calls.filter(([method]) => method === "dragTo").length, 1);
  assert.equal(f.calls.find(([method]) => method === "dragTo")[1][1].target, undefined);
  assert.equal(f.calls.find(([method]) => method === "pressSequentially")[1][0], "Ab");
});

test("drag errors release the attachment even when the failure is not a timeout", async () => {
  const f = fixture({ dragTo: async () => { throw new Error("target detached after mouse down"); } });
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  await assert.rejects(engine.dispatch(request("dragTo", { locator, args: { target: [{ kind: "css", selector: "#drop" }] } })), /target detached/);
  assert.equal(f.calls.filter(([method]) => method === "detach").length, 1);
});

test("drag destination visibility uses the request deadline before pressing the source", async () => {
  let dragTimeout;
  const f = fixture({ waitFor: async options => {
    assert.equal(options.state, "visible");
    await new Promise(resolve => setTimeout(resolve, 20));
  }, dragTo: async (_target, options) => { dragTimeout = options.timeout; } });
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  await engine.dispatch(request("dragTo", { locator, args: { target: [{ kind: "css", selector: "#drop" }] }, timeoutMs: 200 }));
  assert.ok(f.calls.findIndex(([method]) => method === "waitFor") < f.calls.findIndex(([method]) => method === "dragTo"));
  assert.ok(dragTimeout > 0 && dragTimeout < 190);
  const missing = fixture({ waitFor: async () => { throw Object.assign(new Error("missing destination"), { name: "TimeoutError" }); } });
  const missingEngine = new BrowserActionEngine({ loadRuntime: async () => missing.runtime });
  await assert.rejects(missingEngine.dispatch(request("dragTo", { locator, args: { target: [{ kind: "css", selector: "#missing" }] } })), /missing destination/);
  assert.ok(!missing.calls.some(([method]) => method === "dragTo"));
});

test("drag preflight cannot resume input after ownership ended", async () => {
  let allowed = true;
  const f = fixture({ waitFor: async () => { allowed = false; } });
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime, authorize: () => { if (!allowed) throw new Error("ownership ended"); } });
  await assert.rejects(engine.dispatch(request("dragTo", { locator, args: { target: [{ kind: "css", selector: "#drop" }] } })), /ownership ended/);
  assert.ok(!f.calls.some(([method]) => method === "dragTo"));
});

test("failed input cleanup preserves the original action error, but explicit detach still fails", async () => {
  const original = new Error("drag target removed after input");
  const cleanup = new Error("native cleanup failed");
  const f = fixture({ dragTo: async () => { throw original; } });
  f.app.detach = async () => { throw cleanup; };
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  await assert.rejects(engine.dispatch(request("dragTo", { locator, args: { target: [{ kind: "css", selector: "#drop" }] } })), error => error === original && error.cleanupError === cleanup);
  await engine.attach(42);
  await assert.rejects(engine.detach(42), error => error === cleanup);
});

test("cleanup failure cannot replace a request-wide timeout with success or another error", async () => {
  const cleanup = new Error("native cleanup failed");
  const f = fixture();
  const originalDetach = f.app.detach;
  f.app.detach = async () => { await originalDetach(); throw cleanup; };
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  await assert.rejects(engine.dispatch(request("keyboard.type", { args: { text: "waiting" }, timeoutMs: 15 })), error => /timed out/.test(error.message) && error.cleanupError === cleanup);
});

test("control epoch is optional, bounded, and preserved through every authorization check", async () => {
  for (const control_epoch of [null, "1", 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateBrowserAction(request("engineInfo", { control_epoch })), /control_epoch must be a positive safe integer/);
  }
  assert.equal(validateBrowserAction(request("engineInfo")).control_epoch, undefined);
  assert.equal(validateBrowserAction(request("engineInfo", { control_epoch: Number.MAX_SAFE_INTEGER })).control_epoch, Number.MAX_SAFE_INTEGER);
  const f = fixture({ click: async () => {} });
  const authorizations = [];
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime, authorize: params => authorizations.push(params.control_epoch) });
  await engine.dispatch(request("click", { locator, control_epoch: 7 }));
  assert.ok(authorizations.length >= 2);
  assert.ok(authorizations.every(epoch => epoch === 7));
});

function fixture(methods = {}) {
  const calls = [];
  let pendingReject;
  const target = new Proxy({}, { get: (_, method) => (...args) => { calls.push([method, args]); return methods[method]?.(...args); } });
  const page = {
    on: () => {}, off: () => {},
    getByRole: (...args) => { calls.push(["getByRole", args]); return target; },
    locator: (...args) => { calls.push(["locator", args]); return target; },
    keyboard: { type: () => new Promise((_, reject) => { pendingReject = reject; }) }
  };
  const app = { attach: async () => page, detach: async () => { calls.push(["detach"]); pendingReject?.(new Error("Page detached")); } };
  const runtime = { crx: { start: async () => app }, setOpenBrowserUseCommandObserver: () => {}, setOpenBrowserUseEventFilter: () => {}, assertOpenBrowserUseSelector: () => {} };
  globalThis.chrome = { tabs: { get: async () => ({ incognito: false }) } };
  return { calls, page, app, runtime };
}

const pageSetupParams = { session_id: "test-session", turn_id: "test-turn", control_epoch: 1, tabId: 42 };

const mediaParams = { ...pageSetupParams, locator: [{ kind: "css", selector: "img" }], timeoutMs: 1000 };
const mediaOptions = check => ({ deadlineAt: performance.now() + 1000, check: check ?? (async () => {}) });

test("media source requires pre-admitted exact attachment and cannot reattach or enter ordinary authorization", async () => {
  const f = aiFixture(), engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  assert.throws(() => engine.resolveMediaSource(mediaParams, mediaOptions()), /OBU_MEDIA_SOURCE_CHANGED/);
  await engine.attach(42);
  engine.authorize = async () => assert.fail("source check must not recursively enter backend ownership cleanup");
  let guards = 0, checks = 0;
  f.runtime.assertOpenBrowserUseSelector = (value, restricted) => { assert.equal(value, "img"); assert.equal(restricted, true); guards++; };
  f.runtime.readMediaSource = async (_locator, { check }) => { await check(); return { url: "https://image.test/source" }; };
  assert.deepEqual(await engine.resolveMediaSource(mediaParams, mediaOptions(() => { checks++; })), { url: "https://image.test/source" });
  assert.ok(checks > 1); assert.equal(guards, 1); assert.equal(f.calls.some(call => call[0] === "detach"), false);
});

test("media source forwards its private cancellation registration and bounded byte result unchanged", async () => {
  const f = aiFixture(), engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime }); await engine.attach(42);
  const onCancel = () => {};
  const result = { bytesBase64: "AQID", mimeType: "image/png", byteLength: 3 };
  f.runtime.readMediaSource = async (_locator, options) => { assert.equal(options.onCancel, onCancel); await options.check(); return result; };
  assert.equal(await engine.resolveMediaSource(mediaParams, { ...mediaOptions(), onCancel }), result);
  assert.equal(f.calls.some(call => call[0] === "detach"), false);
});

test("media source queue and drain retain actual source cleanup after its caller has expired", async () => {
  const f = aiFixture(), engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime }); await engine.attach(42);
  let entered, release, valid = true, settled = false, nextRan = false;
  const started = new Promise(resolve => { entered = resolve; });
  f.runtime.readMediaSource = async (_locator, { check }) => {
    entered(); await new Promise(resolve => { release = resolve; }); await check(); return { url: "https://image.test/source" };
  };
  const source = engine.resolveMediaSource(mediaParams, mediaOptions(() => { if (!valid) throw new Error("OBU_DOWNLOAD_EXPIRED"); }));
  const rejected = assert.rejects(source, /OBU_DOWNLOAD_EXPIRED/); source.finally(() => { settled = true; }).catch(() => {});
  await started; valid = false;
  assert.ok(engine.controlSnapshot().pending.includes(source));
  const next = engine.withPage(pageSetupParams, { deadlineAt: performance.now() + 1000 }, () => { nextRan = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(nextRan, false);
  release(); await rejected; await next; assert.equal(nextRan, true);
  assert.equal(f.calls.some(call => call[0] === "detach"), false);
});

test("media source checks frame observation, capture refs and exact attachment after every native await", async () => {
  for (const invalidate of ["frame", "attachment", "capture"]) {
    const f = aiFixture(), engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
    const capture = (await engine.dispatch(request("snapshotAI", { control_epoch: 1 }))).value;
    f.runtime.readMediaSource = async (_locator, { check }) => {
      if (invalidate === "frame") f.page.emit("framenavigated", {});
      if (invalidate === "capture") (await engine.pages.get(42)).observation.begin();
      if (invalidate === "attachment") engine.pages.set(42, Promise.resolve({ page: f.page }));
      await check(); assert.fail("invalid source must not return");
    };
    await assert.rejects(engine.resolveMediaSource({ ...mediaParams, locator: refLocator(capture) }, mediaOptions()), /OBU_MEDIA_SOURCE_CHANGED|OBU_CAPTURE_EXPIRED/);
    assert.equal(f.calls.some(call => call[0] === "detach"), false);
  }
});

test("media queued deadline fails without invoking native source or detaching the existing Page", async () => {
  const f = aiFixture(), engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime }); await engine.attach(42);
  f.runtime.readMediaSource = async () => assert.fail("expired source must not execute");
  await assert.rejects(engine.resolveMediaSource(mediaParams, { ...mediaOptions(), deadlineAt: performance.now() - 1 }), /OBU_DOWNLOAD_TIMEOUT/);
  assert.ok(engine.pages.has(42)); assert.equal(f.calls.some(call => call[0] === "detach"), false);
});

test("short Page setup allows observer-specific timeout and cancellation errors", async () => {
  const f = fixture();
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  const timeoutError = new Error("OBU_NAVIGATION_WAIT_TIMEOUT: setup expired");
  await assert.rejects(engine.withPage(pageSetupParams, {
    deadlineAt: performance.now() - 1, timeoutError: () => timeoutError
  }, () => assert.fail("expired setup must not register")), error => error === timeoutError);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  engine.authorize = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  const expiredError = new Error("OBU_NAVIGATION_WAIT_EXPIRED: turn ended");
  const pending = engine.withPage(pageSetupParams, {
    deadlineAt: performance.now() + 1000, expiredError: () => expiredError
  }, () => assert.fail("cancelled setup must not register"));
  await started;
  await engine.detach(pageSetupParams.tabId);
  release();
  await assert.rejects(pending, error => error === expiredError);
  assert.ok(!f.calls.some(call => call[0] === "attach"));
});

test("short Page setup shares the action attachment and releases its queue before event collection", async () => {
  const events = new EventEmitter(); let attaches = 0;
  const f = fixture({ click: async () => events.emit("response", "real event placeholder") });
  f.page.on = events.on.bind(events); f.page.off = events.off.bind(events);
  f.app.attach = async () => { attaches++; return f.page; };
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  let event;
  const ready = await engine.withPage(pageSetupParams, { deadlineAt: performance.now() + 1000 }, async ({ page, entry, check, remainingMs }) => {
    assert.equal(page, entry.page); await check(); assert.ok(remainingMs() > 0);
    event = new Promise(resolve => page.on("response", resolve));
    return "ready";
  });
  assert.equal(ready, "ready");
  await engine.dispatch(request("click", { locator }));
  assert.equal(await event, "real event placeholder"); assert.equal(attaches, 1);
});

test("queued Page setup expiry cannot cancel a predecessor or register a late listener", async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture({ click: async () => { entered(); await blocked; } });
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  const click = engine.dispatch(request("click", { locator })); await started;
  let registered = false;
  await assert.rejects(engine.withPage(pageSetupParams, { deadlineAt: performance.now() + 15 }, () => { registered = true; }), /TIMEOUT/);
  assert.ok(!f.calls.some(call => call[0] === "detach"));
  release(); await click; await Promise.allSettled(engine.controlSnapshot().pending);
  assert.equal(registered, false);
});

test("isolated warm setup timeout preserves the shared Page while its callback drains", async () => {
  const f = fixture({ click: async () => undefined });
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  await engine.withPage(pageSetupParams, { deadlineAt: performance.now() + 1000 }, () => {});
  const attachment = engine.pages.get(42), generation = engine.generations.get(42);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = engine.withPage(pageSetupParams, {
    deadlineAt: performance.now() + 15, isolateTimeout: true
  }, async () => { entered(); await new Promise(resolve => { release = resolve; }); });
  await started;
  await assert.rejects(pending, /TIMEOUT/);
  assert.equal(engine.pages.get(42), attachment);
  assert.equal(engine.generations.get(42), generation);
  assert.ok(!f.calls.some(call => call[0] === "detach"));
  release(); await Promise.allSettled(engine.controlSnapshot().pending);
  await engine.dispatch(request("click", { locator }));
  assert.equal(engine.pages.get(42), attachment);
});

test("warm setup deadline caught before its timer isolates navigation but preserves network default cleanup", async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  for (const isolateTimeout of [true, false]) {
    now = 0;
    const f = fixture(); const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
    await engine.withPage(pageSetupParams, { deadlineAt: 1000 }, () => {});
    const attachment = engine.pages.get(42);
    await assert.rejects(engine.withPage(pageSetupParams, { deadlineAt: 10, isolateTimeout }, () => { now = 11; }), /TIMEOUT/);
    await Promise.allSettled(engine.controlSnapshot().pending);
    assert.equal(f.calls.filter(call => call[0] === "detach").length, isolateTimeout ? 0 : 1);
    assert.equal(engine.pages.get(42), isolateTimeout ? attachment : undefined);
  }
});

test("isolated cold setup timeout still cleans its late attachment without detaching a successor", async () => {
  let release, attaches = 0, registered = 0;
  const f = fixture();
  f.app.attach = async () => { if (++attaches === 1) await new Promise(resolve => { release = resolve; }); return f.page; };
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  await assert.rejects(engine.withPage(pageSetupParams, { deadlineAt: performance.now() + 15, isolateTimeout: true }, () => { registered++; }), /TIMEOUT/);
  const successor = engine.withPage(pageSetupParams, { deadlineAt: performance.now() + 1000, isolateTimeout: true }, () => { registered++; return "successor"; });
  release();
  assert.equal(await successor, "successor");
  assert.equal(attaches, 2); assert.equal(registered, 1);
  assert.equal(f.calls.filter(call => call[0] === "detach").length, 1);
  assert.equal(engine.pages.size, 1);
});

test("isolated setup sharing a raw attachment behind a release barrier cannot detach its creator", async () => {
  const f = fixture(); const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  let finishRelease, finishSetup, entered;
  const releasing = new Promise(resolve => { finishRelease = resolve; });
  engine.releases.set(42, releasing);
  const rawAttachment = engine.attach(42);
  const started = new Promise(resolve => { entered = resolve; });
  const pending = engine.withPage(pageSetupParams, { deadlineAt: performance.now() + 30, isolateTimeout: true }, async () => {
    entered(); await new Promise(resolve => { finishSetup = resolve; });
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.pages.size, 0);
  engine.releases.delete(42); finishRelease();
  const original = await rawAttachment; await started;
  await assert.rejects(pending, /TIMEOUT/);
  assert.equal(await engine.pages.get(42), original);
  assert.ok(!f.calls.some(call => call[0] === "detach"));
  finishSetup(); await Promise.allSettled(engine.controlSnapshot().pending);
  assert.equal(await engine.pages.get(42), original);
});

test("isolated setup expiring behind release cannot create an attachment when the barrier finishes", async () => {
  const f = fixture(); let attaches = 0;
  f.app.attach = async () => { attaches++; return f.page; };
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  let finishRelease;
  engine.releases.set(42, new Promise(resolve => { finishRelease = resolve; }));
  await assert.rejects(engine.withPage(pageSetupParams, { deadlineAt: performance.now() + 15, isolateTimeout: true }, () => assert.fail("late callback")), /TIMEOUT/);
  engine.releases.delete(42); finishRelease();
  await Promise.allSettled(engine.controlSnapshot().pending);
  assert.equal(attaches, 0); assert.equal(engine.pages.size, 0);
  assert.ok(!f.calls.some(call => call[0] === "detach"));
});

test("late setup attachment is cleaned without registering or detaching a successor", async () => {
  let release; let attaches = 0, registered = 0;
  const f = fixture();
  f.app.attach = async () => { if (++attaches === 1) await new Promise(resolve => { release = resolve; }); return f.page; };
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  await assert.rejects(engine.withPage(pageSetupParams, { deadlineAt: performance.now() + 15 }, () => { registered++; }), /TIMEOUT/);
  const successor = engine.withPage(pageSetupParams, { deadlineAt: performance.now() + 1000 }, () => { registered++; return "new setup"; });
  release();
  assert.equal(await successor, "new setup"); assert.equal(attaches, 2); assert.equal(registered, 1);
  assert.equal(f.calls.filter(call => call[0] === "detach").length, 1);
});

test("setup deadline checked after native completion cleans its attachment even before the timer runs", async t => {
  let now = 0, registered = false;
  t.mock.method(performance, "now", () => now);
  const f = fixture();
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime, onAttached: () => { now = 11; } });
  await assert.rejects(engine.withPage(pageSetupParams, { deadlineAt: 10 }, () => { registered = true; }), /TIMEOUT/);
  await Promise.allSettled(engine.controlSnapshot().pending);
  assert.equal(registered, false);
  assert.equal(f.calls.filter(call => call[0] === "detach").length, 1);
  assert.equal(engine.pages.size, 0);
});

test("a setup callback's deadline failure still cleans up when it beats the engine timer", async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const f = fixture();
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  await assert.rejects(engine.withPage(pageSetupParams, { deadlineAt: 10 }, () => {
    now = 11;
    throw new Error("OBU_NETWORK_WAIT_TIMEOUT: registry setup expired first");
  }), /TIMEOUT/);
  await Promise.allSettled(engine.controlSnapshot().pending);
  assert.equal(f.calls.filter(call => call[0] === "detach").length, 1);
});

test("dispatch uses actual locator method contract and keeps response arrays and YAML", async () => {
  const f = fixture({ click: async () => undefined, allInnerTexts: async () => ["one", "two"], ariaSnapshot: async () => '- button "Submit"' });
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  assert.equal((await engine.dispatch(request("click", { locator, args: { force: false }, timeoutMs: 800 }))).value, null);
  assert.deepEqual(f.calls[0], ["getByRole", ["button", { name: "Submit", exact: true }]]);
  assert.equal(f.calls[1][0], "click");
  assert.equal(f.calls[1][1][0].force, false);
  assert.ok(f.calls[1][1][0].timeout > 0 && f.calls[1][1][0].timeout <= 800);
  assert.deepEqual((await engine.dispatch(request("allInnerTexts", { locator }))).value, ["one", "two"]);
  assert.equal((await engine.dispatch(request("snapshot"))).value, '- button "Submit"');
});

test("ownership is checked again after attachment and before any input", async () => {
  const f = fixture({ click: async () => { throw new Error("input must not run"); } });
  let valid = true;
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime, onAttached: () => { valid = false; }, authorize: () => { if (!valid) throw new Error("ownership ended"); } });
  await assert.rejects(engine.dispatch(request("click", { locator })), /ownership ended/);
  assert.ok(!f.calls.some(call => call[0] === "click"));
});

test("deadline detaches a pending keyboard operation before returning failure", async () => {
  const f = fixture();
  let released = false;
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime, onDetached: () => { released = true; } });
  await assert.rejects(engine.dispatch(request("keyboard.type", { args: { text: "slow", delay: 1000 }, timeoutMs: 20 })), /timed out/);
  assert.equal(released, true);
  assert.equal(f.calls.filter(call => call[0] === "detach").length, 1);
});

test("ending control cancels queued actions instead of replaying them after detach", async () => {
  const f = fixture({ click: () => { throw new Error("queued input must not run"); } });
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  const first = engine.dispatch(request("keyboard.type", { args: { text: "first" } }));
  const firstResult = assert.rejects(first, /detached|cancelled/);
  await new Promise(resolve => setTimeout(resolve, 5));
  const queued = engine.dispatch(request("click", { locator }));
  const queuedResult = assert.rejects(queued, /cancelled/);
  await engine.detach(42);
  await Promise.all([firstResult, queuedResult]);
  assert.ok(!f.calls.some(call => call[0] === "click"));
});

test("control snapshot includes pending attachments, releases and queues without swallowing failures", async () => {
  const engine = new BrowserActionEngine();
  const attaching = Promise.resolve("attaching"), queued = Promise.resolve("queued");
  let failRelease;
  const releasing = new Promise((_, reject) => { failRelease = reject; });
  engine.pages.set(1, attaching);
  engine.queues.set(1, queued);
  engine.queues.set(2, queued);
  engine.releases.set(3, releasing);
  const snapshot = engine.controlSnapshot();
  assert.deepEqual(snapshot.tabIds, [1, 3, 2]);
  assert.deepEqual(snapshot.pending, [attaching, releasing, queued]);
  const drained = Promise.allSettled(snapshot.pending);
  engine.pages.clear();
  engine.queues.clear();
  engine.releases.clear();
  const cleanupError = new Error("release unconfirmed");
  failRelease(cleanupError);
  assert.equal((await drained)[1].reason, cleanupError);
  assert.deepEqual(snapshot.tabIds, [1, 3, 2]);
  assert.deepEqual(engine.controlSnapshot(), { tabIds: [], pending: [] });
});

test("synchronous invalidation rejects queued work while preserving the Page for actual cleanup", async () => {
  const f = fixture({ click: async () => assert.fail("revoked queued click") });
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  const entry = await engine.attach(42);
  let finish;
  engine.queues.set(42, new Promise(resolve => { finish = resolve; }));
  const queued = engine.dispatch(request("click", { locator }));
  const rejected = assert.rejects(queued, /cancelled/);
  engine.invalidate(42);
  assert.equal(await engine.pages.get(42), entry);
  assert.equal(engine.releases.size, 0);
  finish();
  await rejected;
  assert.equal(await engine.pages.get(42), entry);
  await engine.detach(42);
  assert.equal(engine.pages.has(42), false);
});

test("failed attachment initialization detaches instead of leaking control", async () => {
  const f = fixture();
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime, onAttached: () => { throw new Error("focus setup failed"); } });
  await assert.rejects(engine.dispatch(request("click", { locator })), /focus setup failed/);
  assert.equal(f.calls.filter(call => call[0] === "detach").length, 1);
  assert.equal(engine.pages.size, 0);
});

test("failed initialization preserves cleanup failure and does not announce native release", async () => {
  const f = fixture();
  const initialization = new Error("focus setup failed"), cleanup = new Error("native cleanup failed");
  f.app.detach = async () => { throw cleanup; };
  let detached = 0;
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime,
    onAttached: () => { throw initialization; }, onDetached: () => { detached++; } });
  await assert.rejects(engine.dispatch(request("click", { locator })), error => error === initialization && error.cleanupError === cleanup);
  assert.equal(detached, 0);
  assert.equal(engine.pages.size, 0);
  assert.ok(!f.calls.some(call => call[0] === "click"));
});

test("a queued deadline cannot cancel its predecessor or execute late", async () => {
  const f = fixture({ click: async () => { await new Promise(resolve => setTimeout(resolve, 65)); return "first finished"; }, fill: async () => { throw new Error("late mutation"); } });
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  const first = engine.dispatch(request("click", { locator, timeoutMs: 300 }));
  const queued = engine.dispatch(request("fill", { locator, args: { value: "too late" }, timeoutMs: 15 }));
  await assert.rejects(queued, /timed out/);
  assert.equal((await first).value, "first finished");
  assert.ok(!f.calls.some(call => ["fill", "detach"].includes(call[0])));
});

test("an attachment completing after the deadline cannot execute or detach its successor", async () => {
  const f = fixture({ click: async () => "new owner" });
  let releaseAttach;
  let attachCalls = 0;
  const originalAttach = f.app.attach;
  f.app.attach = async () => {
    attachCalls++;
    if (attachCalls === 1) await new Promise(resolve => { releaseAttach = resolve; });
    return originalAttach();
  };
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  await assert.rejects(engine.dispatch(request("click", { locator, timeoutMs: 15 })), /timed out/);
  const successor = engine.dispatch(request("click", { locator, timeoutMs: 300 }));
  releaseAttach();
  assert.equal((await successor).value, "new owner");
  assert.equal(f.calls.filter(call => call[0] === "click").length, 1);
  assert.equal(f.calls.filter(call => call[0] === "detach").length, 1);
  assert.equal(attachCalls, 2);
});

test("late attachment cancellation rejects its action but confirmed cleanup drains successfully", async () => {
  const f = fixture();
  let finishAttach, started;
  const ready = new Promise(resolve => { started = resolve; });
  const originalAttach = f.app.attach;
  f.app.attach = async () => { started(); await new Promise(resolve => { finishAttach = resolve; }); return originalAttach(); };
  let cleaned = 0;
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime, onDetached: () => { cleaned++; } });
  const action = engine.dispatch(request("click", { locator }));
  const failedAction = assert.rejects(action, /cancelled while attaching/);
  await ready;
  const released = engine.detach(42);
  finishAttach();
  await released;
  await failedAction;
  assert.equal(cleaned, 1);
  assert.ok(!f.calls.some(call => call[0] === "click"));
});

for (const boundary of ["runtime", "tab", "app", "prepared"]) test(`cancellation while awaiting ${boundary} before native attach drains only state actually prepared`, async () => {
  const f = fixture(); let finish, started, prepared = 0, cleaned = 0, attaches = 0;
  const entered = new Promise(resolve => { started = resolve; });
  const hold = async () => { started(); await new Promise(resolve => { finish = resolve; }); };
  const originalAttach = f.app.attach;
  f.app.attach = async (...args) => { attaches++; return originalAttach(...args); };
  if (boundary === "tab") globalThis.chrome.tabs.get = async () => { await hold(); return { incognito: false }; };
  if (boundary === "app") f.runtime.crx.start = async () => { await hold(); return f.app; };
  const engine = new BrowserActionEngine({
    loadRuntime: async () => { if (boundary === "runtime") await hold(); return f.runtime; },
    onBeforeAttach: async () => { prepared++; if (boundary === "prepared") await hold(); },
    onDetached: () => { cleaned++; }
  });
  const rejected = assert.rejects(engine.dispatch(request("click", { locator, timeoutMs: 1000 })), /cancelled/);
  await entered;
  const released = engine.detach(42); finish();
  await rejected; await released;
  assert.equal(attaches, 0); assert.equal(prepared, boundary === "prepared" ? 1 : 0);
  assert.equal(cleaned, prepared); assert.equal(engine.pages.size, 0); assert.equal(engine.releases.size, 0);
});

test("a late admission result before app.attach rechecks the original deadline even before its timer fires", async t => {
  const f = fixture(); let now = 0, prepares = 0, cleanup = 0, attaches = 0;
  t.mock.method(performance, "now", () => now);
  f.app.attach = async () => { attaches++; return f.page; };
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime,
    onBeforeAttach: () => { prepares++; }, onDetached: () => { cleanup++; },
    authorize: async () => { if (prepares) now = 101; }
  });
  await assert.rejects(engine.dispatch(request("click", { locator, timeoutMs: 100 })), /timed out/);
  await Promise.allSettled(engine.controlSnapshot().pending);
  assert.equal(prepares, 1); assert.equal(cleanup, 1); assert.equal(attaches, 0);
});

test("failed native input cleanup does not announce detachment or retry the cancelled Page", async () => {
  const f = fixture({ click: async () => {} });
  let cleaned = 0;
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime, onDetached: () => { cleaned++; } });
  await engine.dispatch(request("click", { locator }));
  f.app.detach = async () => { throw new Error("input release unconfirmed"); };
  await assert.rejects(engine.detach(42), /input release unconfirmed/);
  assert.equal(cleaned, 0);
  // Backend retains the original native token and owns explicit cleanup retry.
  await engine.detach(42);
  assert.equal(cleaned, 0);
});

test("a rendering lease consumes the original screenshot budget and preserves Playwright output", async () => {
  let screenshotTimeout;
  const f = fixture({ screenshot: async options => { screenshotTimeout = options.timeout; return Buffer.from("native image"); } });
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime, aroundAction: async ({ params, timeoutMs, run }) => {
    assert.equal(params.action, "screenshot");
    assert.ok(timeoutMs <= 200);
    await new Promise(resolve => setTimeout(resolve, 25));
    return run();
  } });
  const result = await engine.dispatch(request("screenshot", { locator, args: { type: "jpeg" }, timeoutMs: 200 }));
  assert.deepEqual(result.value, { base64: Buffer.from("native image").toString("base64"), mimeType: "image/jpeg" });
  assert.ok(screenshotTimeout > 0 && screenshotTimeout < 185);
});

test("control ending while a screenshot waits for its rendering lease prevents capture", async () => {
  const f = fixture({ screenshot: () => { throw new Error("Canceled capture must not run"); } });
  let acquired;
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime, aroundAction: async ({ run }) => {
    entered();
    await new Promise(resolve => { acquired = resolve; });
    return run();
  } });
  const capture = engine.dispatch(request("screenshot", { locator }));
  const rejected = assert.rejects(capture, /cancelled/);
  await waiting;
  await engine.detach(42);
  acquired();
  await rejected;
  assert.ok(!f.calls.some(call => call[0] === "screenshot"));
});

function frameScreenshotFixture(onScroll = async () => {}) {
  const f = fixture();
  const calls = [];
  const node = prefix => ({
    locator: selector => node(`${prefix}.locator(${selector})`),
    frameLocator: selector => node(`${prefix}.frameLocator(${selector})`),
    scrollIntoViewIfNeeded: async options => { calls.push({ method: "scroll", prefix, options }); await onScroll(prefix, options); },
    screenshot: async options => { calls.push({ method: "screenshot", prefix, options }); return Buffer.from("frame image"); }
  });
  Object.assign(f.page, node("page"));
  return { ...f, frameCalls: calls };
}

const nestedScreenshot = [{ kind: "css", selector: "#container" }, { kind: "frame", selector: "#outer" }, { kind: "frame", selector: "#inner" }, { kind: "css", selector: "#target" }];

test("nested screenshot reveals frame owners outside-in under the same rendering lease and deadline", async () => {
  let leased = false;
  const f = frameScreenshotFixture(async (_prefix, options) => {
    assert.equal(leased, true);
    assert.ok(options.timeout > 0 && options.timeout <= 300);
    await new Promise(resolve => setTimeout(resolve, 12));
  });
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime, aroundAction: async ({ run }) => {
    leased = true;
    try { return await run(); } finally { leased = false; }
  } });
  const result = await engine.dispatch(request("screenshot", { locator: nestedScreenshot, timeoutMs: 300 }));
  assert.deepEqual(result.value, { base64: Buffer.from("frame image").toString("base64"), mimeType: "image/png" });
  assert.deepEqual(f.frameCalls.map(({ method, prefix }) => [method, prefix]), [
    ["scroll", "page.locator(#container).locator(#outer)"],
    ["scroll", "page.locator(#container).frameLocator(#outer).locator(#inner)"],
    ["screenshot", "page.locator(#container).frameLocator(#outer).frameLocator(#inner).locator(#target)"]
  ]);
  assert.ok(f.frameCalls[1].options.timeout < f.frameCalls[0].options.timeout);
  assert.ok(f.frameCalls[2].options.timeout < f.frameCalls[1].options.timeout);
  assert.equal(leased, false);
});

test("frame-owner screenshot preflight rechecks ownership and releases the lease on failure", async () => {
  let authorized = true, released = 0;
  const f = frameScreenshotFixture(async () => { authorized = false; });
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime,
    authorize: () => { if (!authorized) throw new Error("owner changed during scroll"); },
    aroundAction: async ({ run }) => { try { return await run(); } finally { released++; } }
  });
  await assert.rejects(engine.dispatch(request("screenshot", { locator: nestedScreenshot })), /owner changed/);
  assert.equal(f.frameCalls.length, 1);
  assert.equal(released, 1);
});

test("a late frame-owner scroll cannot capture after cancellation or its request deadline", async () => {
  for (const end of ["detach", "timeout"]) {
    let continueScroll, entered;
    const scrolling = new Promise(resolve => { entered = resolve; });
    const f = frameScreenshotFixture(async () => { entered(); await new Promise(resolve => { continueScroll = resolve; }); });
    const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
    const capture = engine.dispatch(request("screenshot", { locator: nestedScreenshot, timeoutMs: end === "timeout" ? 20 : 1000 }));
    const rejected = assert.rejects(capture, end === "timeout" ? /timed out/ : /cancelled/);
    await scrolling;
    if (end === "detach") await engine.detach(42);
    else await rejected;
    continueScroll();
    await rejected;
    await Promise.allSettled(engine.controlSnapshot().pending);
    assert.equal(f.frameCalls.length, 1);
  }
});

test("an ambiguous frame owner cannot be bypassed to capture a different element", async () => {
  const f = frameScreenshotFixture(async () => { throw new Error("strict mode violation: two frame owners"); });
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime });
  await assert.rejects(engine.dispatch(request("screenshot", { locator: nestedScreenshot })), /strict mode violation/);
  assert.equal(f.frameCalls.length, 1);
});

test("only pointer hit testing and screenshots acquire a rendering lease", async () => {
  const f = fixture({ screenshot: async () => Buffer.from("image"), inputValue: async () => "text" });
  f.page.mouse = { move: async () => {}, click: async () => {}, wheel: async () => {}, down: async () => {}, up: async () => {} };
  f.page.keyboard.press = async () => {};
  const wrapped = [];
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime, aroundAction: async ({ params, run }) => { wrapped.push(params.action); return run(); } });
  for (const action of ["click", "dblclick", "hover", "check", "uncheck", "screenshot"])
    await engine.dispatch(request(action, { locator }));
  await engine.dispatch(request("setChecked", { locator, args: { checked: true } }));
  for (const action of ["mouse.move", "mouse.click"])
    await engine.dispatch(request(action, { args: { x: 10, y: 20 } }));
  await engine.dispatch(request("mouse.wheel", { args: { deltaX: 0, deltaY: 100 } }));
  await engine.dispatch(request("mouse.down"));
  await engine.dispatch(request("mouse.up"));
  await engine.dispatch(request("dragTo", { locator, args: { target: [{ kind: "css", selector: "#drop" }] } }));
  await engine.dispatch(request("scrollIntoViewIfNeeded", { locator }));
  await engine.dispatch(request("fill", { locator, args: { value: "value" } }));
  await engine.dispatch(request("inputValue", { locator }));
  await engine.dispatch(request("keyboard.press", { args: { key: "Enter" } }));
  assert.deepEqual(wrapped, ["click", "dblclick", "hover", "check", "uncheck", "screenshot", "setChecked", "mouse.move", "mouse.click", "mouse.wheel", "mouse.down", "mouse.up", "dragTo", "scrollIntoViewIfNeeded"]);
});

test("a pointer action expiring in the rendering lease cannot click later", async () => {
  const f = fixture({ click: () => { throw new Error("Late input must not run"); } });
  let releaseLease;
  const engine = new BrowserActionEngine({ loadRuntime: async () => f.runtime, aroundAction: async ({ run }) => {
    await new Promise(resolve => { releaseLease = resolve; });
    return run();
  } });
  await assert.rejects(engine.dispatch(request("click", { locator, timeoutMs: 15 })), /timed out/);
  releaseLease();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(!f.calls.some(call => call[0] === "click"));
  assert.equal(f.calls.filter(call => call[0] === "detach").length, 1);
});
