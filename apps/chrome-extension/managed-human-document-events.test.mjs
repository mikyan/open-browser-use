import assert from "node:assert/strict";
import test from "node:test";
import { ManagedHumanDocumentGraph } from "./managed-human-document-graph.js";

const frame = (id, parent, loader = `loader-${id}`, url = `https://root.test/${id}`) =>
  ({ id, ...(parent ? { parentId: parent } : {}), loaderId: loader, url, securityOrigin: new URL(url).origin });
const context = (id, uniqueId = `context-${id}`, origin = "https://root.test", number = 1) =>
  ({ id: number, uniqueId, origin, auxData: { isDefault: true, type: "default", frameId: id } });
const tree = (root, children = []) => ({ frameTree: { frame: root, childFrames: children.map(child => ({ frame: child })) } });

async function fixture({ remote = false, local = false, policy = false } = {}) {
  const calls = [], failures = [], trees = new Map([[undefined, tree(frame("root"), local ? [frame("child", "root")] : [])]]);
  let version = 0, permitted = true;
  const graph = new ManagedHumanDocumentGraph({ check() {}, onFailure: error => failures.push(error),
    assertCandidate(candidate, actualOrigins) {
      assert.equal(candidate.navigationVersion, version, "original browser navigation version");
      if (!permitted || actualOrigins.some(origin => !["https://root.test", "https://child.test"].includes(origin))) throw new Error("policy changed");
    },
    send: async (session, method, params, check) => {
      check(); calls.push({ session, method, params });
      if (session && method === "Runtime.enable") {
        const root = trees.get(session).frameTree.frame;
        graph.observe(session, "Runtime.executionContextCreated", { context: context(root.id, `${root.id}-original`, new URL(root.url).origin) });
      }
      return method === "Page.getFrameTree" ? structuredClone(trees.get(session)) : {};
    }
  });
  graph.observe(undefined, "Runtime.executionContextCreated", { context: context("root") });
  if (local) graph.observe(undefined, "Runtime.executionContextCreated", { context: context("child", "child-original", "https://root.test", 2) });
  if (remote) {
    trees.set("remote", tree(frame("child", "root", "loader-child", "https://child.test/child")));
    graph.observe(undefined, "Target.attachedToTarget", { sessionId: "remote", waitingForDebugger: false,
      targetInfo: { type: "iframe", targetId: "child", parentFrameId: "root" } });
  }
  await graph.start();
  const candidate = (documentId = "browser-original", url = "https://root.test/root") => Object.freeze({ documentId,
    navigationVersion: version, url, ...(policy ? { siteProof: Object.freeze({ documentId, version }) } : {}) });
  await graph.snapshot(candidate());
  const f = { graph, calls, failures, trees, candidate, version: () => ++version, revokePolicy: () => { permitted = false; },
    emit: (session, method, params) => graph.observe(session, method, params),
    opening: (id = "root", url = "https://root.test/root") => Object.freeze({ frameId: id, url }),
    capture(opening = f.opening(), value = candidate()) {
      const fence = graph.checkpointReadiness(opening); return graph.captureReadiness(fence, value, opening);
    },
    navigate(session = undefined, id = "root", parent = undefined, loader = "successor-loader", url = "https://root.test/next", uniqueId = "successor-context") {
      f.version();
      graph.observe(session, "Page.frameStartedNavigating", { frameId: id, loaderId: loader, url, navigationType: "differentDocument" });
      if (id === "root") graph.observe(session, "Runtime.executionContextsCleared", {});
      graph.observe(session, "Page.frameNavigated", { frame: frame(id, parent, loader, url), type: "Navigation" });
      graph.observe(session, "Runtime.executionContextCreated", { context: context(id, uniqueId, new URL(url).origin) });
      return f.opening(id, url);
    }
  };
  return f;
}

test("a snapshot seeds only its unchanged original document; readiness needs no renderer call or first frame", async () => {
  const f = await fixture(), count = f.calls.length;
  const proof = f.capture(); f.graph.assertReadiness(proof);
  assert.deepEqual(proof.actualOrigins, ["https://root.test"]);
  assert.equal(f.calls.length, count);
  assert.ok(!f.calls.some(call => call.method.startsWith("Input.") || call.method === "Page.startScreencast"));
});

test("the original warm root commit and fresh context prove a successor while renderer metadata remains unavailable", async () => {
  const f = await fixture(), old = f.capture(), calls = f.calls.length;
  const opening = f.navigate(), proof = f.capture(opening, f.candidate("browser-successor", opening.url));
  f.graph.assertReadiness(proof); assert.throws(() => f.graph.assertReadiness(old), /UNSUPPORTED|navigation version/);
  assert.equal(f.calls.length, calls, "new document proof sends no command");
});

test("same-URL reload requires a new loader, unique context and browser document identity", async () => {
  const f = await fixture(), url = "https://root.test/root";
  const opening = f.navigate(undefined, "root", undefined, "reload-loader", url, "reload-context");
  const fence = f.graph.checkpointReadiness(opening);
  assert.throws(() => f.graph.captureReadiness(fence, f.candidate(), opening), /UNSUPPORTED/, "late old browser document cannot bind new native loader");
  const proof = f.graph.captureReadiness(fence, f.candidate("reload-document"), opening);
  f.graph.assertReadiness(proof);
});

for (const kind of ["commit", "replace-context", "destroy-context", "clear-context", "detach", "pending-navigation"]) {
  test(`a fence captured at Opening rejects ${kind} during browser validation`, async () => {
    const f = await fixture(), opening = f.opening(), fence = f.graph.checkpointReadiness(opening);
    if (kind === "commit") f.navigate();
    if (kind === "replace-context") f.emit(undefined, "Runtime.executionContextCreated", { context: context("root", "new-default") });
    if (kind === "destroy-context") f.emit(undefined, "Runtime.executionContextDestroyed", { executionContextId: 1, executionContextUniqueId: "context-root" });
    if (kind === "clear-context") f.emit(undefined, "Runtime.executionContextsCleared", {});
    if (kind === "detach") f.graph.detached();
    if (kind === "pending-navigation") f.emit(undefined, "Page.frameStartedNavigating", { frameId: "root", loaderId: "pending", url: opening.url });
    assert.throws(() => f.graph.captureReadiness(fence, f.candidate(), opening), /UNSUPPORTED/);
  });
}

test("browser navigation and site policy remain separately fenced after native capture", async () => {
  const f = await fixture({ policy: true }), proof = f.capture();
  f.version(); assert.throws(() => f.graph.assertReadiness(proof), /navigation version/);
  const next = f.capture(); f.revokePolicy(); assert.throws(() => f.graph.assertReadiness(next), /policy changed/);
});

for (const kind of ["old-unique-id", "created-before-commit", "reused-loader", "opaque-origin", "url-origin-disagreement"]) {
  test(`event readiness rejects ${kind} without weakening the existing active graph`, async () => {
    const f = await fixture(), url = "https://root.test/next", loader = kind === "reused-loader" ? "loader-root" : "new-loader";
    f.version(); f.emit(undefined, "Page.frameStartedNavigating", { frameId: "root", loaderId: loader, url });
    if (kind === "created-before-commit") f.emit(undefined, "Runtime.executionContextCreated", { context: context("root", "out-of-order") });
    f.emit(undefined, "Page.frameNavigated", { frame: frame("root", undefined, loader, url) });
    const uniqueId = kind === "old-unique-id" ? "context-root" : kind === "created-before-commit" ? "out-of-order" : "new-context";
    const actualOrigin = kind === "opaque-origin" ? "://" : kind === "url-origin-disagreement" ? "https://different.test" : "https://root.test";
    f.emit(undefined, "Runtime.executionContextCreated", { context: context("root", uniqueId, actualOrigin) });
    assert.throws(() => f.graph.checkpointReadiness(f.opening("root", url)), /UNSUPPORTED/);
  });
}

for (const remote of [false, true]) {
  test(`${remote ? "owned remote" : "local"} child preserves its complete original ancestry and can navigate independently`, async () => {
    const f = await fixture({ remote, local: !remote }), origin = remote ? "https://child.test" : "https://root.test";
    const initial = f.capture(f.opening("child", `${origin}/child`));
    assert.deepEqual(initial.actualOrigins, [origin, "https://root.test"]);
    const opening = f.navigate(remote ? "remote" : undefined, "child", "root", "next-child-loader", `${origin}/next`, "next-child-context");
    const proof = f.capture(opening); f.graph.assertReadiness(proof);
    assert.throws(() => f.graph.assertReadiness(initial), /UNSUPPORTED|navigation version/);
  });
}

test("a parent replacement cannot migrate an old remote session even with fresh same-URL child events", async () => {
  const f = await fixture({ remote: true }); f.navigate();
  const opening = f.navigate("remote", "child", "root", "fresh-child", "https://child.test/child", "fresh-child-context");
  assert.equal(f.graph.owns("remote"), true, "original session still owns actual cleanup");
  assert.throws(() => f.graph.checkpointReadiness(opening), /UNSUPPORTED/);
});

test("isolated contexts cannot change the original Opening fence or substitute an origin", async () => {
  const f = await fixture(), opening = f.opening(), fence = f.graph.checkpointReadiness(opening);
  f.emit(undefined, "Runtime.executionContextCreated", { context: { ...context("root", "isolated", "https://foreign.test"), auxData: { frameId: "root", isDefault: false } } });
  f.graph.assertReadiness(f.graph.captureReadiness(fence, f.candidate(), opening));
});

test("foreign fences, altered Opening and absent or mismatched browser version cannot create authority", async () => {
  const f = await fixture({ policy: true }), opening = f.opening(), fence = f.graph.checkpointReadiness(opening);
  assert.throws(() => f.graph.captureReadiness({}, f.candidate(), opening), /UNSUPPORTED/);
  assert.throws(() => f.graph.captureReadiness(fence, f.candidate(), { ...opening, url: opening.url + "?other" }), /UNSUPPORTED/);
  assert.throws(() => f.graph.captureReadiness(fence, { ...f.candidate(), navigationVersion: undefined }, opening));
  assert.throws(() => f.graph.captureReadiness(fence, { ...f.candidate(), siteProof: { documentId: "other", version: 0 } }, opening), /UNSUPPORTED/);
});

test("the original candidate and policy version cannot be mutated to grant an old proof a later browser version", async () => {
  const f = await fixture({ policy: true }), opening = f.opening();
  const value = { ...f.candidate(), siteProof: { ...f.candidate().siteProof } };
  const proof = f.graph.captureReadiness(f.graph.checkpointReadiness(opening), value, opening);
  value.navigationVersion = f.version(); value.siteProof.version = value.navigationVersion;
  assert.throws(() => f.graph.assertReadiness(proof), /navigation version/);
});

test("cold native commit observations cannot be promoted by a later setup ACK without a fresh snapshot", async () => {
  const calls = [], root = frame("root"), opening = { frameId: "root", url: root.url };
  const graph = new ManagedHumanDocumentGraph({ check() {}, assertCandidate() {}, send: async (_session, method, _params, check) => {
    check(); calls.push(method); return method === "Page.getFrameTree" ? tree(root) : {};
  } });
  graph.observe(undefined, "Page.frameStartedNavigating", { frameId: "root", loaderId: root.loaderId, url: root.url });
  graph.observe(undefined, "Page.frameNavigated", { frame: root });
  graph.observe(undefined, "Runtime.executionContextCreated", { context: context("root") });
  await graph.start(); assert.throws(() => graph.checkpointReadiness(opening), /UNSUPPORTED/);
  const value = Object.freeze({ documentId: "original-browser-document", navigationVersion: 0, url: root.url });
  await graph.snapshot(value);
  const proof = graph.captureReadiness(graph.checkpointReadiness(opening), value, opening);
  graph.assertReadiness(proof); assert.equal(calls.filter(method => method === "Page.getFrameTree").length, 2);
});

test("a missing initial context requires a new successful snapshot, never late repair of the prior snapshot", async () => {
  const f = await fixture(), opening = f.opening("new-child", "https://root.test/new-child");
  f.trees.set(undefined, tree(frame("root"), [frame("new-child", "root")]));
  await f.graph.snapshot(f.candidate()); assert.throws(() => f.graph.checkpointReadiness(opening), /UNSUPPORTED/);
  f.emit(undefined, "Runtime.executionContextCreated", { context: context("new-child", "first-new-child", "https://root.test", 2) });
  assert.throws(() => f.graph.checkpointReadiness(opening), /UNSUPPORTED/, "a Created cannot repair the previous snapshot");
  await f.graph.snapshot(f.candidate()); f.graph.assertReadiness(f.capture(opening));
});

test("an incomplete optional readiness event never weakens or disables the existing active graph route", async () => {
  const f = await fixture();
  f.emit(undefined, "Page.frameStartedNavigating", { frameId: "unrelated" });
  assert.throws(() => f.graph.checkpointReadiness(f.opening()), /UNSUPPORTED/);
  const snapshot = await f.graph.snapshot();
  f.graph.assert(f.graph.capture(snapshot, f.opening()));
  assert.deepEqual(f.failures, []);
});

test("child snapshots cannot authorize a missing ancestor context or repair one after the original Opening", async () => {
  const f = await fixture({ remote: true }), opening = f.opening("child", "https://child.test/child");
  const fence = f.graph.checkpointReadiness(opening);
  f.emit(undefined, "Runtime.executionContextDestroyed", { executionContextId: 1, executionContextUniqueId: "context-root" });
  f.emit(undefined, "Runtime.executionContextCreated", { context: context("root", "fresh-root") });
  await f.graph.snapshot(f.candidate());
  assert.throws(() => f.graph.captureReadiness(fence, f.candidate(), opening), /UNSUPPORTED/);
  assert.throws(() => f.graph.checkpointReadiness(opening), /UNSUPPORTED/, "a formerly usable event identity keeps its original context");
});

test("a new commit before the first snapshot cannot adopt the reserved initial same-URL browser document", async () => {
  const graph = new ManagedHumanDocumentGraph({ check() {}, assertCandidate() {}, send: async (_session, _method, _params, check) => { check(); return {}; } });
  await graph.start({ documentId: "initial-document" });
  const root = frame("root", undefined, "fresh-loader"), opening = { frameId: "root", url: root.url };
  graph.observe(undefined, "Page.frameStartedNavigating", { frameId: "root", loaderId: root.loaderId, url: root.url });
  graph.observe(undefined, "Page.frameNavigated", { frame: root });
  graph.observe(undefined, "Runtime.executionContextCreated", { context: context("root", "fresh-context") });
  const fence = graph.checkpointReadiness(opening);
  assert.throws(() => graph.captureReadiness(fence, { documentId: "initial-document", navigationVersion: 1, url: root.url }, opening), /UNSUPPORTED/);
  const proof = graph.captureReadiness(fence, { documentId: "fresh-document", navigationVersion: 1, url: root.url }, opening);
  graph.assertReadiness(proof);
});

test("nested remote readiness freezes every original session and ancestor context", async () => {
  const f = await fixture({ remote: true });
  f.trees.set("nested", tree(frame("nested", "child", "loader-nested", "https://child.test/nested")));
  f.emit("remote", "Target.attachedToTarget", { sessionId: "nested", waitingForDebugger: false,
    targetInfo: { type: "iframe", targetId: "nested", parentFrameId: "child" } });
  await f.graph.drain(); await f.graph.snapshot(f.candidate());
  const opening = f.opening("nested", "https://child.test/nested"), proof = f.capture(opening);
  assert.deepEqual(proof.actualOrigins, ["https://child.test", "https://child.test", "https://root.test"]);
  f.emit("remote", "Runtime.executionContextDestroyed", { executionContextId: 1, executionContextUniqueId: "child-original" });
  assert.throws(() => f.graph.assertReadiness(proof), /UNSUPPORTED/);
  assert.throws(() => f.graph.checkpointReadiness(opening), /UNSUPPORTED/);
});

test("native frame or screencast ACK without an original default context never supplies readiness authority", async () => {
  const graph = new ManagedHumanDocumentGraph({ check() {}, assertCandidate() {}, send: async () => ({}) });
  await graph.start({ documentId: "initial-document" });
  const root = frame("root", undefined, "new-loader"), opening = { frameId: "root", url: root.url };
  graph.observe(undefined, "Page.frameStartedNavigating", { frameId: "root", loaderId: root.loaderId, url: root.url });
  graph.observe(undefined, "Page.frameNavigated", { frame: root });
  graph.observe(undefined, "Page.screencastFrame", { data: "not-authority", metadata: { deviceWidth: 800, deviceHeight: 600 } });
  assert.throws(() => graph.checkpointReadiness(opening), /UNSUPPORTED/);
  graph.observe(undefined, "Runtime.executionContextCreated", { context: { ...context("root", "isolated"), auxData: { frameId: "root", isDefault: false } } });
  assert.throws(() => graph.checkpointReadiness(opening), /UNSUPPORTED/);
});

test("pending navigation capacity is global across original sessions and does not evict older evidence", async () => {
  const f = await fixture({ remote: true });
  for (let index = 0; index < 1001; index++) {
    f.emit(index % 2 ? "remote" : undefined, "Page.frameStartedNavigating", {
      frameId: `pending-${index}`, loaderId: `loader-${index}`, url: `https://root.test/${index}`
    });
    if (index === 999) assert.ok(f.graph.checkpointReadiness(f.opening()));
  }
  assert.throws(() => f.graph.checkpointReadiness(f.opening()), /UNSUPPORTED/);
  assert.deepEqual(f.failures, []);
});

test("a detached remote session stays retired while a fresh owned session may prove the same frame", async () => {
  const f = await fixture({ remote: true }), opening = f.opening("child", "https://child.test/child");
  const original = f.capture(opening);
  f.emit(undefined, "Target.detachedFromTarget", { sessionId: "remote", targetId: "child" });
  f.trees.set("replacement", tree(frame("child", "root", "fresh-child-loader", opening.url)));
  f.emit(undefined, "Target.attachedToTarget", { sessionId: "replacement", waitingForDebugger: false,
    targetInfo: { type: "iframe", targetId: "child", parentFrameId: "root" } });
  await f.graph.drain(); await f.graph.snapshot(f.candidate());
  f.graph.assertReadiness(f.capture(opening));
  assert.throws(() => f.graph.assertReadiness(original), /UNSUPPORTED/);
  assert.equal(f.emit("remote", "Runtime.executionContextCreated", { context: context("child", "late-original") }), false);
});
