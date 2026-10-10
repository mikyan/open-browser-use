import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserActionEngine, validateBrowserAction, BROWSER_ENGINE_INFO } from "./browser-action-engine.js";

const request = (action, extra = {}) => ({ session_id: "test-session", turn_id: "test-turn", tabId: 42, action, ...extra });
const locator = [{ kind: "role", role: "button", name: "Submit", exact: true }];

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
  assert.throws(() => validateBrowserAction(request("selectOption", { locator, args: { values: { label: "A", index: 1 } } })), /exactly one/);
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
  const runtime = { crx: { start: async () => app }, setOpenBrowserUseCommandObserver: () => {}, setOpenBrowserUseEventFilter: () => {} };
  globalThis.chrome = { tabs: { get: async () => ({ incognito: false }) } };
  return { calls, page, app, runtime };
}

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
