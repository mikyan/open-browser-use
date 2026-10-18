import assert from "node:assert/strict";
import test from "node:test";
import { ManagedHumanDocumentContexts } from "./managed-human-document-contexts.js";

const rows = () => [["root", null, "loader-root", "https://fixture.test/root", "", "https://fixture.test"],
  ["child", "root", "loader-child", "https://fixture.test/child", "", "https://fixture.test"],
  ["nested", "child", "loader-nested", "https://fixture.test/nested", "", "https://fixture.test"]];
const context = (frameId, extra = {}) => ({ id: { root: 1, child: 2, nested: 3 }[frameId] ?? 4,
  uniqueId: `original-${frameId}`, origin: "https://fixture.test", auxData: { isDefault: true, frameId }, ...extra });
function fixture(values = rows()) {
  const ledger = new ManagedHumanDocumentContexts();
  const created = value => ledger.observe("Runtime.executionContextCreated", { context: value });
  for (const row of values) created(context(row[0]));
  const snapshot = () => ledger.snapshot(JSON.stringify(values), ledger.checkpoint());
  return { ledger, created, values, snapshot };
}

test("child and nested proofs bind the entire original alive context path", () => {
  const f = fixture(), snapshot = f.snapshot(), proof = f.ledger.capture(snapshot, "nested");
  f.ledger.assert(proof); assert.ok(Object.isFrozen(proof));
  const other = fixture(); assert.throws(() => other.ledger.assert(proof), /UNSUPPORTED/);
  f.ledger.observe("Runtime.executionContextDestroyed", { executionContextId: 2, executionContextUniqueId: "original-child" });
  assert.throws(() => f.ledger.assert(proof), /UNSUPPORTED/);
  assert.throws(() => f.ledger.capture(snapshot, "nested"), /UNSUPPORTED/);
});

test("frame-only proofs expose actual origin without weakening the existing same-origin path", () => {
  const f = fixture(); f.created(context("child", { uniqueId: "cross-origin-child", origin: "https://child.test" }));
  const snapshot = f.snapshot(); assert.throws(() => f.ledger.capture(snapshot, "child"), /UNSUPPORTED/);
  const proof = f.ledger.captureFrame(snapshot, "child"); f.ledger.assert(proof);
  assert.equal(proof.actualOrigin, "https://child.test");
  f.ledger.observe("Runtime.executionContextsCleared"); assert.throws(() => f.ledger.assert(proof), /UNSUPPORTED/);
  assert.throws(() => f.ledger.captureFrame(snapshot, "child"), /UNSUPPORTED/);
});

for (const url of ["about:blank", "about:srcdoc"]) test(`inherited ${url} uses actual context origin instead of its loader URL field`, () => {
  const values = rows(); values[1][3] = url; values[1][5] = "://";
  const f = fixture(values); f.ledger.assert(f.ledger.capture(f.snapshot(), "child"));
});

for (const actual of ["", "://", "null", "https://foreign.test", "https://fixture.test/path", "file://"]) {
  test(`URL-derived same-origin fields cannot authorize child context origin ${JSON.stringify(actual)}`, () => {
    const f = fixture(); f.created(context("child", { id: 8, uniqueId: "replacement-child", origin: actual }));
    assert.throws(() => f.ledger.capture(f.snapshot(), "child"), /UNSUPPORTED/);
  });
}

test("missing root or intermediate default context cannot borrow a leaf's same origin", () => {
  for (const frameId of ["root", "child"]) {
    const f = fixture(); f.ledger.observe("Runtime.executionContextDestroyed", { executionContextId: context(frameId).id });
    assert.throws(() => f.ledger.capture(f.snapshot(), "nested"), /UNSUPPORTED/);
  }
});

test("non-default worlds neither replace nor provide the original default proof", () => {
  const f = fixture(), proof = f.ledger.capture(f.snapshot(), "child");
  f.created(context("child", { uniqueId: "isolated", origin: "https://foreign.test", auxData: { isDefault: false, frameId: "child" } }));
  f.ledger.assert(proof);
  f.ledger.observe("Runtime.executionContextsCleared");
  f.created(context("root", { uniqueId: "isolated-root", auxData: { isDefault: false, frameId: "root" } }));
  assert.throws(() => f.ledger.capture(f.snapshot(), "child"), /UNSUPPORTED/);
});

test("seeding requires an unchanged original event revision across both tree reads", () => {
  const f = fixture(), before = f.ledger.checkpoint();
  f.created(context("child", { uniqueId: "later-child" }));
  assert.equal(f.ledger.snapshot(JSON.stringify(f.values), before), null);
  assert.throws(() => f.ledger.capture(null, "child"), /UNSUPPORTED/);
});

for (const method of ["Page.frameNavigated", "Page.documentOpened"]) test(`${method} before initial binding retires all unbound contexts`, () => {
  const f = fixture(); f.ledger.observe(method, { frame: { id: "root", loaderId: "new-loader" } });
  assert.throws(() => f.ledger.capture(f.snapshot(), "child"), /UNSUPPORTED/);
  f.created(context("root")); f.created(context("child"));
  assert.throws(() => f.ledger.capture(f.snapshot(), "child"), /UNSUPPORTED/, "retired unique IDs cannot revive");
});

for (const method of ["Page.frameNavigated", "Page.documentOpened", "Page.frameAttached", "Page.frameDetached"]) {
  test(`${method} invalidates the bound subtree and every unbound context of unknown ancestry`, () => {
    const f = fixture(), proof = f.ledger.capture(f.snapshot(), "nested");
    f.created(context("unknown", { uniqueId: "unbound-child" }));
    f.ledger.observe(method, { frameId: "child", frame: { id: "child", parentId: "root" } });
    assert.throws(() => f.ledger.assert(proof), /UNSUPPORTED/);
    f.values.push(["unknown", "root", "new-loader", "about:blank", "", "://"]);
    assert.throws(() => f.ledger.capture(f.snapshot(), "unknown"), /UNSUPPORTED/);
  });
}

test("same-document URL changes preserve context identity but new loaders never rebind old contexts", () => {
  const f = fixture(), proof = f.ledger.capture(f.snapshot(), "nested");
  f.ledger.observe("Page.navigatedWithinDocument", { frameId: "child", url: "https://fixture.test/child#new" });
  f.values[1][4] = "#new"; f.ledger.assert(proof);
  f.ledger.assert(f.ledger.capture(f.snapshot(), "nested"));
  f.values[1][2] = "different-loader";
  assert.throws(() => f.ledger.capture(f.snapshot(), "nested"), /UNSUPPORTED/);
  assert.throws(() => f.ledger.assert(proof), /UNSUPPORTED/);
});

test("destroyed IDs cannot revive under a new loader; numeric ID reuse preserves unique identity", () => {
  const f = fixture(), original = f.ledger.capture(f.snapshot(), "child");
  f.ledger.observe("Runtime.executionContextDestroyed", { executionContextId: 2, executionContextUniqueId: "original-child" });
  f.values[1][2] = "new-loader"; f.created(context("child"));
  assert.throws(() => f.ledger.capture(f.snapshot(), "child"), /UNSUPPORTED/);
  f.created(context("child", { uniqueId: "new-child" }));
  const replacement = f.ledger.capture(f.snapshot(), "child");
  f.ledger.observe("Runtime.executionContextDestroyed", { executionContextId: 2, executionContextUniqueId: "original-child" });
  f.ledger.assert(replacement); assert.throws(() => f.ledger.assert(original), /UNSUPPORTED/);
});

test("context replacement invalidates prior snapshots without granting a late context to the old epoch", () => {
  const f = fixture(), snapshot = f.snapshot(), proof = f.ledger.capture(snapshot, "child");
  f.created(context("child", { uniqueId: "later-child" }));
  assert.throws(() => f.ledger.assert(proof), /UNSUPPORTED/);
  assert.throws(() => f.ledger.capture(snapshot, "child"), /UNSUPPORTED/);
  f.ledger.assert(f.ledger.capture(f.snapshot(), "child"));
});

test("capacity is closed without evicting tombstones or reviving original proof", () => {
  const f = fixture(), proof = f.ledger.capture(f.snapshot(), "child");
  for (let index = 0; index < 4094; index++) f.created(context("other", { uniqueId: `other-${index}` }));
  assert.equal(f.ledger.records.size, 4096); assert.equal(f.ledger.blocked, true);
  assert.throws(() => f.ledger.assert(proof), /UNSUPPORTED/);
  f.created(context("child")); assert.equal(f.ledger.snapshot(JSON.stringify(f.values), f.ledger.checkpoint()), null);
});
