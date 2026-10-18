import assert from "node:assert/strict";
import test from "node:test";
import { ManagedHumanDocumentGraph } from "./managed-human-document-graph.js";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const frame = (id, parentId, origin = "https://root.test") => ({ id, ...(parentId ? { parentId } : {}), loaderId: `loader-${id}`,
  url: `${origin}/${id}`, securityOrigin: origin });
const context = (id, origin = "https://root.test", extra = {}) => ({ id: 1, uniqueId: `context-${id}`, origin,
  auxData: { isDefault: true, frameId: id }, ...extra });
const tree = (root, children = []) => ({ frameTree: { frame: root, ...(children.length ? { childFrames: children.map(child => ({ frame: child })) } : {}) } });

function fixture(options = {}) {
  const calls = [], failures = [], changes = [], trees = new Map([[undefined, tree(frame("root"))]]), contexts = new Map();
  let authorized = true;
  const graph = new ManagedHumanDocumentGraph({
    check: () => { if (!authorized) throw new Error("original authority revoked"); },
    onFailure: error => failures.push(error), onChange: change => changes.push(change),
    send: async (id, method, params, check) => {
      await options.beforeDispatch?.(id, method, params); check();
      calls.push({ id, method, params });
      const result = await options.command?.(id, method, params, f);
      if (method === "Runtime.enable") for (const value of contexts.get(id) ?? []) graph.observe(id, "Runtime.executionContextCreated", { context: value });
      return result ?? (method === "Page.getFrameTree" ? structuredClone(trees.get(id)) : {});
    }
  });
  const f = { graph, calls, failures, changes, trees, contexts,
    expire: () => { authorized = false; },
    created: (id, value) => graph.observe(id, "Runtime.executionContextCreated", { context: value }),
    attach: (id, parent, targetId, parentFrameId, values = {}) => graph.observe(parent, "Target.attachedToTarget", {
      sessionId: id, targetInfo: { type: "iframe", targetId, ...(parentFrameId ? { parentFrameId } : {}), ...values }, waitingForDebugger: false
    }),
    child: (id = "child-session", parent = undefined, targetId = "child", parentFrameId = "root", origin = "https://child.test") => {
      trees.set(id, tree(frame(targetId, parentFrameId, origin))); contexts.set(id, [context(targetId, origin)]);
      f.attach(id, parent, targetId, parentFrameId); return id;
    },
    capture: (snapshot, id = "child", url = "https://child.test/child") => graph.capture(snapshot, { frameId: id, url })
  };
  f.created(undefined, context("root"));
  return f;
}

test("root startup uses one narrow recursive auto-attach configuration and keeps original setup promises", async () => {
  const runtime = deferred();
  const f = fixture({ command(id, method, params, f) {
    if (id === undefined && method === "Target.setAutoAttach") f.child();
    if (id === "child-session" && method === "Runtime.enable") return runtime.promise;
  } });
  let complete = false; const start = f.graph.start().then(() => { complete = true; });
  await tick(); assert.equal(complete, false);
  assert.deepEqual(f.calls.map(call => [call.id, call.method]), [[undefined, "Target.setAutoAttach"], ["child-session", "Page.enable"], ["child-session", "Runtime.enable"]]);
  runtime.resolve(); await start;
  assert.deepEqual(f.calls.filter(call => call.method === "Target.setAutoAttach").map(call => call.params), [
    { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe", exclude: false }] },
    { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe", exclude: false }] }
  ]);
  assert.equal(f.graph.owns("child-session"), true);
  const proof = f.capture(await f.graph.snapshot()); f.graph.assert(proof);
  assert.deepEqual(proof.actualOrigins, ["https://child.test", "https://root.test"]);
  assert.equal(f.failures.length, 0);
});

test("nested remote sessions join through the observed parent and its actual local intermediate frame", async () => {
  const f = fixture({ command(id, method, params, f) {
    if (method !== "Target.setAutoAttach") return;
    if (id === undefined) {
      f.trees.set(undefined, tree(frame("root"), [frame("local", "root")])); f.created(undefined, context("local", "https://root.test", { id: 2 }));
      f.child("child-session", undefined, "child", "local");
    }
    if (id === "child-session") f.child("nested-session", id, "nested", "child", "https://nested.test");
  } });
  await f.graph.start(); const snapshot = await f.graph.snapshot(), proof = f.capture(snapshot, "nested", "https://nested.test/nested");
  assert.deepEqual(proof.actualOrigins, ["https://nested.test", "https://child.test", "https://root.test", "https://root.test"]);
  assert.deepEqual(JSON.parse(snapshot.rootDocument).map(row => row.slice(0, 2)), [["root", null], ["local", "root"]]);
  assert.equal(f.calls.filter(call => call.method === "Page.getFrameTree").length, 6);
});

test("numeric execution-context collisions in different sessions cannot destroy another document", async () => {
  const f = fixture(); f.child(); await f.graph.start();
  const snapshot = await f.graph.snapshot(), proof = f.capture(snapshot);
  f.graph.observe("child-session", "Runtime.executionContextDestroyed", { executionContextId: 1, executionContextUniqueId: "context-root" });
  f.graph.assert(proof);
  f.graph.observe("child-session", "Runtime.executionContextDestroyed", { executionContextId: 1 });
  assert.throws(() => f.graph.assert(proof), /UNSUPPORTED/);
  f.graph.assert(f.capture(snapshot, "root", "https://root.test/root"));
});

test("foreign sessions and nondefault worlds cannot change or authorize an original proof", async () => {
  const f = fixture(); f.child(); await f.graph.start(); const proof = f.capture(await f.graph.snapshot());
  assert.equal(f.graph.observe("foreign", "Runtime.executionContextsCleared"), false);
  assert.equal(f.graph.observe("foreign", "Target.attachedToTarget", { sessionId: "borrowed", targetInfo: { targetId: "other", type: "iframe" } }), false);
  f.created("child-session", context("child", "https://other.test", { uniqueId: "isolated", auxData: { isDefault: false, frameId: "child" } }));
  f.graph.assert(proof); assert.equal(f.graph.owns("borrowed"), false);
});

for (const method of ["Runtime.executionContextsCleared", "Runtime.executionContextDestroyed", "Runtime.executionContextCreated"]) {
  test(`${method} withdraws only the original current context proof without resurrecting it`, async () => {
    const f = fixture(); f.child(); await f.graph.start(); const snapshot = await f.graph.snapshot(), proof = f.capture(snapshot);
    const params = method.endsWith("Destroyed") ? { executionContextId: 1, executionContextUniqueId: "context-child" } :
      method.endsWith("Created") ? { context: context("child", "https://child.test", { uniqueId: "replacement" }) } : {};
    f.graph.observe("child-session", method, params);
    assert.throws(() => f.graph.assert(proof), /UNSUPPORTED/); assert.throws(() => f.capture(snapshot), /UNSUPPORTED/);
    f.created("child-session", context("child", "https://child.test")); assert.throws(() => f.capture(snapshot), /UNSUPPORTED/);
  });
}

for (const method of ["Page.frameStartedNavigating", "Page.frameNavigated", "Page.documentOpened", "Page.navigatedWithinDocument", "Page.frameAttached", "Page.frameDetached"]) {
  test(`${method} invalidates a graph proof before a queued answer can dispatch`, async () => {
    const f = fixture(); f.child(); await f.graph.start(); const proof = f.capture(await f.graph.snapshot());
    f.graph.observe("child-session", method, { frameId: "child", frame: frame("child", "root", "https://child.test") });
    assert.throws(() => f.graph.assert(proof), /UNSUPPORTED/);
  });
}

test("parent replacement clears original remote contexts and cannot rebind them by frame ID", async () => {
  const f = fixture(); f.child(); await f.graph.start(); const proof = f.capture(await f.graph.snapshot());
  f.graph.observe(undefined, "Page.frameNavigated", { frame: { ...frame("root"), loaderId: "successor-root" } });
  f.trees.set(undefined, tree({ ...frame("root"), loaderId: "successor-root" }));
  f.created(undefined, context("root", "https://root.test", { uniqueId: "new-root" }));
  assert.equal(f.graph.owns("child-session"), true, "native session still belongs to cleanup");
  const oldChild = await f.graph.snapshot();
  assert.throws(() => f.capture(oldChild), /UNSUPPORTED/); assert.throws(() => f.graph.assert(proof), /UNSUPPORTED/);
  f.created("child-session", context("child", "https://child.test"));
  const replayedChild = await f.graph.snapshot(); assert.throws(() => f.capture(replayedChild), /UNSUPPORTED/);
  f.created("child-session", context("child", "https://child.test", { uniqueId: "new-child" }));
  const lateFirstContext = await f.graph.snapshot();
  assert.throws(() => f.capture(lateFirstContext), /UNSUPPORTED/, "a first late cross-session Created cannot migrate the old session to a new parent document");
  f.graph.observe(undefined, "Target.detachedFromTarget", { sessionId: "child-session" });
  f.child("successor-session"); await f.graph.drain();
  f.graph.assert(f.capture(await f.graph.snapshot()));
});

test("two complete reads use a single graph revision, including changes in a previously read session", async () => {
  let reads = 0;
  const f = fixture({ command(id, method, params, f) {
    if (method === "Page.getFrameTree" && ++reads === 2) f.created(undefined, context("root", "https://root.test", { uniqueId: "during-child-read" }));
  } });
  f.child(); await f.graph.start(); assert.equal(await f.graph.snapshot(), null);
});

test("a changed second native tree cannot publish a snapshot even without an event", async () => {
  let reads = 0; const f = fixture({ command(id, method) {
    if (method === "Page.getFrameTree" && ++reads === 2) return tree({ ...frame("root"), loaderId: "changed" });
  } });
  await f.graph.start(); assert.equal(await f.graph.snapshot(), null);
});

for (const kind of ["missing-parent", "wrong-parent-session", "duplicate-frame", "wrong-child-root", "parent-disagreement"]) {
  test(`native graph rejects ${kind} instead of guessing ancestry`, async () => {
    const f = fixture();
    if (kind === "wrong-parent-session") {
      f.trees.set("child-session", tree(frame("child", "sibling", "https://child.test")));
      f.contexts.set("child-session", [context("child", "https://child.test")]);
      f.attach("child-session", undefined, "child");
    } else f.child();
    if (kind === "missing-parent") f.trees.get("child-session").frameTree.frame.parentId = "missing";
    if (kind === "wrong-parent-session") {
      f.child("sibling-session", undefined, "sibling", "root", "https://sibling.test");
    }
    if (kind === "duplicate-frame") f.trees.set(undefined, tree(frame("root"), [frame("child", "root", "https://child.test")]));
    if (kind === "wrong-child-root") f.trees.get("child-session").frameTree.frame.id = "other";
    if (kind === "parent-disagreement") f.trees.get("child-session").frameTree.frame.parentId = "other-parent";
    await f.graph.start(); await assert.rejects(f.graph.snapshot(), /UNSUPPORTED/);
  });
}

test("child parent may be proved by its native tree when TargetInfo omits experimental parentFrameId", async () => {
  const f = fixture(); f.trees.set("s", tree(frame("child", "root", "https://child.test"))); f.contexts.set("s", [context("child", "https://child.test")]);
  f.attach("s", undefined, "child"); await f.graph.start(); f.graph.assert(f.capture(await f.graph.snapshot()));
});

test("retired session IDs and late events cannot be adopted by a successor attachment", async () => {
  const f = fixture(); f.child(); await f.graph.start(); const proof = f.capture(await f.graph.snapshot());
  assert.equal(f.graph.observe("child-session", "Target.detachedFromTarget", { sessionId: "child-session" }), false, "only original parent may detach");
  assert.equal(f.graph.observe(undefined, "Target.detachedFromTarget", { sessionId: "child-session", targetId: "foreign" }), false);
  assert.equal(f.graph.observe(undefined, "Target.detachedFromTarget", { sessionId: "child-session", targetId: "child" }), true);
  assert.equal(f.graph.owns("child-session"), false); assert.throws(() => f.graph.assert(proof), /UNSUPPORTED/);
  assert.equal(f.created("child-session", context("child", "https://child.test")), false);
  f.attach("child-session", undefined, "child", "root"); assert.equal(f.failures.length, 1);
  assert.throws(() => f.graph.assert(proof), /UNSUPPORTED/);
});

for (const actual of ["null", "", "file://", "https://mismatch.test", "https://child.test/path"]) {
  test(`actual context origin ${JSON.stringify(actual)} cannot be replaced by a permitted URL`, async () => {
    const f = fixture(); f.child(); f.contexts.set("child-session", [context("child", actual)]); await f.graph.start();
    const snapshot = await f.graph.snapshot(); assert.throws(() => f.capture(snapshot), /UNSUPPORTED/);
  });
}

for (const inherited of ["about:blank", "about:srcdoc"]) test(`${inherited} needs the actual proven parent's origin`, async () => {
  const f = fixture(); f.child("s", undefined, "child", "root", "https://root.test"); f.trees.get("s").frameTree.frame.url = inherited;
  await f.graph.start(); const proof = f.capture(await f.graph.snapshot(), "child", inherited); f.graph.assert(proof);
  f.created("s", context("child", "https://other.test", { uniqueId: "replacement" }));
  const next = await f.graph.snapshot(); assert.throws(() => f.capture(next, "child", inherited), /UNSUPPORTED/);
});

test("every ancestor needs its own live default context, not just a permitted leaf origin", async () => {
  const f = fixture(); f.child(); await f.graph.start(); f.graph.observe(undefined, "Runtime.executionContextsCleared");
  const snapshot = await f.graph.snapshot(); assert.throws(() => f.capture(snapshot), /UNSUPPORTED/);
});

test("exact emitter URL and proof ownership are checked without any modal-time native reads", async () => {
  const f = fixture(); f.child(); await f.graph.start(); const snapshot = await f.graph.snapshot(), before = f.calls.length;
  const proof = f.capture(snapshot); f.graph.assert(proof);
  assert.throws(() => f.capture(snapshot, "child", "https://child.test/child#new"), /UNSUPPORTED/);
  assert.throws(() => f.graph.assert({ actualOrigins: proof.actualOrigins }), /UNSUPPORTED/);
  const other = fixture(); assert.throws(() => other.graph.assert(proof), /UNSUPPORTED/);
  assert.equal(f.calls.length, before);
  f.expire(); assert.throws(() => f.graph.assert(proof), /authority revoked/);
});

test("revoke before native setup dispatch prevents new commands but drain waits original dispatched work", async () => {
  const page = deferred(); const f = fixture({ command(id, method) { if (id === "s" && method === "Page.enable") return page.promise; } });
  f.child("s"); await tick(); f.graph.revoke(); let drained = false;
  const drain = f.graph.drain().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
  page.resolve(); await drain;
  assert.deepEqual(f.calls.map(call => call.method), ["Page.enable"]);
  assert.equal(f.failures.length, 0); assert.equal(f.graph.owns("s"), true);
  f.graph.detached(); assert.equal(f.graph.owns("s"), false);
});

test("revoke at the final native dispatch guard sends nothing and never fabricates an ACK", async () => {
  const admission = deferred(); const f = fixture({ beforeDispatch(id) { if (id === "s") return admission.promise; } });
  f.child("s"); f.graph.revoke(); admission.resolve(); await f.graph.drain();
  assert.equal(f.calls.length, 0); assert.equal(f.failures.length, 0);
});

test("late auto-attachment after revoke is cleanup-only, and actual root detach ends all event admission", async () => {
  const f = fixture(); await f.graph.start(); f.graph.revoke(); const before = f.calls.length;
  f.child(); await f.graph.drain(); assert.equal(f.graph.owns("child-session"), true); assert.equal(f.calls.length, before);
  f.graph.detached(); assert.equal(f.graph.owns(undefined), false);
  assert.equal(f.attach("late", undefined, "late", "root"), false); assert.equal(f.graph.owns("late"), false);
  assert.equal(f.calls.length, before);
});

test("setup rejection is preserved and notified once; cleanup can still join it and detach", async () => {
  const original = new Error("native enable rejected");
  const f = fixture({ command(id, method) { if (id === "s" && method === "Runtime.enable") throw original; } });
  f.child("s"); await assert.rejects(f.graph.start()); await f.graph.drain();
  assert.deepEqual(f.failures, [original]); assert.equal(f.graph.failure, original);
  f.graph.revoke(); f.graph.detached(); assert.equal(f.graph.owns("s"), false);
});

for (const invalid of ["worker", "duplicate-target", "waiting", "empty-id", "foreign-parent"]) {
  test(`native attachment ${invalid} never grants a new document`, async () => {
    const f = fixture();
    if (invalid === "foreign-parent") { assert.equal(f.attach("s", "foreign", "child", "root"), false); assert.equal(f.graph.owns("s"), false); return; }
    if (invalid === "duplicate-target") { f.child("s"); f.attach("s2", undefined, "child", "root"); }
    else f.graph.observe(undefined, "Target.attachedToTarget", { sessionId: invalid === "empty-id" ? "" : "s",
      waitingForDebugger: invalid === "waiting", targetInfo: { type: invalid === "worker" ? "worker" : "iframe", targetId: "child" } });
    assert.equal(f.failures.length, 1); await f.graph.drain();
    await assert.rejects(f.graph.start(), /UNSUPPORTED/);
  });
}

test("session tombstone capacity is bounded and cannot evict a retired identity", async () => {
  const f = fixture(); f.graph.revoke();
  for (let index = 0; index < 4095; index++) {
    f.attach(`s${index}`, undefined, `f${index}`, "root");
    f.graph.observe(undefined, "Target.detachedFromTarget", { sessionId: `s${index}` });
  }
  assert.equal(f.graph.seen.size, 4096); f.attach("overflow", undefined, "extra", "root");
  assert.equal(f.graph.seen.size, 4096); assert.equal(f.graph.owns("overflow"), false); assert.equal(f.failures.length, 1);
});

test("context identity capacity belongs to the whole attachment, including retired child sessions", async () => {
  const f = fixture(); f.child("s1"); f.child("s2", undefined, "sibling", "root", "https://sibling.test");
  await f.graph.start();
  for (let index = 0; index < 4093; index++) f.created(index % 2 ? "s1" : "s2",
    context(index % 2 ? "child" : "sibling", index % 2 ? "https://child.test" : "https://sibling.test", { uniqueId: `original-${index}` }));
  assert.equal(f.graph.contextIdentities, 4096); assert.equal(f.failures.length, 0);
  f.graph.observe(undefined, "Target.detachedFromTarget", { sessionId: "s1" });
  f.child("s3", undefined, "replacement", "root", "https://replacement.test"); await f.graph.drain();
  assert.equal(f.graph.contextIdentities, 4096); assert.equal(f.failures.length, 1);
  assert.equal(f.graph.sessions.get("s3").contexts.records.size, 0);
  assert.ok(f.graph.sessions.get("s1").contexts.records.size > 0, "retired identities were not evicted");
});

for (const kind of ["destroyed", "replacement", "first-default", "cleared", "target-attached", "target-detached"]) {
  test(`original input identity fence rejects ${kind} without needing a dialog snapshot`, async () => {
    const f = fixture(); f.child(); await f.graph.start(); const fence = f.graph.captureIdentity();
    if (kind === "destroyed") f.graph.observe("child-session", "Runtime.executionContextDestroyed", { executionContextId: 1 });
    if (kind === "replacement") f.created("child-session", context("child", "https://child.test", { uniqueId: "successor" }));
    if (kind === "first-default") f.created("child-session", context("new-local", "https://child.test", { id: 2, uniqueId: "first" }));
    if (kind === "cleared") f.graph.observe("child-session", "Runtime.executionContextsCleared");
    if (kind === "target-attached") f.child("other", undefined, "other", "root", "https://other.test");
    if (kind === "target-detached") f.graph.observe(undefined, "Target.detachedFromTarget", { sessionId: "child-session" });
    assert.throws(() => f.graph.assertIdentity(fence), /UNSUPPORTED/);
    await f.graph.drain(); assert.throws(() => f.graph.assertIdentity(fence), /UNSUPPORTED/);
  });
}

test("identity fence survives isolated-world noise but never grants origin or emitter authority", async () => {
  const f = fixture(); f.child(); f.contexts.set("child-session", [context("child", "null")]); await f.graph.start();
  const fence = f.graph.captureIdentity();
  f.created("child-session", context("child", "https://child.test", { id: 2, uniqueId: "isolated", auxData: { isDefault: false, frameId: "child" } }));
  f.graph.assertIdentity(fence);
  assert.throws(() => f.graph.capture(fence, { frameId: "child", url: "https://child.test/child" }), /UNSUPPORTED/);
  const snapshot = await f.graph.snapshot(); assert.throws(() => f.capture(snapshot), /UNSUPPORTED/);
  assert.throws(() => f.graph.assertIdentity(snapshot), /UNSUPPORTED/);
  assert.throws(() => fixture().graph.assertIdentity(fence), /UNSUPPORTED/);
});

async function preparationFixture({ local = false, remote = false } = {}) {
  const f = fixture();
  if (local) {
    f.trees.set(undefined, tree(frame("root"), [frame("local", "root")]));
    f.created(undefined, context("local", "https://root.test", { id: 2 }));
  }
  if (remote) f.child();
  await f.graph.start(); await f.graph.snapshot();
  const id = remote ? "child" : local ? "local" : "root", session = remote ? "child-session" : undefined;
  const next = { ...frame(id, id === "root" ? undefined : "root", remote ? "https://child.test" : "https://root.test"), loaderId: "new-original-loader" };
  f.graph.observe(session, "Page.frameStartedNavigating", { frameId: id, loaderId: next.loaderId });
  f.graph.observe(session, "Page.frameNavigated", { frame: next });
  const first = () => f.created(session, context(id, remote ? "https://child.test" : "https://root.test", { id: 3, uniqueId: "first-original-context" }));
  return Object.assign(f, { id, session, next, first });
}

for (const scope of ["root", "local", "remote"]) test(`preparation waits for the original committed ${scope} default once without renderer reads`, async () => {
  const f = await preparationFixture({ local: scope === "local", remote: scope === "remote" }), count = f.calls.length;
  const originalStrict = f.graph.captureIdentity(), ticket = f.graph.checkpointPreparationIdentity();
  assert.equal(f.graph.capturePreparationIdentity(ticket), null);
  f.created(f.session, context(f.id, "https://isolated.test", { uniqueId: "isolated", auxData: { frameId: f.id, isDefault: false } }));
  assert.equal(f.graph.capturePreparationIdentity(ticket), null);
  f.first(); const identity = f.graph.capturePreparationIdentity(ticket);
  assert.ok(identity); f.graph.assertIdentity(identity);
  assert.equal(f.graph.capturePreparationIdentity(ticket), identity, "a mature ticket returns its same immutable identity");
  assert.throws(() => f.graph.assertIdentity(originalStrict), /UNSUPPORTED/, "the prior empty identity never accepts growth");
  assert.equal(f.calls.length, count, "no metadata commands or input are dispatched while waiting");
  f.created(f.session, context(f.id, "https://root.test", { uniqueId: "replacement-after-ready" }));
  assert.throws(() => f.graph.capturePreparationIdentity(ticket), /UNSUPPORTED/);
  assert.throws(() => f.graph.assertIdentity(identity), /UNSUPPORTED/);
});

for (const change of ["clear", "destroy", "commit", "start", "attach-frame", "detach-frame", "replace-existing", "new-unrelated-default", "target-attach", "target-detach", "revoke", "detach"]) {
  test(`preparation cannot repair its original missing slot after ${change}`, async () => {
    const f = await preparationFixture({ local: true });
    const ticket = f.graph.checkpointPreparationIdentity();
    assert.equal(f.graph.capturePreparationIdentity(ticket), null);
    if (change === "clear") f.graph.observe(undefined, "Runtime.executionContextsCleared");
    if (change === "destroy") f.graph.observe(undefined, "Runtime.executionContextDestroyed", { executionContextId: 999, executionContextUniqueId: "unknown-original" });
    if (change === "commit") f.graph.observe(undefined, "Page.frameNavigated", { frame: { ...f.next, loaderId: "later-loader" } });
    if (change === "start") f.graph.observe(undefined, "Page.frameStartedNavigating", { frameId: f.id, loaderId: "later-loader" });
    if (change === "attach-frame") f.graph.observe(undefined, "Page.frameAttached", { frameId: "new-frame", parentFrameId: "root" });
    if (change === "detach-frame") f.graph.observe(undefined, "Page.frameDetached", { frameId: f.id });
    if (change === "replace-existing") f.created(undefined, context("root", "https://root.test", { uniqueId: "replacement-root" }));
    if (change === "new-unrelated-default") f.created(undefined, context("unrelated", "https://root.test", { uniqueId: "unrelated", id: 4 }));
    if (change === "target-attach") { f.child(); await f.graph.drain(); }
    if (change === "target-detach") { f.child(); await f.graph.drain(); f.graph.observe(undefined, "Target.detachedFromTarget", { sessionId: "child-session", targetId: "child" }); }
    if (change === "revoke") f.graph.revoke();
    if (change === "detach") f.graph.detached();
    f.first(); assert.throws(() => f.graph.capturePreparationIdentity(ticket), /UNSUPPORTED/);
  });
}

test("a default replaced before ticket polling cannot become the original first default", async () => {
  const f = await preparationFixture(), ticket = f.graph.checkpointPreparationIdentity();
  f.first(); f.created(undefined, context("root", "https://root.test", { uniqueId: "second-default" }));
  assert.throws(() => f.graph.capturePreparationIdentity(ticket), /UNSUPPORTED/);
});

test("multiple original preparation gaps finish independently across session-local context IDs", async () => {
  const f = await preparationFixture({ local: true }); f.child(); await f.graph.drain(); await f.graph.snapshot();
  const next = { ...frame("child", "root", "https://child.test"), loaderId: "next-remote-loader" };
  f.graph.observe("child-session", "Page.frameStartedNavigating", { frameId: "child", loaderId: next.loaderId });
  f.graph.observe("child-session", "Page.frameNavigated", { frame: next });
  const ticket = f.graph.checkpointPreparationIdentity(), count = f.calls.length;
  assert.equal(f.graph.capturePreparationIdentity(ticket), null);
  f.first(); assert.equal(f.graph.capturePreparationIdentity(ticket), null);
  f.created("child-session", context("child", "https://child.test", { id: 3, uniqueId: "remote-first-original" }));
  const identity = f.graph.capturePreparationIdentity(ticket); assert.ok(identity); f.graph.assertIdentity(identity);
  assert.equal(f.calls.length, count);
  assert.throws(() => f.graph.captureReadiness(identity, {}, { frameId: "child", url: next.url }), /UNSUPPORTED/,
    "input identity maturity grants no original dialog or site permission proof");
});

test("a preparation ticket belongs only to its original graph attachment", async () => {
  const first = await preparationFixture(), second = await preparationFixture();
  const ticket = first.graph.checkpointPreparationIdentity();
  second.first(); assert.throws(() => second.graph.capturePreparationIdentity(ticket), /UNSUPPORTED/);
  assert.equal(first.graph.capturePreparationIdentity(ticket), null);
  first.first(); first.graph.assertIdentity(first.graph.capturePreparationIdentity(ticket));
});

test("no explicit committed context gap preserves the existing strict cold identity contract", async () => {
  const f = fixture(); await f.graph.start(); await f.graph.snapshot();
  f.graph.observe(undefined, "Runtime.executionContextsCleared");
  const ticket = f.graph.checkpointPreparationIdentity(), identity = f.graph.capturePreparationIdentity(ticket);
  assert.ok(identity); f.graph.assertIdentity(identity);
  f.created(undefined, context("root", "https://root.test", { uniqueId: "late-cold-context" }));
  assert.throws(() => f.graph.capturePreparationIdentity(ticket), /UNSUPPORTED/);
  assert.throws(() => f.graph.assertIdentity(identity), /UNSUPPORTED/);
  assert.throws(() => f.graph.capturePreparationIdentity({}), /UNSUPPORTED/);
});

test("unavailable optional event evidence preserves new strict preparation but invalidates an existing wait ticket", async () => {
  const waiting = await preparationFixture(), ticket = waiting.graph.checkpointPreparationIdentity();
  waiting.graph.observe(undefined, "Page.frameStartedNavigating", { frameId: "unrelated" });
  assert.equal(waiting.graph.events.blocked, true);
  assert.throws(() => waiting.graph.capturePreparationIdentity(ticket), /UNSUPPORTED/);
  const fallback = waiting.graph.checkpointPreparationIdentity();
  const identity = waiting.graph.capturePreparationIdentity(fallback);
  assert.ok(identity); waiting.graph.assertIdentity(identity);
  waiting.first(); assert.throws(() => waiting.graph.capturePreparationIdentity(fallback), /UNSUPPORTED/,
    "optional fallback never accepts subsequent default growth");
});

test("a null dialog snapshot cannot repair the earlier input identity after context churn between tree reads", async () => {
  let reads = 0; const f = fixture({ command(id, method, params, f) {
    if (method === "Page.getFrameTree" && ++reads === 2) f.created("child-session", context("child", "https://child.test", { uniqueId: "during-prepare" }));
  } });
  f.child(); await f.graph.start(); const original = f.graph.captureIdentity();
  assert.equal(await f.graph.snapshot(), null);
  assert.throws(() => f.graph.assertIdentity(original), /UNSUPPORTED/);
  const successor = f.graph.captureIdentity(); f.graph.assertIdentity(successor);
  assert.throws(() => f.graph.assertIdentity(original), /UNSUPPORTED/);
});

async function rootHintFixture({ remote = false, local = false } = {}) {
  const f = fixture(), original = Object.freeze({ documentId: "browser-A", navigationVersion: 0, url: frame("root").url });
  if (local) {
    f.trees.set(undefined, tree(frame("root"), [frame("local-child", "root")]));
    f.created(undefined, context("local-child", "https://root.test", { id: 2 }));
  }
  if (remote) f.child();
  await f.graph.start(original); await f.graph.snapshot(original);
  const commit = ({ url = original.url, loaderId = "loader-B", uniqueId = "context-B", create = true } = {}) => {
    const next = { ...frame("root"), url, loaderId };
    f.graph.observe(undefined, "Page.frameStartedNavigating", { frameId: "root", loaderId, url });
    f.graph.observe(undefined, "Page.frameNavigated", { frame: next });
    f.trees.set(undefined, tree(next));
    if (create) f.created(undefined, context("root", new URL(url).origin, { uniqueId }));
    return Object.freeze({ documentId: "browser-B", navigationVersion: 1, url });
  };
  return Object.assign(f, { original, commit });
}

test("root URL hint pins the original bound document without native queries or authority mutation", async () => {
  const f = await rootHintFixture(), count = f.calls.length, root = f.graph.events.frames.get(f.graph.root).get("root");
  const binding = f.graph.events.bindings.get(root), documents = new Map(f.graph.events.rootDocuments);
  const expected = { ...f.original }, ticket = f.graph.checkpointRootDocumentHint(expected);
  assert.ok(ticket); expected.documentId = "changed-caller-object";
  f.graph.assertRootDocumentHint(ticket, f.original);
  assert.equal(f.calls.length, count);
  assert.equal(f.graph.events.bindings.get(root), binding);
  assert.deepEqual(f.graph.events.rootDocuments, documents);
  assert.throws(() => f.graph.assertIdentity(ticket), /UNSUPPORTED/, "a hint ticket grants no input identity");
  assert.throws(() => f.graph.captureReadiness(ticket, f.original, { frameId: "root", url: f.original.url }), /UNSUPPORTED/);
});

test("native successor B accepts proven browser B while original candidate A stays retired", async () => {
  const f = await rootHintFixture(), next = f.commit(), count = f.calls.length;
  const root = f.graph.events.frames.get(f.graph.root).get("root"), documents = new Map(f.graph.events.rootDocuments);
  assert.throws(() => f.graph.checkpointRootDocumentHint(f.original), /UNSUPPORTED/);
  const ticket = f.graph.checkpointRootDocumentHint(next); assert.ok(ticket);
  f.graph.assertRootDocumentHint(ticket, next);
  assert.equal(f.graph.events.bindings.get(root), undefined, "hint verification does not bind the new browser identity");
  assert.deepEqual(f.graph.events.rootDocuments, documents);
  assert.equal(f.calls.length, count);
  await f.graph.snapshot(next);
  f.graph.assertRootDocumentHint(ticket, next);
});

test("same-URL native A cannot adopt novel browser B, and late browser A cannot refill native B", async () => {
  const f = await rootHintFixture(), ticket = f.graph.checkpointRootDocumentHint(f.original);
  const novel = { ...f.original, documentId: "novel-browser-B" };
  assert.throws(() => f.graph.checkpointRootDocumentHint(novel), /UNSUPPORTED/);
  assert.throws(() => f.graph.assertRootDocumentHint(ticket, novel), /UNSUPPORTED/);
  const next = f.commit();
  assert.throws(() => f.graph.assertRootDocumentHint(ticket, f.original), /UNSUPPORTED/);
  assert.throws(() => f.graph.checkpointRootDocumentHint(f.original), /UNSUPPORTED/);
  const successor = f.graph.checkpointRootDocumentHint(next); f.graph.assertRootDocumentHint(successor, next);
  assert.throws(() => f.graph.assertRootDocumentHint(successor, f.original), /UNSUPPORTED/);
});

test("missing root context or unbound cold snapshot has no hint ticket and cannot be repaired later", async () => {
  const f = await rootHintFixture(), next = f.commit({ create: false });
  const missing = f.graph.checkpointRootDocumentHint(next); assert.equal(missing, null);
  f.created(undefined, context("root", "https://root.test", { uniqueId: "first-B" }));
  assert.throws(() => f.graph.assertRootDocumentHint(missing, next), /UNSUPPORTED/);
  const fresh = f.graph.checkpointRootDocumentHint(next); f.graph.assertRootDocumentHint(fresh, next);
  const cold = fixture(); await cold.graph.start(); await cold.graph.snapshot();
  assert.equal(cold.graph.checkpointRootDocumentHint(f.original), null, "a snapshot without any browser identity binding grants no hint proof");
});

test("same original seed and isolated worlds preserve a root hint, but do not permit another browser binding", async () => {
  const f = await rootHintFixture(), next = f.commit(), ticket = f.graph.checkpointRootDocumentHint(next);
  f.created(undefined, context("root", "https://isolated.test", { id: 2, uniqueId: "isolated-hint", auxData: { frameId: "root", isDefault: false } }));
  await f.graph.snapshot(next); f.graph.assertRootDocumentHint(ticket, next);
  const other = await rootHintFixture(), original = other.commit(), pending = other.graph.checkpointRootDocumentHint(original);
  await other.graph.snapshot({ ...original, documentId: "other-browser-binding" });
  assert.throws(() => other.graph.assertRootDocumentHint(pending, original), /UNSUPPORTED/);
});

for (const change of ["native-start", "same-url-commit", "context-destroy", "context-clear", "context-replace", "local-child-start", "remote-child-start", "target-attach", "target-detach", "blocked-events", "revoke", "detach", "owner-withdrawal"]) {
  test(`root URL hint rejects ${change} before a late browser reply can clear the dirty gate`, async () => {
    const f = await rootHintFixture({ remote: true, local: true }), ticket = f.graph.checkpointRootDocumentHint(f.original);
    if (change === "native-start") f.graph.observe(undefined, "Page.frameStartedNavigating", { frameId: "root", loaderId: "pending-B" });
    if (change === "same-url-commit") f.commit();
    if (change === "context-destroy") f.graph.observe(undefined, "Runtime.executionContextDestroyed", { executionContextId: 1, executionContextUniqueId: "context-root" });
    if (change === "context-clear") f.graph.observe(undefined, "Runtime.executionContextsCleared");
    if (change === "context-replace") f.created(undefined, context("root", "https://root.test", { uniqueId: "replacement-root" }));
    if (change === "local-child-start") f.graph.observe(undefined, "Page.frameStartedNavigating", { frameId: "local-child", loaderId: "child-B" });
    if (change === "remote-child-start") f.graph.observe("child-session", "Page.frameStartedNavigating", { frameId: "child", loaderId: "child-B" });
    if (change === "target-attach") f.child("other-session", undefined, "other", "root", "https://other.test");
    if (change === "target-detach") f.graph.observe(undefined, "Target.detachedFromTarget", { sessionId: "child-session", targetId: "child" });
    if (change === "blocked-events") f.graph.observe(undefined, "Page.frameStartedNavigating", { frameId: "unknown" });
    if (change === "revoke") f.graph.revoke();
    if (change === "detach") f.graph.detached();
    if (change === "owner-withdrawal") f.expire();
    assert.throws(() => f.graph.assertRootDocumentHint(ticket, f.original), /UNSUPPORTED|revoked/);
    await f.graph.drain();
  });
}

test("root hint rejects foreign tickets and changed browser identity or URL without expanding original authority", async () => {
  const first = await rootHintFixture(), second = await rootHintFixture(), ticket = first.graph.checkpointRootDocumentHint(first.original);
  assert.throws(() => second.graph.assertRootDocumentHint(ticket, second.original), /UNSUPPORTED/);
  assert.throws(() => first.graph.assertRootDocumentHint({}, first.original), /UNSUPPORTED/);
  assert.throws(() => first.graph.assertRootDocumentHint(ticket, { ...first.original, url: first.original.url + "#later" }), /UNSUPPORTED/);
  for (const invalid of [null, {}, [], { ...first.original, documentId: "" }, { ...first.original, documentId: "bad\nID" }, { ...first.original, url: 5 }]) {
    assert.throws(() => first.graph.checkpointRootDocumentHint(invalid), /UNSUPPORTED/);
    assert.throws(() => first.graph.assertRootDocumentHint(ticket, invalid), /UNSUPPORTED/);
  }
  first.graph.assertRootDocumentHint(ticket, first.original);
});

test("an initial unbound browser reservation cannot authorize a successor root hint", async () => {
  const f = fixture(), original = { documentId: "reserved-A", url: frame("root").url };
  await f.graph.start(original);
  const next = { ...frame("root"), loaderId: "successor-B" };
  f.graph.observe(undefined, "Page.frameStartedNavigating", { frameId: "root", loaderId: next.loaderId });
  f.graph.observe(undefined, "Page.frameNavigated", { frame: next });
  f.created(undefined, context("root", "https://root.test", { uniqueId: "successor-default-B" }));
  assert.equal(f.graph.events.rootDocuments.get(original.documentId), null);
  assert.throws(() => f.graph.checkpointRootDocumentHint(original), /UNSUPPORTED/);
  const browser = { ...original, documentId: "proven-B" }, ticket = f.graph.checkpointRootDocumentHint(browser);
  f.graph.assertRootDocumentHint(ticket, browser);
  assert.equal(f.graph.events.rootDocuments.get(original.documentId), null);
  assert.equal(f.graph.events.rootDocuments.has(browser.documentId), false);
});

test("unavailable event evidence produces no new root hint without changing strict input identity", async () => {
  const f = await rootHintFixture();
  f.graph.observe(undefined, "Page.frameStartedNavigating", { frameId: "unknown" });
  assert.equal(f.graph.events.blocked, true);
  assert.equal(f.graph.checkpointRootDocumentHint(f.original), null);
  assert.throws(() => f.graph.checkpointRootDocumentHint(null), /UNSUPPORTED/);
  const strict = f.graph.captureIdentity(); f.graph.assertIdentity(strict);
});
