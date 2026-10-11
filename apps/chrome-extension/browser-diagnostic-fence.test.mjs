import assert from "node:assert/strict";
import { test } from "node:test";
import { beginDiagnosticFence, bindDiagnosticSession, acceptDiagnosticEvent, diagnosticReleaseGuard } from "./browser-diagnostic-fence.js";

function fixture(sessionId = "crx-tab-17", page = {}) {
  const sent = [], targetInfo = { targetId: "native-target" };
  const transport = { _tabToTarget: new Map([[17, targetInfo]]), _sessions: new Map([[sessionId, 17]]) };
  const connection = { _transport: transport, _sessions: new Map() };
  const client = { _sessionId: sessionId, _connection: connection,
    _sendMayFail: (method, params) => { sent.push({ method, params }); return Promise.resolve(); }
  };
  connection._sessions.set(sessionId, client);
  return { page, client, connection, transport, targetInfo, sent };
}

test("timestamp boundary admits equality and newer events, rejects stale and unavailable timestamps", () => {
  const f = fixture();
  assert.equal(beginDiagnosticFence(f.page, () => 1234.5), 1234.5);
  bindDiagnosticSession(f.page, f.client);
  for (const timestamp of [1234.5, 1234.501, 1235]) assert.equal(acceptDiagnosticEvent(f.page, f.client, "console", { timestamp }), true);
  for (const timestamp of [1234.499, 0, undefined, null, NaN, Infinity, "1235"]) assert.equal(acceptDiagnosticEvent(f.page, f.client, "console", { timestamp }), false);
  assert.throws(() => beginDiagnosticFence(f.page, () => 2222), /already initialized/);
  for (const value of [NaN, Infinity, -1]) assert.throws(() => beginDiagnosticFence({}, () => value), /boundary/);
});

test("a new Page never adopts the prior scope's cutoff; standalone CRX is untouched", () => {
  const f = fixture();
  beginDiagnosticFence(f.page, () => 100); bindDiagnosticSession(f.page, f.client);
  assert.equal(acceptDiagnosticEvent(f.page, f.client, "console", { timestamp: 150 }), true);
  const successor = {};
  beginDiagnosticFence(successor, () => 200); bindDiagnosticSession(successor, f.client);
  assert.equal(acceptDiagnosticEvent(successor, f.client, "console", { timestamp: 150 }), false);
  assert.equal(acceptDiagnosticEvent({}, {}, "console", { timestamp: 0 }), true);
});

test("root, OOPIF and worker sessions inherit one Page cutoff rather than their later attach time", () => {
  const page = {}; beginDiagnosticFence(page, () => 100);
  for (const id of ["crx-tab-17", "oopif-session", "worker-session"]) {
    const f = fixture(id, page); bindDiagnosticSession(page, f.client);
    for (const kind of ["console", "exception", "log"]) {
      const event = kind === "log" ? { entry: { timestamp: 101 } } : { timestamp: 101 };
      assert.equal(acceptDiagnosticEvent(page, f.client, kind, event), true, `${id}/${kind}`);
      if (kind === "log") event.entry.timestamp = 99; else event.timestamp = 99;
      assert.equal(acceptDiagnosticEvent(page, f.client, kind, event), false, `${id}/${kind}`);
    }
  }
});

test("filtered console, exception and Log objects are released once each through their exact session", () => {
  const f = fixture("oopif-session"); beginDiagnosticFence(f.page, () => 100); bindDiagnosticSession(f.page, f.client);
  for (const [kind, event, expected] of [
    ["console", { timestamp: 1, args: [{ objectId: "a" }, { objectId: "a" }, { value: "text" }, { objectId: "b" }] }, ["a", "b"]],
    ["exception", { timestamp: 1, exceptionDetails: { exception: { objectId: "error" } } }, ["error"]],
    ["log", { entry: { timestamp: 1, args: [{ objectId: "log" }] } }, ["log"]]
  ]) {
    f.sent.length = 0;
    assert.equal(acceptDiagnosticEvent(f.page, f.client, kind, event), false);
    assert.deepEqual(f.sent.map(item => item.params.objectId), expected);
    for (const item of f.sent) {
      assert.equal(item.method, "Runtime.releaseObject");
      assert.deepEqual(Object.keys(item.params), ["objectId"]);
      assert.doesNotThrow(diagnosticReleaseGuard(item.params));
      assert.equal(diagnosticReleaseGuard({ ...item.params }), undefined);
    }
  }
});

test("cleanup never borrows a successor target or session, including after asynchronous admission", () => {
  for (const mutate of [
    f => { f.client._closed = true; },
    f => { f.connection._closed = true; },
    f => { f.client._crashed = true; },
    f => { f.connection._sessions.set(f.client._sessionId, {}); },
    f => { f.transport._tabToTarget.set(17, { targetId: "same-numeric-tab" }); },
    f => { f.transport._sessions.delete("child-session"); }
  ]) {
    const f = fixture("child-session"); beginDiagnosticFence(f.page, () => 100); bindDiagnosticSession(f.page, f.client);
    acceptDiagnosticEvent(f.page, f.client, "console", { timestamp: 1, args: [{ objectId: "old" }] });
    const guard = diagnosticReleaseGuard(f.sent[0].params);
    mutate(f);
    assert.throws(guard, /retired native session/);
    f.sent.length = 0;
    assert.equal(acceptDiagnosticEvent(f.page, f.client, "console", { timestamp: 200, args: [{ objectId: "old" }] }), false);
    assert.equal(f.sent.length, 0);
  }
});

test("missing initial native routing cannot be repaired by borrowing a later session", () => {
  const f = fixture(); beginDiagnosticFence(f.page, () => 100);
  f.transport._tabToTarget.clear(); bindDiagnosticSession(f.page, f.client);
  f.transport._tabToTarget.set(17, f.targetInfo); bindDiagnosticSession(f.page, f.client);
  assert.equal(acceptDiagnosticEvent(f.page, f.client, "console", { timestamp: 200, args: [{ objectId: "x" }] }), false);
  assert.equal(f.sent.length, 0);
});
