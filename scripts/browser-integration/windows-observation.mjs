// Acceptance-only read-only desktop observer. No browser or profile is opened.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
function fields(value, names) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Invalid observation object");
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), "Unexpected observation fields");
}
function foreground(value) {
  fields(value, ["hwnd", "pid"]);
  assert.ok(typeof value.hwnd === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value.hwnd) && BigInt(value.hwnd) <= 0xffffffffffffffffn, "Invalid HWND");
  assert.ok(value.pid === null || integer(value.pid, 0, 0xffffffff), "Invalid foreground PID");
  assert.ok(value.hwnd !== "0" || value.pid === 0, "Zero HWND cannot identify a process");
  assert.ok(value.hwnd === "0" || value.pid !== 0, "Unresolved HWND must use null PID");
}
function sampled(value) {
  foreground(value.foreground);
  fields(value.cursor, ["x", "y"]);
  assert.ok(integer(value.cursor.x, -0x80000000, 0x7fffffff) && integer(value.cursor.y, -0x80000000, 0x7fffffff), "Invalid cursor sample");
}

export class WindowsObservationLedger {
  constructor({ runId, observerPID, sampleMs }) {
    assert.ok(uuid.test(runId) && integer(observerPID, 1, 0xffffffff) && integer(sampleMs, 25, 1000), "Invalid observer identity");
    Object.assign(this, { runId, observerPID, sampleMs, _records: [], samples: 0, foregroundEvents: 0, error: null, stopped: false, invalid: false });
  }
  get records() { return structuredClone(this._records); }
  accept(line) {
    try { return this.parse(line); }
    catch (error) { this.invalid = true; throw error; }
  }
  parse(line) {
    assert.equal(this.invalid, false, "Observation stream already failed validation");
    assert.ok(typeof line === "string" && Buffer.byteLength(line) <= 4096, "Invalid observation line");
    let value;
    try { value = JSON.parse(line); } catch { throw new Error("Invalid observation JSON"); }
    const common = ["version", "type", "runId", "observerPID", "sequence", "at", "elapsedUs"];
    const extra = {
      ready: ["sampleMs", "foregroundSource", "cursorSource", "preReadyEvents", "foreground", "cursor"],
      sample: ["foreground", "cursor"],
      foreground: ["foreground", "nativeEventTimeMs"],
      error: ["code"],
      stopped: ["reason", "hookRemoved", "timerKilled", "samples", "foregroundEvents", "complete"],
    }[value?.type];
    assert.ok(extra, "Unknown observation type"); fields(value, [...common, ...extra]);
    assert.equal(value.version, 1, "Unknown observer version");
    assert.equal(value.runId, this.runId, "Wrong observation run");
    assert.equal(value.observerPID, this.observerPID, "Wrong original observer process");
    assert.ok(!this.stopped && this._records.length < 1000000, "Observation after Stop or beyond record limit");
    assert.equal(value.sequence, this._records.length + 1, "Observation sequence gap or duplicate");
    assert.ok(integer(value.elapsedUs) && value.elapsedUs >= (this._records.at(-1)?.elapsedUs ?? 0), "Nonmonotonic observation receipt");
    assert.ok(typeof value.at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value.at) && Number.isFinite(Date.parse(value.at)), "Invalid observation UTC time");
    if (!this._records.length) assert.ok(["ready", "error"].includes(value.type), "Missing observer ready receipt");
    else assert.notEqual(value.type, "ready", "Duplicate observer ready receipt");
    if (value.type === "ready") {
      assert.equal(value.sampleMs, this.sampleMs); assert.equal(value.foregroundSource, "EVENT_SYSTEM_FOREGROUND");
      assert.equal(value.cursorSource, "GetCursorPos-samples"); assert.ok(integer(value.preReadyEvents)); sampled(value);
    } else if (value.type === "sample") {
      assert.equal(this._records[0]?.type, "ready"); assert.equal(this.error, null); sampled(value); this.samples++;
    } else if (value.type === "foreground") {
      assert.equal(this._records[0]?.type, "ready"); assert.equal(this.error, null); foreground(value.foreground);
      // This is the raw wrapping DWORD, not the monotonic receipt timestamp.
      assert.ok(integer(value.nativeEventTimeMs, 0, 0xffffffff)); this.foregroundEvents++;
    } else if (value.type === "error") {
      assert.ok(typeof value.code === "string" && /^[A-Z_]{1,64}$/.test(value.code), "Invalid observer failure code");
      this.error = value.code;
    } else {
      assert.equal(this._records[0]?.type, "ready");
      assert.ok(["stop", "eof", "failure", "invalid-command", "stdin-error"].includes(value.reason));
      assert.equal(typeof value.hookRemoved, "boolean"); assert.equal(typeof value.timerKilled, "boolean"); assert.equal(typeof value.complete, "boolean");
      assert.equal(value.samples, this.samples); assert.equal(value.foregroundEvents, this.foregroundEvents);
      assert.ok(!value.complete || !this.error && value.hookRemoved && value.timerKilled && ["stop", "eof"].includes(value.reason), "Unconfirmed observer cleanup");
      this.stopped = true;
    }
    const saved = structuredClone(value);
    this._records.push(saved);
    return structuredClone(saved);
  }
  finish({ code, signal }) {
    assert.equal(this.invalid, false, "Observation stream failed validation");
    assert.equal(code, 0, "Observer process did not exit successfully"); assert.equal(signal, null, "Observer process was terminated");
    assert.equal(this.error, null, "Observer recorded a failure");
    assert.ok(this.stopped && this._records.at(-1)?.complete === true, "Missing successful observer Stop receipt");
    return this.records;
  }
}

export async function startWindowsObservation({ executable, runId = randomUUID(), sampleMs = 50, onRecord = () => {}, timeoutMs = 30000 }, { spawnProcess = spawn, platform = process.platform } = {}) {
  assert.equal(platform, "win32", "Windows observation requires Windows");
  assert.ok(typeof executable === "string" && path.isAbsolute(executable), "Observer executable must be an absolute path");
  assert.ok(uuid.test(runId) && integer(sampleMs, 25, 1000) && integer(timeoutMs, 1, 60000), "Invalid observer options");
  assert.equal(typeof onRecord, "function", "Observer record sink must be a function");
  let child;
  const evidence = { runId, processId: null, failures: [], invalidOutput: [], stderrBytes: 0, stopRequestedAt: null, killRequestedAt: null, close: null };
  const exception = () => Object.assign(new Error(`Windows observation incomplete: ${evidence.failures.join(", ")}`), { observation: { ...structuredClone(evidence), records: ledger?.records ?? [] } });
  let ledger = null;
  try { child = spawnProcess(executable, ["--run-id", runId, "--sample-ms", String(sampleMs)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
  catch { evidence.failures.push("SPAWN_FAILED"); throw exception(); }
  evidence.processId = child.pid ?? null;
  let resolveReady, rejectReady, stopPromise, timer, exitSettled = false, pending = Buffer.alloc(0), outputFailed = false;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ledger = child.pid ? new WindowsObservationLedger({ runId, observerPID: child.pid, sampleMs }) : null;
  const fail = code => {
    if (!evidence.failures.includes(code)) evidence.failures.push(code);
    rejectReady(exception());
    // A post-ready protocol or sink failure must not leave a desktop listener
    // alive while the caller performs other work. Join errors remain in evidence.
    queueMicrotask(() => { void stop().catch(() => {}); });
  };
  child.on("error", () => fail("PROCESS_ERROR"));
  child.stdin.on("error", () => { if (!ledger?.stopped) fail("STDIN_ERROR"); });
  child.stdout.on("error", () => fail("STDOUT_ERROR"));
  child.stderr.on("error", () => fail("STDERR_ERROR"));
  child.stderr.on("data", bytes => { evidence.stderrBytes += bytes.length; fail("STDERR_OUTPUT"); });
  const invalid = bytes => {
    if (evidence.invalidOutput.length < 16) evidence.invalidOutput.push({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    outputFailed = true; pending = Buffer.alloc(0); fail("OUTPUT_PROTOCOL");
  };
  const line = bytes => {
    try {
      if (bytes.length > 4096) { invalid(bytes); return; }
      const record = ledger.accept(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      try { onRecord(structuredClone(record)); } catch { fail("RECORD_SINK_FAILED"); }
      if (record.type === "error") fail(`NATIVE_${record.code}`);
      if (record.type === "stopped" && !evidence.stopRequestedAt) fail("UNEXPECTED_STOP");
      if (record.type === "ready") resolveReady(record);
    } catch { invalid(bytes); }
  };
  child.stdout.on("data", chunk => {
    if (outputFailed) return;
    pending = Buffer.concat([pending, chunk]);
    let newline;
    while ((newline = pending.indexOf(10)) >= 0) {
      const bytes = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      line(bytes);
      if (outputFailed) return;
    }
    if (pending.length > 4096) invalid(pending);
  });
  const closed = new Promise(resolve => child.once("close", (code, signal) => {
    clearTimeout(timer); exitSettled = true;
    evidence.close = { code, signal, at: Date.now() };
    if (pending.length) invalid(pending); // Even a valid unterminated final JSON line is incomplete.
    if (!evidence.stopRequestedAt) fail("UNEXPECTED_EXIT");
    try { ledger?.finish({ code, signal }); if (!ledger) fail("SPAWN_FAILED"); }
    catch { fail("INCOMPLETE_NATIVE_CLEANUP"); }
    resolve(structuredClone(evidence.close));
  }));
  async function waitClosed(milliseconds) {
    if (exitSettled) return true;
    let deadline;
    try { return await Promise.race([closed.then(() => true), new Promise(resolve => { deadline = setTimeout(() => resolve(false), milliseconds); })]); }
    finally { clearTimeout(deadline); }
  }
  async function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      evidence.stopRequestedAt ??= Date.now();
      if (!exitSettled && !child.stdin.destroyed) {
        try { child.stdin.end('{"operation":"stop"}\n'); }
        catch { fail("STOP_WRITE_FAILED"); }
      }
      if (!await waitClosed(timeoutMs)) {
        fail("STOP_TIMEOUT"); evidence.killRequestedAt = Date.now();
        // This is the original ChildProcess handle, never a fresh PID lookup.
        try { if (!child.kill()) fail("TERMINATION_REJECTED"); }
        catch { fail("TERMINATION_FAILED"); }
        if (!await waitClosed(timeoutMs)) fail("EXIT_UNCONFIRMED");
      }
      if (evidence.failures.length) throw exception();
      return ledger.records;
    })();
    return stopPromise;
  }
  timer = setTimeout(() => fail("READY_TIMEOUT"), timeoutMs);
  try {
    const initial = await ready; clearTimeout(timer);
    if (evidence.failures.length) throw exception();
    return { ready: initial, get records() { return ledger.records; }, get evidence() { return structuredClone(evidence); }, stop, closed, processId: child.pid, runId };
  } catch {
    try { await stop(); } catch { /* Include the joined cleanup outcome below. */ }
    throw exception();
  }
}

// A PID match is a candidate attribution only: callers retain their original
// browser process creation/exit proof. PID reuse and external input causation
// cannot be determined by this deliberately narrow observer.
export function foregroundPIDMatches(records, processIds) {
  assert.ok(Array.isArray(processIds) && processIds.every(pid => integer(pid, 1, 0xffffffff)), "Invalid candidate process IDs");
  const wanted = new Set(processIds);
  return records.filter(value => ["foreground", "sample", "ready"].includes(value.type) && wanted.has(value.foreground?.pid));
}
