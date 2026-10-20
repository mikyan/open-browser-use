import assert from "node:assert/strict";
import test from "node:test";
import { installManagedBeforeunloadObservation, managedBeforeunloadObservationComplete } from "./managed-beforeunload-observation.mjs";

function setup() {
  const signal = () => { const listeners = new Set(); return { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener),
    hasListener: listener => listeners.has(listener), emit: (...args) => { for (const listener of listeners) listener(...args); }, count: () => listeners.size }; };
  const api = { debugger: { onEvent: signal(), onDetach: signal() }, webNavigation: Object.fromEntries(["onBeforeNavigate", "onCommitted", "onErrorOccurred", "onHistoryStateUpdated"].map(name => [name, signal()])) };
  Object.defineProperty(api.debugger, "sendCommand", { get() { throw Error("Passive observation must not even read sendCommand"); }, set() { throw Error("No wrapper allowed"); } });
  const published = [], target = { __obuManagedDialogEvent: value => published.push(JSON.parse(value)) };
  return { api, target, published, install: () => installManagedBeforeunloadObservation(api, target, [{ tabId: 7, targetId: "original" }]) };
}

test("formal observer never accesses native send, preserves a single native/web order, and excludes secrets and unrelated targets", () => {
  const { api, target, published, install } = setup(); assert.equal(install().instrumented, false);
  api.debugger.onEvent.emit({ tabId: 8 }, "Page.javascriptDialogOpening", { type: "beforeunload" });
  api.debugger.onEvent.emit({ tabId: 7 }, "Page.frameStartedNavigating", { frameId: "original", loaderId: "loader", url: "secret", navigationType: "differentDocument" });
  api.webNavigation.onBeforeNavigate.emit({ tabId: 7, frameId: 0, documentId: "document", timeStamp: 123, url: "secret" });
  api.debugger.onEvent.emit({ targetId: "original" }, "Page.javascriptDialogOpening", { frameId: "original", type: "beforeunload", hasBrowserHandler: false, message: "secret" });
  api.debugger.onEvent.emit({ tabId: 7, sessionId: "child-session" }, "Runtime.executionContextCreated", { context: { id: 2, uniqueId: "context", name: "secret", auxData: { frameId: "child", isDefault: true } } });
  api.debugger.onEvent.emit({ tabId: 7 }, "Page.javascriptDialogClosed", { frameId: "original", result: false, userInput: "secret" });
  assert.deepEqual(published.map(row => row.sequence), [1, 2, 3, 4, 5]); assert.equal(published[2].params.type, "beforeunload");
  assert.equal(published[3].source.sessionId, "child-session"); assert.equal(published[3].params.context.uniqueId, "context");
  assert.doesNotMatch(JSON.stringify(published), /secret|userInput|"url"|"message"/);
  assert.equal(managedBeforeunloadObservationComplete(target.__managedBeforeunloadObservation.snapshot()), false);
  const ended = target.__managedBeforeunloadObservation.stop(); assert.equal(managedBeforeunloadObservationComplete(ended), true);
  assert.deepEqual(ended.records, published); assert.equal(api.debugger.onEvent.count(), 0);
  api.debugger.onEvent.emit({ tabId: 7 }, "Page.javascriptDialogClosed", { result: true }); assert.equal(published.length, 5);
  assert.deepEqual(target.__managedBeforeunloadObservation.stop(), ended);
});

test("bounded passive observation never reports overflow, projection failure or remaining listeners as complete", () => {
  const { api, target, install } = setup(); install();
  for (let index = 0; index < 2049; index++) api.debugger.onEvent.emit({ tabId: 7 }, "Runtime.executionContextsCleared", {});
  const stopped = target.__managedBeforeunloadObservation.stop(); assert.equal(stopped.records.length, 2048); assert.equal(stopped.dropped, 1);
  assert.equal(managedBeforeunloadObservationComplete(stopped), false);
  const healthy = { ...stopped, overflow: false, dropped: 0 };
  assert.equal(managedBeforeunloadObservationComplete(healthy), true);
  for (const patch of [{ projectionErrors: 1 }, { listenersPresent: 1 }, { instrumented: true }, { records: [] }, { records: [{ sequence: 2, kind: "event" }] }])
    assert.equal(managedBeforeunloadObservationComplete({ ...healthy, ...patch }), false);
});
