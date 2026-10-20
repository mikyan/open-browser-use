import test from "node:test";
import assert from "node:assert/strict";
import { installManagedFileChooserErrorDiagnostic } from "./managed-human-file-chooser-diagnostic.mjs";

const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("diagnostic returns each original Promise and preserves this, args and rejection", async () => {
  const native = defer(), close = defer(), target = {}, owner = {};
  const args = [{ targetId: "original" }, "Runtime.callFunctionOn", { functionDeclaration: "function(){return this.cleanup()}", secret: "never-record" }];
  const originalSend = function (...received) { assert.equal(this, owner); assert.deepEqual(received, args); return native.promise; };
  owner.sendCommand = originalSend;
  const record = { state: "releasing", leaseId: "lease", generation: 2, channelKey: "secret", attached: true };
  const proto = { close(original) { assert.equal(original, record); return close.promise; } }, receiver = Object.create(proto);
  const originalClose = proto.close;
  const installed = await installManagedFileChooserErrorDiagnostic({ debugger: owner }, target, proto);
  assert.equal(installed.controllerCloseObserved, true);
  assert.equal(owner.sendCommand(...args), native.promise);
  assert.equal(receiver.close(record), close.promise);
  const error = Object.assign(Error("OBU_DIRECTORY_UPLOAD_CLEANUP_FAILED: private path C:\\sensitive"), {
    stack: "Error: private bytes\n at cleanup (chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/browser-directory-upload.js:99:3)" });
  native.resolve({ exceptionDetails: { text: "Cannot find context with specified id" } });
  close.reject(error); await assert.rejects(close.promise, error); await tick();
  const result = target.__managedFileChooserErrorDiagnostic.snapshot();
  assert.equal(result.operations, 0);
  assert.equal(result.events.find(row => row.kind === "rejected").error.code, "OBU_DIRECTORY_UPLOAD_CLEANUP_FAILED");
  assert.equal(result.events.find(row => row.exception).exception.category, "context-missing");
  assert.equal(JSON.stringify(result).includes("sensitive"), false);
  assert.equal(JSON.stringify(result).includes("never-record"), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  target.__managedFileChooserErrorDiagnostic.stop();
  assert.equal(owner.sendCommand, originalSend); assert.equal(proto.close, originalClose);
});

test("stop restores only its own wrapper and keeps observing already pending originals", async () => {
  const pending = defer(), target = {}, owner = { sendCommand: () => pending.promise }, proto = { close: () => pending.promise };
  await installManagedFileChooserErrorDiagnostic({ debugger: owner }, target, proto);
  assert.equal(owner.sendCommand({ tabId: 7 }, "Page.stopScreencast"), pending.promise);
  const successor = () => "successor"; owner.sendCommand = successor;
  target.__managedFileChooserErrorDiagnostic.stop();
  pending.resolve({}); await tick();
  assert.equal(owner.sendCommand, successor);
  const result = target.__managedFileChooserErrorDiagnostic.snapshot();
  assert.equal(result.active, false); assert.equal(result.operations, 0);
  assert.equal(result.events.filter(row => row.kind === "resolved").length, 1);
});

test("synchronous throws retain the original object and diagnostic storage is bounded", async () => {
  const error = Error("Cannot find object with given id"), target = {};
  const owner = { sendCommand() { throw error; } }, proto = { close() { throw error; } };
  await installManagedFileChooserErrorDiagnostic({ debugger: owner }, target, proto);
  for (let i = 0; i < 300; i++) assert.throws(() => owner.sendCommand({ tabId: 7 }, "DOM.resolveNode", {}), e => e === error);
  assert.throws(() => proto.close({}), e => e === error);
  const result = target.__managedFileChooserErrorDiagnostic.stop();
  assert.equal(result.overflow, true); assert.equal(result.events.length, 512);
});

test("click diagnostic keeps original mouse and Runtime Promises with only safe call and ACK metadata", async () => {
  const native = defer(), target = {}, calls = [];
  const owner = { sendCommand(...args) { assert.equal(this, owner); calls.push(args); return native.promise; } };
  await installManagedFileChooserErrorDiagnostic({ debugger: owner }, target, {});
  const params = { type: "mousePressed", button: "left", x: 10, y: 20, buttons: 1, clickCount: 1, private: "never-record" };
  assert.equal(owner.sendCommand({ tabId: 7 }, "Input.dispatchMouseEvent", params), native.promise);
  assert.equal(owner.sendCommand({ tabId: 7 }, "Runtime.evaluate", { expression: "never-record" }), native.promise);
  assert.equal(calls[0][2], params);
  let snapshot = target.__managedFileChooserErrorDiagnostic.snapshot();
  assert.equal(snapshot.operations, 2); assert.equal(snapshot.actionEvents.length, 2);
  assert.deepEqual(snapshot.actionEvents[0].pointer, { type: "mousePressed", button: "left", x: 10, y: 20, buttons: 1, clickCount: 1 });
  native.resolve({ result: { type: "string", value: "never-record", description: "never-record" } }); await tick();
  snapshot = target.__managedFileChooserErrorDiagnostic.snapshot();
  assert.equal(snapshot.operations, 0); assert.equal(snapshot.actionEvents.filter(row => row.kind === "resolved").length, 2);
  assert.deepEqual(snapshot.actionEvents.at(-1).result, { type: "string", objectIdPresent: false });
  assert.equal(JSON.stringify(snapshot).includes("never-record"), false);
});

test("the bounded click ledger does not discard or share earlier screencast ACK capacity", async () => {
  const target = {}, owner = { sendCommand() { return Promise.resolve({}); } };
  await installManagedFileChooserErrorDiagnostic({ debugger: owner }, target, {});
  for (let i = 0; i < 256; i++) owner.sendCommand({ targetId: "human" }, "Page.screencastFrameAck", { sessionId: i });
  await tick();
  owner.sendCommand({ tabId: 7 }, "Page.enable", {}); await tick();
  let snapshot = target.__managedFileChooserErrorDiagnostic.snapshot();
  assert.equal(snapshot.events.length, 512); assert.equal(snapshot.overflow, false);
  assert.equal(snapshot.actionEvents.length, 2); assert.equal(snapshot.actionOverflow, false);
  for (let i = 0; i < 256; i++) owner.sendCommand({ tabId: 7 }, "Runtime.evaluate", { expression: "never-record" });
  await tick(); snapshot = target.__managedFileChooserErrorDiagnostic.snapshot();
  assert.equal(snapshot.events.length, 512); assert.equal(snapshot.overflow, false);
  assert.equal(snapshot.actionEvents.length, 512); assert.equal(snapshot.actionOverflow, true);
});
