// Acceptance-only Browser CDP observer. This is not a CRX transport or a
// production GUID/path service. The caller owns and verifies the isolated
// profile and joins these events to the extension's original Page GUID.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import WebSocket from "ws";

const error = (code, message) => new Error(`OBU_DOWNLOAD_OBSERVER_${code}: ${message}`);
const readableMethods = new Set(["Target.getTargets", "Browser.getVersion"]);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const absolute = value => typeof value === "string" && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
async function settledWithin(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

export async function connectOriginalDownloadObserver({ webSocketURL, ownedIsolatedProfile, timeoutMs = 5000, maxRecords = 512 } = {}) {
  const url = new URL(webSocketURL);
  assert.ok(["ws:", "wss:"].includes(url.protocol) && /^\/devtools\/browser\/[^/]+$/.test(url.pathname) && !url.username && !url.password && !url.search && !url.hash,
    "A real Browser root WebSocket URL is required; page/CRX endpoints are unsupported");
  assert.ok(absolute(ownedIsolatedProfile), "Explicit caller-owned isolated profile absolute path is required");
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 120000, "Invalid observer timeoutMs");
  assert.ok(Number.isInteger(maxRecords) && maxRecords >= 4 && maxRecords <= 10000, "Invalid observer maxRecords");
  const ledger = { webSocketURL: url.href, ownedIsolatedProfile, scope: "Default BrowserContext of caller-owned isolated profile only", timeoutMs, maxRecords,
    connectingAt: Date.now(), records: [], errors: [], overflow: false, closeObserved: false };
  const socket = new WebSocket(url.href, { handshakeTimeout: timeoutMs, maxPayload: 4 * 1024 * 1024 });
  const pending = new Map(), commands = new Map();
  let id = 0, fatal, started = false, startAttempted = false, closing = false, closePromise;
  let openResolve, openReject, closedResolve;
  const opened = new Promise((resolve, reject) => { openResolve = resolve; openReject = reject; });
  const closed = new Promise(resolve => { closedResolve = resolve; });
  const disconnected = () => error("DISCONNECTED", "The original Browser connection is closed; no reconnection is attempted");
  const rejectPending = failure => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure); } pending.clear(); };
  const fail = failure => {
    ledger.errors.push({ at: Date.now(), error: String(failure) });
    fatal ??= failure; openReject(failure); rejectPending(failure); socket.terminate();
  };
  function record(direction, raw, message) {
    if (ledger.records.length >= maxRecords) { ledger.overflow = true; throw error("OVERFLOW", "Raw CDP record capacity exceeded; evidence is incomplete"); }
    const bytes = Buffer.from(raw);
    const row = { sequence: ledger.records.length, at: Date.now(), monotonicMs: performance.now(), direction,
      bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), bodyBase64: bytes.toString("base64"), ...(message === undefined ? {} : { message }) };
    ledger.records.push(row); return row;
  }
  socket.once("open", () => { ledger.openedAt = Date.now(); openResolve(); });
  socket.on("error", failure => fail(failure));
  socket.once("close", (code, reason) => {
    Object.assign(ledger, { closeObserved: true, closedAt: Date.now(), closeCode: code, closeReason: reason.toString() });
    if (!closing && !fatal) { fatal = disconnected(); ledger.errors.push({ at: Date.now(), error: String(fatal) }); }
    openReject(fatal ?? disconnected()); rejectPending(fatal ?? disconnected()); closedResolve();
  });
  socket.on("message", (raw, binary) => {
    try {
      const row = record("receive", raw);
      if (binary) throw error("PROTOCOL", "Unexpected binary Browser CDP message");
      const message = row.message = JSON.parse(Buffer.from(raw).toString("utf8"));
      if (!object(message)) throw error("PROTOCOL", "Browser CDP message must be an object");
      if (typeof message.method === "string" && message.id === undefined) return;
      const command = commands.get(message.id);
      if (!command || command.ackSequence !== undefined || (!object(message.result) && !object(message.error)))
        throw error("PROTOCOL", "Unknown, duplicate or malformed Browser CDP acknowledgement");
      command.ackSequence = row.sequence; command.acknowledgedAt = row.at;
      const item = pending.get(message.id);
      if (!item) { row.late = true; return; }
      clearTimeout(item.timer); pending.delete(message.id);
      message.error ? item.reject(error("CDP", JSON.stringify(message.error))) : item.resolve(structuredClone(message.result));
    } catch (failure) { fail(failure); }
  });
  function snapshot() {
    return structuredClone({ ...ledger, commands: ledger.records.filter(row => row.direction === "send"),
      acks: ledger.records.filter(row => row.direction === "receive" && row.message?.id !== undefined),
      events: ledger.records.filter(row => row.direction === "receive" && typeof row.message?.method === "string") });
  }
  async function closeSocket() {
    if (socket.readyState !== WebSocket.CLOSED) { ledger.closeRequestedAt ??= Date.now(); socket.close(1000, "observer complete"); }
    if (!await settledWithin(closed, timeoutMs)) {
      ledger.terminatedAt = Date.now(); socket.terminate();
      if (!await settledWithin(closed, timeoutMs)) throw error("CLOSE_TIMEOUT", "Actual socket close was not observed");
    }
  }
  async function command(method, params, cleanup = false) {
    if (fatal) throw fatal;
    if ((closing && !cleanup) || socket.readyState !== WebSocket.OPEN) throw disconnected();
    const message = { id: ++id, method, params };
    let row;
    try { row = record("send", Buffer.from(JSON.stringify(message)), message); }
    catch (failure) { fail(failure); throw failure; }
    commands.set(message.id, row);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(message.id); row.timedOutAt = Date.now(); reject(error("TIMEOUT", `${method} response deadline expired; no retry`)); }, timeoutMs);
      pending.set(message.id, { resolve, reject, timer });
      socket.send(Buffer.from(row.bodyBase64, "base64"), { binary: false }, failure => {
        if (failure) { row.sendError = String(failure); fail(failure); } else row.sentAt = Date.now();
      });
    });
  }
  try { await opened; }
  catch (failure) {
    closing = true;
    try { await closeSocket(); } catch (cleanupError) { ledger.errors.push({ at: Date.now(), error: String(cleanupError) }); }
    failure.observerSnapshot = snapshot(); throw failure;
  }
  return {
    snapshot,
    async call(method, params = {}) {
      assert.ok(readableMethods.has(method) && object(params) && Object.keys(params).length === 0, "Only unfiltered Target.getTargets and Browser.getVersion reads are allowed");
      return command(method, {});
    },
    async start({ behavior, downloadPath } = {}) {
      assert.ok(["default", "allowAndName"].includes(behavior), "Explicit default or allowAndName behavior is required");
      assert.ok(behavior === "allowAndName" ? absolute(downloadPath) : downloadPath === undefined, "Only allowAndName takes an absolute isolated downloadPath");
      if (startAttempted) throw error("ALREADY_STARTED", "An observer can configure its original context only once");
      if (closing) throw disconnected();
      startAttempted = true;
      const params = { behavior, eventsEnabled: true, ...(downloadPath === undefined ? {} : { downloadPath }) };
      ledger.start = { attemptedAt: Date.now(), params };
      await command("Browser.setDownloadBehavior", params);
      if (closing || socket.readyState !== WebSocket.OPEN) throw disconnected();
      ledger.start.acknowledgedAt = Date.now(); started = true;
    },
    download(guid) {
      if (fatal) throw fatal;
      if (!started) throw error("NOT_STARTED", "Download configuration must have its actual ACK first");
      assert.ok(typeof guid === "string" && guid.length > 0 && Buffer.byteLength(guid) <= 256, "Exact native download GUID is required");
      const events = ledger.records.filter(row => row.direction === "receive" && row.message?.params?.guid === guid);
      const begins = events.filter(row => row.message.method === "Browser.downloadWillBegin");
      const progress = events.filter(row => row.message.method === "Browser.downloadProgress");
      if (begins.length > 1) throw error("IDENTITY", "Duplicate Browser begin for the exact GUID");
      const terminal = progress.filter(row => ["completed", "canceled"].includes(row.message.params.state));
      if (terminal.length > 1) throw error("IDENTITY", "Duplicate terminal Browser progress for the exact GUID");
      if (!terminal.length) return null;
      if (begins.length !== 1 || begins[0].sequence >= terminal[0].sequence) throw error("IDENTITY", "Terminal progress has no preceding unique Browser begin");
      const begin = begins[0].message.params, end = terminal[0].message.params;
      if (end.state === "canceled") throw error("CANCELED", `Original download ${guid} was canceled`);
      if (!absolute(end.filePath)) throw error("PATH_UNAVAILABLE", "Completed native Browser event has no absolute filePath; no path is inferred");
      return structuredClone({ guid, begin, progress: end, filePath: end.filePath });
    },
    close() {
      if (closePromise) return closePromise;
      closing = true; ledger.closingAt = Date.now();
      closePromise = (async () => {
        ledger.cleanup = { required: startAttempted, startedAt: Date.now(), restored: false };
        let failure;
        try {
          if (startAttempted) {
            await command("Browser.setDownloadBehavior", { behavior: "default", eventsEnabled: false }, true);
            ledger.cleanup.restored = true; ledger.cleanup.acknowledgedAt = Date.now();
          }
        } catch (cause) { failure = cause; ledger.cleanup.error = String(cause); }
        finally {
          try { await closeSocket(); }
          catch (cause) { ledger.cleanup.closeError = String(cause); failure ??= cause; }
          ledger.cleanup.finishedAt = Date.now();
        }
        if (failure) throw failure;
        return snapshot();
      })();
      return closePromise;
    }
  };
}
