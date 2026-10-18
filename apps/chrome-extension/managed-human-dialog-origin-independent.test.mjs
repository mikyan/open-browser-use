import assert from "node:assert/strict";
import test from "node:test";
import { ManagedHumanDocumentGraph } from "./managed-human-document-graph.js";
import { ManagedHumanDialogs } from "./managed-human-dialogs.js";

const defer = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const topOrigin = "https://portal.example.test";
const childOrigin = "https://accounts.example.test:8443";
const leafOrigin = "http://documents.example.test:8090";
const nativeFrame = (id, parentId, origin) => ({ id, ...(parentId ? { parentId } : {}), loaderId: `loader-${id}`,
  url: `${origin}/${id}?original=1`, securityOrigin: origin });
const nativeContext = (id, origin, extra = {}) => ({ id: 7, uniqueId: `original-${id}`, origin,
  auxData: { frameId: id, isDefault: true }, ...extra });

// Only native command transport is simulated. Graph ancestry, default-context
// retention, opaque capture proofs and dialog ownership use production modules.
async function graphFixture(kind = "remote") {
  const frames = new Map([["root", nativeFrame("root", null, topOrigin)]]);
  const trees = new Map([[undefined, { frameTree: { frame: frames.get("root") } }]]);
  const contexts = new Map();
  const calls = [], failures = [];
  const graph = new ManagedHumanDocumentGraph({ check() {}, onFailure: error => failures.push(error),
    send: async (sessionId, method, params, check) => {
      check(); calls.push({ sessionId, method, params });
      if (method === "Runtime.enable") for (const context of contexts.get(sessionId) ?? []) {
        graph.observe(sessionId, "Runtime.executionContextCreated", { context });
      }
      return method === "Page.getFrameTree" ? structuredClone(trees.get(sessionId)) : {};
    } });
  const created = (sessionId, context) => graph.observe(sessionId, "Runtime.executionContextCreated", { context });
  const remote = (sessionId, parentSession, id, parentId, origin) => {
    frames.set(id, nativeFrame(id, parentId, origin));
    trees.set(sessionId, { frameTree: { frame: frames.get(id) } });
    contexts.set(sessionId, [nativeContext(id, origin)]);
    graph.observe(parentSession, "Target.attachedToTarget", {
      sessionId, targetInfo: { type: "iframe", targetId: id, parentFrameId: parentId }, waitingForDebugger: false,
    });
  };
  created(undefined, nativeContext("root", topOrigin));
  let emitter = "root", emitterSession;
  if (kind === "local") {
    frames.set("local", nativeFrame("local", "root", topOrigin));
    trees.get(undefined).frameTree.childFrames = [{ frame: frames.get("local") }];
    created(undefined, nativeContext("local", topOrigin, { id: 8 }));
    emitter = "local";
  } else if (kind === "remote" || kind === "nested") {
    remote("account-session", undefined, "account", "root", childOrigin);
    emitter = "account"; emitterSession = "account-session";
    if (kind === "nested") {
      remote("document-session", "account-session", "document", "account", leafOrigin);
      emitter = "document"; emitterSession = "document-session";
    }
  }
  await graph.start();
  const capture = async () => graph.capture(await graph.snapshot(), { frameId: emitter, url: frames.get(emitter).url });
  return { graph, capture, frames, trees, contexts, created, calls, failures, emitter, emitterSession };
}

function dialogFixture(graphProof, graph) {
  const epoch = Object.freeze({}), calls = [], failures = [], publications = [], acknowledgements = [];
  const proof = { epoch, generation: 3, ...(graphProof?.source !== undefined ? { source: graphProof.source } : {}), graphProof };
  let attached = true;
  const manager = new ManagedHumanDialogs({ leaseId: "original-human-lease", capture: () => proof,
    assertCurrent(value) { assert.equal(value.epoch, epoch); assert.equal(value.generation, 3); if (graph) graph.assert(value.graphProof); },
    attached: () => attached, destroyed: () => !attached,
    send: async (decision, check) => {
      check(); calls.push({ ...decision }); const ack = defer(); acknowledgements.push(ack); return ack.promise;
    }, notify: () => publications.push(manager.info()), onFailure: error => failures.push(error),
  });
  const open = (extra = {}) => {
    manager.observe("Page.javascriptDialogOpening", { frameId: "emitter", type: "prompt", message: "Original request", defaultPrompt: "", ...extra });
    return manager.info();
  };
  const request = (info, extra = {}) => ({ leaseId: info.leaseId, generation: info.generation, dialogId: info.dialogId,
    accept: true, promptText: "原回答😀", ...extra });
  const close = async () => {
    manager.observe("Page.javascriptDialogClosed", { frameId: "emitter", result: false });
    for (const ack of acknowledgements) ack.resolve({});
    await manager.close(); attached = false;
  };
  return { manager, proof, epoch, calls, failures, publications, acknowledgements, open, request, close };
}

for (const [kind, origin, frame, ancestry] of [
  ["root", topOrigin, "top-level", [topOrigin]],
  ["local", topOrigin, "child", [topOrigin, topOrigin]],
  ["remote", childOrigin, "child", [childOrigin, topOrigin]],
  ["nested", leafOrigin, "child", [leafOrigin, childOrigin, topOrigin]],
]) test(`independent native ${kind} source is emitter first, including same-origin child identity`, async () => {
  const f = await graphFixture(kind);
  const proof = await f.capture();
  assert.deepEqual(proof.actualOrigins, ancestry);
  assert.deepEqual(proof.source, { origin, frame });
  assert.equal(Object.isFrozen(proof.source), true);
  assert.equal(f.failures.length, 0);
});

test("native default context wins over misleading tree securityOrigin and page-supplied source text", async () => {
  const g = await graphFixture();
  g.frames.get("account").securityOrigin = topOrigin;
  const proof = await g.capture();
  assert.deepEqual(proof.source, { origin: childOrigin, frame: "child" });
  const d = dialogFixture(proof, g.graph);
  try {
    const info = d.open({ message: `Trusted account portal: ${topOrigin} <img src=x onerror=alert(1)>`,
      source: { origin: topOrigin, frame: "top-level" }, origin: topOrigin });
    assert.deepEqual(info.source, { origin: childOrigin, frame: "child" });
    assert.match(info.message, /<img/); // Text remains untrusted content; it never becomes the source label.
    assert.equal(Object.isFrozen(info.source), true);
    assert.throws(() => { info.source.origin = topOrigin; }, TypeError);
  } finally { await d.close(); }
});

test("a tree URL and securityOrigin cannot replace an opaque or missing native default context", async () => {
  for (const replacement of [null, "null"]) {
    const g = await graphFixture();
    g.graph.observe(g.emitterSession, "Runtime.executionContextDestroyed", { executionContextId: 7, executionContextUniqueId: "original-account" });
    if (replacement !== null) g.created(g.emitterSession, nativeContext("account", replacement, { uniqueId: "opaque-account" }));
    await assert.rejects(g.capture(), /UNSUPPORTED/);
  }
});

test("a replayed native context uniqueId cannot overwrite an already captured source", async () => {
  const g = await graphFixture(); const original = await g.capture();
  g.created(g.emitterSession, nativeContext("account", topOrigin));
  g.graph.assert(original);
  assert.deepEqual((await g.capture()).source, { origin: childOrigin, frame: "child" });
  assert.deepEqual(original.source, { origin: childOrigin, frame: "child" });
});

test("retired context rejects the old dialog instead of downgrading its known origin to unknown", async () => {
  const g = await graphFixture(); const original = await g.capture(); const d = dialogFixture(original, g.graph);
  try {
    const info = d.open();
    assert.deepEqual(info.source, { origin: childOrigin, frame: "child" });
    g.graph.observe(g.emitterSession, "Runtime.executionContextDestroyed", { executionContextId: 7, executionContextUniqueId: "original-account" });
    await assert.rejects(d.manager.respond(d.request(info)), /STALE/);
    assert.equal(d.calls.length, 0, "no native answer from a retired source proof");
    assert.deepEqual(info.source, { origin: childOrigin, frame: "child" });
  } finally { await d.close(); }
});

test("claim and duplicate answer preserve the original source without resending native input", async () => {
  const g = await graphFixture(); const d = dialogFixture(await g.capture(), g.graph);
  try {
    const info = d.open(); const pending = d.manager.respond(d.request(info));
    await tick();
    assert.deepEqual(d.manager.info().source, { origin: childOrigin, frame: "child" });
    await assert.rejects(d.manager.respond(d.request(info)), /STALE/);
    assert.deepEqual(d.calls, [{ accept: true, promptText: "原回答😀" }]);
    d.acknowledgements[0].resolve({}); await pending;
    assert.deepEqual(info.source, { origin: childOrigin, frame: "child" });
  } finally { await d.close(); }
});

test("End before a late original proof settles never publishes its known source", async () => {
  const g = await graphFixture(); const d = dialogFixture(await g.capture(), g.graph); const read = defer();
  d.manager.capture = () => ({ epoch: d.epoch, pending: read.promise });
  assert.equal(d.open(), null);
  let ended = false; const end = d.manager.close().then(() => { ended = true; });
  await tick();
  assert.deepEqual(d.calls, [{ accept: false }]);
  d.acknowledgements[0].resolve({}); await tick();
  assert.equal(ended, false, "original actual source proof read still belongs to cleanup");
  read.resolve(d.proof); await end;
  assert.equal(d.manager.info(), null);
  assert.equal(d.publications.some(Boolean), false);
  assert.equal(d.manager.captures.size, 0);
  await d.close();
});

test("legacy absence omits source and preserves one original answer; request source cannot extend the tuple", async () => {
  const d = dialogFixture();
  try {
    const info = d.open({ source: { origin: topOrigin, frame: "top-level" } });
    assert.equal(Object.hasOwn(info, "source"), false);
    await assert.rejects(d.manager.respond(d.request(info, { source: { origin: topOrigin, frame: "top-level" } })), /INVALID/);
    assert.equal(d.calls.length, 0);
    const pending = d.manager.respond(d.request(info)); await tick();
    d.acknowledgements[0].resolve({}); await pending;
    assert.equal(d.calls.length, 1);
  } finally { await d.close(); }
});

for (const [label, origin] of [
  ["explicit-null", null],
  ["userinfo", "https://secret@accounts.example.test"],
  ["trailing-slash", `${childOrigin}/`],
  ["query", `${childOrigin}?secret=1`],
  ["opaque", "null"],
  ["noncanonical-case", "https://ACCOUNTS.example.test:8443"],
  ["over-2048-bytes", `https://${"a".repeat(2040)}.test`],
]) test(`native source producer refuses ${label} instead of displaying the tree URL`, async () => {
  const g = await graphFixture();
  g.graph.observe(g.emitterSession, "Runtime.executionContextDestroyed", {
    executionContextId: 7, executionContextUniqueId: "original-account",
  });
  g.created(g.emitterSession, nativeContext("account", origin, { uniqueId: "replacement-account" }));
  // For the length boundary, the original native URL and actual origin agree.
  // Failure must come from the public display bound, not a URL mismatch.
  if (label === "over-2048-bytes") g.frames.get("account").url = `${origin}/account?original=1`;
  await assert.rejects(g.capture(), /UNSUPPORTED/);
});
