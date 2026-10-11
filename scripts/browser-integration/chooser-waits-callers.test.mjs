import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { checkChooserWireCaller } from "./chooser-waits-callers.mjs";

const variants = ["root", "oopif", "dynamic-oopif"];
const base = "http://127.0.0.1:12345/";
const hash = value => createHash("sha256").update(value).digest("hex");
const files = [Buffer.from("original 中文"), Buffer.from([0, 255, 1])].map((bytes, index) => ({
  path: `C:/fixture/${index}.dat`, name: `${index}.dat`, bytes, size: bytes.length, sha256: hash(bytes)
}));
const scopeFor = kind => ({ session_id: `${kind}-chooser-ready`, turn_id: "chooser-ready", control_epoch: 7 });
const pageURL = (kind, variant) => `${base}chooser-waits/page?key=${kind}-chooser-${variant}&variant=${variant}`;
const frameExpression = tabId => `(async()=>({frames:await chrome.webNavigation.getAllFrames({tabId:${tabId}}),targets:await chrome.debugger.getTargets(),attachedTargets:globalThis.__integrationFrames.filter(target=>target.tabId===${tabId})}))()`;

function fixture({ kind = "mcp", failedVariant = "dynamic-oopif", failedSequence = 1, failures = {} } = {}) {
  const calls = [], states = new Map(), records = new Map();
  let created = 0;
  const fail = (stage, state, sequence = state?.sequence ?? 1) => {
    if (failures[stage] && (!state || state.variant === failedVariant && sequence === failedSequence)) throw failures[stage];
  };
  const recordPost = (state, selected) => {
    const chosen = selected.map(filename => files.find(file => file.path === filename));
    assert.ok(chosen.every(Boolean));
    const body = Buffer.from(JSON.stringify({ files: chosen.map(file => ({ name: file.name, base64: file.bytes.toString("base64") })) }));
    records.get(state.key).posts.push({
      method: "POST", variant: state.variant, sequence: state.sequence,
      bodyBase64: body.toString("base64"), bodyBytes: body.length, bodySHA256: hash(body),
      files: chosen.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
      clicks: Array.from({ length: state.sequence }, () => ({ trusted: true })),
      changes: [{ trusted: true, count: state.variant === "root" ? 1 : files.length }, ...(state.sequence === 2 ? [{ trusted: false, count: 0 }] : [])],
      documentToken: `document-${state.tabId}`, href: state.variant === "root" ? pageURL(kind, state.variant) : pageURL(kind, state.variant).replace("127.0.0.1", "localhost").replace("/page?", "/frame?"),
      receipt: { sequence: state.sequence }
    });
  };
  const owner = {
    client: { sessionId: scopeFor(kind).session_id, turnId: "chooser-ready", controlEpoch: 7 },
    async newTab() {
      calls.push(["newTab"]);
      const state = { tabId: 41 + created, variant: variants[created], sequence: 0 }; created++;
      fail("newTab", state, 1); states.set(state.tabId, state);
      return { id: state.tabId, async evaluate(expression) {
        calls.push(["evaluate", state.tabId, expression]); assert.equal(expression, "chooserEvidence.frameAdds");
        fail("frameAdds", state, 1); return [{ trusted: true }];
      } };
    },
    cdp: { async navigate(tabId, url) {
      calls.push(["navigate", tabId, url]);
      const state = states.get(tabId); state.key = new URL(url).searchParams.get("key");
      fail("navigate", state, 1); records.set(state.key, { key: state.key, posts: [] });
    } }
  };
  const callA = async (method, params) => {
    calls.push(["A", method, structuredClone(params)]);
    if (method === "getInfo") { fail("getInfo"); return { metadata: { fileChooserWaitVersion: 1 } }; }
    const state = method === "setFileChooserFiles"
      ? states.get(Number(params.fileChooserId.split("-")[1])) : states.get(params.tabId);
    assert.ok(state, `Unknown original tab for ${method}`);
    if (method === "armFileChooserWait") {
      state.sequence++; fail("arm", state);
      return { waiterId: `wait-${state.tabId}-${state.sequence}`, remainingMs: 9999 };
    }
    if (method === "collectFileChooserWait") {
      fail("collect", state); return { fileChooserId: `chooser-${state.tabId}-${state.sequence}`, isMultiple: state.variant !== "root" };
    }
    if (method === "setFileChooserFiles") { fail("setFiles", state); recordPost(state, params.files); return {}; }
    if (method === "cancelFileChooserWait") { fail("cancel", state); return {}; }
    assert.fail(`Unexpected wire method ${method}`);
  };
  const callB = async (method, params) => {
    calls.push(["B", method, structuredClone(params)]);
    assert.equal(method, "browserAction");
    fail(params.locator[0].kind === "role" ? "addFrame" : "click", states.get(params.tabId));
    return {};
  };
  const worker = { async evaluate(expression) {
    const tabId = Number(expression.match(/tabId:(\d+)/)?.[1]);
    assert.equal(expression, frameExpression(tabId)); calls.push(["frames", tabId]);
    const state = states.get(tabId); fail("frames", state, 1);
    const url = pageURL(kind, state.variant).replace("127.0.0.1", "localhost").replace("/page?", "/frame?");
    return { frames: [{ parentFrameId: 0, url }], targets: [{ id: `target-${tabId}`, url }],
      attachedTargets: [{ tabId, type: "iframe", sessionId: `session-${tabId}` }] };
  } };
  const until = async (read, label) => { calls.push(["until", label]); assert.ok(read()); };
  const detail = { caller: kind, independentConnections: true, variants: [] };
  return { calls, detail, parameters: { kind, owner, callA, callB, fixtureURL: base, files, server: { stats: key => records.get(key) }, worker, until, detail } };
}

// The old successful caller's explicit operation list, including its original
// parameters and deadlines. No stage-recording helper generates this oracle.
function originalCalls(kind) {
  const scope = scopeFor(kind), calls = [["A", "getInfo", {}]];
  for (const [index, variant] of variants.entries()) {
    const tabId = 41 + index;
    calls.push(["newTab"], ["navigate", tabId, pageURL(kind, variant)]);
    for (const sequence of [1, 2]) {
      const waiterId = `wait-${tabId}-${sequence}`;
      calls.push(["A", "armFileChooserWait", { ...scope, tabId, timeoutMs: 10000 }]);
      if (variant === "dynamic-oopif" && sequence === 1)
        calls.push(["B", "browserAction", { ...scope, tabId, action: "click", locator: [{ kind: "role", role: "button", name: "Add upload frame", exact: true }], timeoutMs: 5000 }]);
      calls.push(["B", "browserAction", { ...scope, tabId, action: "click", locator: [...(variant === "root" ? [] : [{ kind: "frame", selector: "#upload-frame" }]), { kind: "label", value: "Upload fixture", exact: true }], timeoutMs: 5000 }],
        ["A", "collectFileChooserWait", { ...scope, tabId, waiterId }],
        ["A", "setFileChooserFiles", { ...scope, fileChooserId: `chooser-${tabId}-${sequence}`, files: sequence === 1 ? files.slice(0, variant === "root" ? 1 : files.length).map(file => file.path) : [] }],
        ["until", `${kind} selected file bytes reached server`],
        ["A", "cancelFileChooserWait", { ...scope, tabId, waiterId }]);
    }
    calls.push(["frames", tabId]);
    if (variant === "dynamic-oopif") calls.push(["evaluate", tabId, "chooserEvidence.frameAdds"]);
  }
  return calls;
}

for (const kind of ["cli", "mcp"]) test(`${kind} keeps every successful original call while returning the parent-owned detail`, async () => {
  const f = fixture({ kind });
  const result = await checkChooserWireCaller(f.parameters);
  assert.equal(result, f.detail);
  assert.deepEqual(f.calls, originalCalls(kind));
  assert.equal(result.passed, true); assert.equal(result.error, undefined);
  for (const item of result.variants) {
    assert.equal(item.passed, true); assert.deepEqual(item.scope, scopeFor(kind));
    assert.deepEqual(item.waits.map(event => event.sequence), [1, 2]);
    for (const event of item.waits) {
      assert.equal(event.passed, true);
      for (const phase of ["arm", "click", "collect", "setFiles", "receipt", "cancel"])
        assert.ok(event[`${phase}CompletedAt`] >= event[`${phase}StartedAt`], phase);
      assert.ok(event.triggerCompletedAt >= event.triggerSubmittedAt);
      assert.ok(event.collectStartedAt >= event.triggerCompletedAt);
      assert.equal(event.originalError, undefined);
    }
  }
});

test("the optional detail preserves the old standalone calling interface", async () => {
  const f = fixture(); delete f.parameters.detail;
  const result = await checkChooserWireCaller(f.parameters);
  assert.equal(result.passed, true); assert.deepEqual(f.calls, originalCalls("mcp"));
});

test("dynamic collect plus cancel failure keeps the frozen original error and prior successful variants", async () => {
  const original = Object.freeze(new Error("original collect timeout")), cancel = Object.freeze(new Error("cancel failed"));
  const originalKeys = Reflect.ownKeys(original);
  const f = fixture({ failures: { collect: original, cancel } });
  await assert.rejects(checkChooserWireCaller(f.parameters), error => error === original);
  assert.deepEqual(Reflect.ownKeys(original), originalKeys);
  assert.deepEqual(f.detail.variants.map(item => item.passed), [true, true, false]);
  const item = f.detail.variants[2], event = item.waits[0];
  assert.equal(item.tabId, 43); assert.equal(item.key, "mcp-chooser-dynamic-oopif");
  assert.deepEqual(item.scope, scopeFor("mcp")); assert.equal(item.waits.length, 1);
  for (const record of [f.detail, item, event]) {
    assert.equal(record.passed, false); assert.equal(record.failedStage, "collect");
    assert.equal(record.originalError, original.message); assert.match(record.error, /original collect timeout/);
    assert.equal(record.failedAt, event.failedAt);
  }
  assert.ok(event.triggerCompletedAt >= event.triggerSubmittedAt);
  assert.ok(event.collectStartedAt >= event.triggerCompletedAt);
  assert.equal(event.collectCompletedAt, undefined); assert.equal(event.result, undefined);
  assert.ok(event.cancelStartedAt >= event.failedAt); assert.ok(event.cancelFailedAt >= event.cancelStartedAt);
  assert.match(event.cancelError, /cancel failed/); assert.equal(event.setFilesStartedAt, undefined);
  const expected = originalCalls("mcp"), stop = expected.findIndex(call => call[0] === "A" && call[1] === "collectFileChooserWait" && call[2].tabId === 43);
  assert.deepEqual(f.calls, [...expected.slice(0, stop + 1), ["A", "cancelFileChooserWait", { ...scopeFor("mcp"), tabId: 43, waiterId: "wait-43-1" }]]);
  assert.doesNotThrow(() => JSON.stringify(f.detail));
});

for (const stage of ["newTab", "navigate", "arm"]) test(`${stage} failure retains the first incomplete variant without cancelling an unacquired waiter`, async () => {
  const original = Object.freeze(new Error(`original ${stage} failure`));
  const f = fixture({ failures: { [stage]: original } });
  await assert.rejects(checkChooserWireCaller(f.parameters), error => error === original);
  const item = f.detail.variants[2];
  assert.deepEqual(f.detail.variants.map(value => value.passed), [true, true, false]);
  assert.equal(item.key, "mcp-chooser-dynamic-oopif"); assert.equal(item.variant, "dynamic-oopif");
  assert.equal(item.failedStage, stage); assert.equal(f.detail.failedStage, stage);
  assert.equal(item.originalError, original.message);
  assert.equal(item.tabId, stage === "newTab" ? undefined : 43);
  assert.equal(item.waits.length, stage === "arm" ? 1 : 0);
  if (stage === "arm") {
    assert.equal(item.waits[0].sequence, 1); assert.equal(item.waits[0].failedStage, "arm");
    assert.equal(item.waits[0].waiterId, undefined); assert.equal(item.waits[0].armCompletedAt, undefined);
  }
  assert.equal(f.calls.filter(call => call[1] === "cancelFileChooserWait").length, 4);
  assert.equal(f.calls.some(call => call[1] === "cancelFileChooserWait" && call[2].tabId === 43), false);
});

test("a cancel-only failure remains a failing round and prevents a second attempt", async () => {
  const original = Object.freeze(new Error("cancel-only failure"));
  const f = fixture({ failedVariant: "root", failures: { cancel: original } });
  await assert.rejects(checkChooserWireCaller(f.parameters), error => error === original);
  const item = f.detail.variants[0], event = item.waits[0];
  assert.equal(f.detail.variants.length, 1); assert.equal(item.waits.length, 1);
  assert.equal(event.failedStage, "cancel"); assert.equal(event.originalError, original.message);
  assert.match(event.cancelError, /cancel-only failure/); assert.equal(event.passed, false);
  assert.ok(event.receiptCompletedAt >= event.receiptStartedAt);
  assert.equal(f.calls.filter(call => call[1] === "armFileChooserWait").length, 1);
  assert.equal(f.calls.filter(call => call[1] === "cancelFileChooserWait").length, 1);
});

test("capability failure is retained before any variant or tab is created", async () => {
  const original = Object.freeze(new Error("getInfo failed"));
  const f = fixture({ failures: { getInfo: original } });
  await assert.rejects(checkChooserWireCaller(f.parameters), error => error === original);
  assert.deepEqual(f.calls, [["A", "getInfo", {}]]); assert.deepEqual(f.detail.variants, []);
  assert.equal(f.detail.failedStage, "getInfo"); assert.equal(f.detail.originalError, original.message);
});
