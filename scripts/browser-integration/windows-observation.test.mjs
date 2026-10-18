import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import path from "node:path";
import { WindowsObservationLedger, startWindowsObservation, foregroundPIDMatches } from "./windows-observation.mjs";

const runId = "aabbccdd-1234-5678-9012-112233445566", pid = 4321;
const base = (type, sequence) => ({ version: 1, type, sequence, runId, observerPID: pid, at: "2026-10-18T05:00:00.000000001Z", elapsedUs: sequence * 1000 });
const position = () => ({ foreground: { hwnd: "18446744073709551615", pid: 99 }, cursor: { x: -1300, y: 20 } });
const ready = () => ({ ...base("ready", 1), sampleMs: 50, foregroundSource: "EVENT_SYSTEM_FOREGROUND", cursorSource: "GetCursorPos-samples", preReadyEvents: 1, ...position() });
const sample = sequence => ({ ...base("sample", sequence), ...position() });
const event = sequence => ({ ...base("foreground", sequence), foreground: { hwnd: "123456", pid: 55 }, nativeEventTimeMs: 0xffffffff });
const stopped = (sequence, samples = 0, events = 0) => ({ ...base("stopped", sequence), reason: "stop", hookRemoved: true, timerKilled: true, complete: true, samples, foregroundEvents: events });
const ledger = () => new WindowsObservationLedger({ runId, observerPID: pid, sampleMs: 50 });
const push = (value, record) => value.accept(JSON.stringify(record));

test("ready, continuous-event receipts, cursor samples and native cleanup retain distinct bounded records", () => {
  const l = ledger();
  for (const row of [ready(), event(2), sample(3), { ...event(4), nativeEventTimeMs: 2 }, stopped(5, 1, 2)]) push(l, row);
  const rows = l.finish({ code: 0, signal: null });
  assert.equal(rows[0].foreground.hwnd, "18446744073709551615");
  assert.equal(rows[2].cursor.x, -1300);
  assert.equal(foregroundPIDMatches(rows, [55]).length, 2);
  assert.equal(foregroundPIDMatches(rows, [99]).length, 2);
  assert.equal(foregroundPIDMatches(rows, [123]).length, 0);
  rows[0].foreground.pid = 123;
  assert.equal(l.records[0].foreground.pid, 99, "caller mutated the original evidence");
});

for (const [name, mutate] of [
  ["wrong observer PID", r => { r.observerPID++; }],
  ["wrong run", r => { r.runId = "00112233-1234-5678-9012-112233445566"; }],
  ["sequence gap", r => { r.sequence++; }],
  ["monotonic receipt reversed", r => { r.elapsedUs = 0; }],
  ["extra title", r => { r.title = "uncollected text"; }],
  ["numeric HWND", r => { r.foreground.hwnd = 123; }],
  ["oversized HWND", r => { r.foreground.hwnd = "18446744073709551616"; }],
  ["fractional cursor", r => { r.cursor.x = 1.5; }],
  ["zero HWND owns process", r => { r.foreground.hwnd = "0"; }],
  ["unresolved HWND uses zero PID", r => { r.foreground.pid = 0; }],
  ["extra coordinate", r => { r.cursor.button = "left"; }],
]) test(`ledger rejects ${name} and cannot be repaired into success`, () => {
  const l = ledger(); push(l, ready()); const row = sample(2); mutate(row);
  assert.throws(() => push(l, row));
  assert.throws(() => push(l, stopped(2)));
  assert.throws(() => l.finish({ code: 0, signal: null }));
});

test("unresolved event owner is retained without guessing a PID", () => {
  const l = ledger(); push(l, ready()); push(l, { ...event(2), foreground: { hwnd: "123456", pid: null } }); push(l, stopped(3, 0, 1));
  assert.equal(foregroundPIDMatches(l.finish({ code: 0, signal: null }), [55]).length, 0);
});

test("missing/duplicate readiness, truncated JSON and post-Stop records fail", () => {
  assert.throws(() => push(ledger(), sample(1)));
  const duplicate = ledger(); push(duplicate, ready()); assert.throws(() => push(duplicate, { ...ready(), sequence: 2 }));
  assert.throws(() => ledger().accept('{"type":'));
  const ended = ledger(); push(ended, ready()); push(ended, stopped(2)); assert.throws(() => push(ended, sample(3)));
});

for (const [name, rows, exit] of [
  ["native error", [ready(), { ...base("error", 2), code: "HOOK_CLEANUP_FAILED" }, { ...stopped(3), complete: false, hookRemoved: false }], { code: 1, signal: null }],
  ["false unhook", [ready(), { ...stopped(2), complete: false, hookRemoved: false }], { code: 0, signal: null }],
  ["missing stopped", [ready()], { code: 0, signal: null }],
  ["killed helper", [ready(), stopped(2)], { code: null, signal: "SIGTERM" }],
  ["nonzero exit", [ready(), stopped(2)], { code: 1, signal: null }],
]) test(`${name} is never complete observation coverage`, () => {
  const l = ledger(); for (const row of rows) push(l, row);
  assert.throws(() => l.finish(exit));
});

test("Stop counters and claimed cleanup cannot contradict the event ledger", () => {
  const l = ledger(); push(l, ready()); push(l, sample(2)); assert.throws(() => push(l, stopped(3, 0)));
  const bad = ledger(); push(bad, ready()); assert.throws(() => push(bad, { ...stopped(2), hookRemoved: false }));
});

function fakeChild({ onStop, onKill, initial = true } = {}) {
  const child = new EventEmitter(), writes = [];
  Object.assign(child, { pid, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kills: 0, writes });
  child.record = record => child.stdout.write(JSON.stringify(record) + "\n");
  child.close = (code = 0, signal = null) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code; child.signalCode = signal;
    child.stdout.end(); child.stderr.end(); child.emit("close", code, signal);
  };
  child.stdin = new Writable({ write(chunk, _encoding, done) { writes.push(chunk.toString()); done(); }, final(done) {
    done(); if (onStop) onStop(child); else { child.record(stopped(2)); setImmediate(() => child.close()); }
  } });
  child.kill = () => { child.kills++; if (onKill) return onKill(child); setImmediate(() => child.close(null, "SIGTERM")); return true; };
  const spawnProcess = (executable, args, options) => {
    assert.equal(executable, path.resolve("observer.exe")); assert.deepEqual(args, ["--run-id", runId, "--sample-ms", "50"]);
    assert.deepEqual(options, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    if (initial) setImmediate(() => child.record(ready()));
    return child;
  };
  return { child, start: options => startWindowsObservation({ executable: path.resolve("observer.exe"), runId, sampleMs: 50, timeoutMs: 100, ...options }, { spawnProcess, platform: "win32" }) };
}

test("wrapper resolves Stop only after exact original child close, and duplicate Stop does not replay", async () => {
  let close;
  const { child, start } = fakeChild({ onStop(c) { c.record(stopped(2)); close = () => c.close(); } });
  const observer = await start(); let settled = false;
  const first = observer.stop().then(rows => { settled = true; return rows; }); const second = observer.stop();
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(settled, false);
  close(); assert.equal((await first).at(-1).complete, true); await second;
  assert.equal(child.writes.length, 1); assert.equal(child.kills, 0); assert.equal((await observer.closed).code, 0);
});

test("ready failure joins graceful original child cleanup and retains both failure and native records", async () => {
  const { child, start } = fakeChild({ initial: false, onStop(c) { setTimeout(() => c.close(1), 15); } });
  await assert.rejects(start({ timeoutMs: 30 }), error => {
    assert.ok(error.observation.failures.includes("READY_TIMEOUT")); assert.equal(error.observation.close.code, 1); return true;
  });
  assert.equal(child.writes.length, 1); assert.equal(child.kills, 0);
});

test("post-ready native failure automatically stops and preserves original plus cleanup failure", async () => {
  const { child, start } = fakeChild({ onStop(c) { c.record({ ...stopped(3), complete: false, hookRemoved: false }); c.close(1); } });
  const observer = await start(); child.record({ ...base("error", 2), code: "HOOK_CLEANUP_FAILED" });
  await observer.closed;
  await assert.rejects(observer.stop(), error => {
    assert.ok(error.observation.failures.includes("NATIVE_HOOK_CLEANUP_FAILED"));
    assert.equal(error.observation.records[1].code, "HOOK_CLEANUP_FAILED"); assert.equal(error.observation.close.code, 1); return true;
  });
  assert.equal(child.writes.length, 1);
});

test("Stop timeout terminates only its original child and waits for its actual close", async () => {
  let killedAt;
  const { child, start } = fakeChild({ onStop() {}, onKill(c) { killedAt = Date.now(); setTimeout(() => c.close(null, "SIGTERM"), 20); return true; } });
  const observer = await start({ timeoutMs: 40 });
  await assert.rejects(observer.stop(), error => {
    assert.ok(Date.now() - killedAt >= 15); assert.ok(error.observation.failures.includes("STOP_TIMEOUT"));
    assert.equal(error.observation.close.signal, "SIGTERM"); return true;
  });
  assert.equal(child.kills, 1);
});

test("rejected termination leaves explicit unconfirmed-exit evidence, never a success", async () => {
  const { child, start } = fakeChild({ onStop() {}, onKill() { return false; } });
  const observer = await start({ timeoutMs: 20 });
  await assert.rejects(observer.stop(), error => {
    assert.ok(error.observation.failures.includes("TERMINATION_REJECTED")); assert.ok(error.observation.failures.includes("EXIT_UNCONFIRMED"));
    assert.equal(error.observation.close, null); assert.equal(error.observation.processId, pid); return true;
  });
  child.close(1); await observer.closed;
});

for (const [name, bytes] of [
  ["overlong unterminated line", Buffer.alloc(5000, 120)],
  ["invalid UTF-8", Buffer.from([0xff, 10])],
  ["foreign process", Buffer.from(JSON.stringify({ ...sample(2), observerPID: pid + 1 }) + "\n")],
]) test(`${name} automatically retires helper and retains bounded hashes instead of unvalidated text`, async () => {
  const { child, start } = fakeChild({ onStop(c) { c.close(1); } });
  const observer = await start(); child.stdout.write(bytes); await observer.closed;
  await assert.rejects(observer.stop(), error => {
    assert.ok(error.observation.failures.includes("OUTPUT_PROTOCOL")); assert.equal(error.observation.invalidOutput[0].bytes, bytes.length - (bytes.at(-1) === 10 ? 1 : 0));
    assert.ok(/^[a-f0-9]{64}$/.test(error.observation.invalidOutput[0].sha256)); return true;
  });
  assert.equal(child.writes.length, 1);
});

test("stopped without a newline is retained as incomplete, even on exit zero", async () => {
  const { start } = fakeChild({ onStop(c) { c.stdout.write(JSON.stringify(stopped(2))); c.close(); } });
  const observer = await start();
  await assert.rejects(observer.stop(), error => error.observation.failures.includes("OUTPUT_PROTOCOL") && error.observation.close.code === 0);
});

test("a failing evidence sink prevents admission and still joins original helper cleanup", async () => {
  const { child, start } = fakeChild();
  await assert.rejects(start({ onRecord() { throw new Error("sink unavailable"); } }), error => {
    assert.ok(error.observation.failures.includes("RECORD_SINK_FAILED")); assert.equal(error.observation.close.code, 0); return true;
  });
  assert.equal(child.writes.length, 1);
});

test("synchronous spawn failure retains an explicit empty process receipt", async () => {
  await assert.rejects(startWindowsObservation({ executable: path.resolve("observer.exe"), runId }, { platform: "win32", spawnProcess() { throw new Error("unavailable"); } }), error => {
    assert.deepEqual(error.observation.failures, ["SPAWN_FAILED"]); assert.equal(error.observation.processId, null); assert.equal(error.observation.close, null); return true;
  });
});
