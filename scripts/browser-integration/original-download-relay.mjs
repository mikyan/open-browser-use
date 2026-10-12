// Acceptance-only, single-connection Browser WS relay. Records complete data
// messages (including their original bytes), not TCP or fragmented wire frames.
import { createHash } from "node:crypto";
import http from "node:http";
import { isIP } from "node:net";
import WebSocket, { WebSocketServer } from "ws";

const failure = (code, message) => new Error(`OBU_DOWNLOAD_RELAY_${code}: ${message}`);
const stamp = () => ({ at: Date.now(), monotonicMs: performance.now() });
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function browserURL(raw) {
  // Parse the authority before WHATWG URL normalization: 127.1, numeric/hex
  // addresses, dot segments and percent escapes must not become valid inputs.
  const parts = typeof raw === "string" && /^(wss?):\/\/(\[[0-9a-fA-F:]+\]|[0-9.]+):([0-9]+)(\/devtools\/browser\/[A-Za-z0-9._~-]{1,256})$/.exec(raw);
  if (!parts) throw failure("URL", "An explicit literal-loopback Browser WebSocket URL without credentials, query or fragment is required");
  const host = parts[2].startsWith("[") ? parts[2].slice(1, -1) : parts[2];
  const family = isIP(host), port = Number(parts[3]);
  if (!(family === 4 && host.startsWith("127.") || family === 6 && new URL(`http://[${host}]`).hostname === "[::1]") ||
      !integer(port, 1, 65535) || String(port) !== parts[3] || /\/(?:\.|\.\.)$/.test(parts[4]))
    throw failure("URL", "A literal loopback IP, explicit port 1–65535 and exact Browser root path are required");
  return { targetURL: raw, pathname: parts[4] };
}

async function within(promise, milliseconds, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(failure("CLOSE_TIMEOUT", description)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export async function createOriginalDownloadRelay({ targetURL, maxRecords = 4096, maxBytes = 32 * 1024 * 1024, maxAttempts = 16, timeoutMs = 5000 } = {}) {
  const endpoint = browserURL(targetURL);
  if (!integer(maxRecords, 1, 10000) || !integer(maxBytes, 1, 64 * 1024 * 1024) ||
      !integer(maxAttempts, 1, 128) || !integer(timeoutMs, 1, 120000)) throw failure("LIMIT", "Invalid relay evidence or timeout limit");
  const ledger = {
    targetURL: endpoint.targetURL, granularity: "complete WebSocket data messages; not TCP or fragmented wire frames",
    created: stamp(), maxRecords, maxBytes, maxAttempts, timeoutMs,
    records: [], recordedBytes: 0, attempts: [], attemptCount: 0, upstreamAttempts: 0,
    acceptedConnections: 0, reconnects: 0, errors: [], suppressedErrors: 0, overflow: false,
    captureComplete: true, downstream: { closeObserved: false }, upstream: { closeObserved: false },
    server: { closeObserved: false }
  };
  const server = http.createServer((request, response) => { response.writeHead(404, { Connection: "close" }); response.end(); });
  server.maxConnections = 4;
  server.requestTimeout = timeoutMs;
  server.headersTimeout = timeoutMs;
  server.setTimeout(timeoutMs, socket => socket.destroy());
  const wss = new WebSocketServer({ noServer: true, maxPayload: Math.min(maxBytes, 4 * 1024 * 1024), perMessageDeflate: false });
  const rawSockets = new Map();
  let downstream, upstream, terminal = false, slotReserved = false, fatal, closePromise, disconnectPromise, pairTimer;
  let queued = [];

  function remember(error) {
    const value = error instanceof Error ? error : new Error(String(error));
    fatal ??= value;
    if (ledger.errors.length < 16) ledger.errors.push({ ...stamp(), error: String(value) }); else ledger.suppressedErrors++;
    return value;
  }
  function terminatePair() {
    terminal = true;
    clearTimeout(pairTimer);
    for (const item of queued) item.row.notForwarded = "Original connection closed before upstream became open";
    queued = [];
    for (const side of [downstream, upstream]) {
      if (side && side.socket.readyState !== WebSocket.CLOSED) {
        side.record.closeRequested ??= stamp();
        side.record.terminateRequested ??= stamp();
        side.socket.terminate();
      }
    }
  }
  function fail(error, incomplete = false) {
    if (incomplete) ledger.captureComplete = false;
    remember(error);
    terminatePair();
    // Cleanup runs even if the caller has not yet reached its finally block.
    void close().catch(() => {});
  }
  function record(direction, raw, binary) {
    const bytes = Buffer.from(raw);
    if (ledger.records.length >= maxRecords || ledger.recordedBytes + bytes.length > maxBytes) {
      ledger.overflow = true;
      throw failure("OVERFLOW", "Full data-message evidence capacity exceeded; capture is incomplete");
    }
    const row = { sequence: ledger.records.length, ...stamp(), direction, binary, bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), bodyBase64: bytes.toString("base64") };
    if (!binary) {
      row.text = bytes.toString("utf8");
      try { row.json = JSON.parse(row.text); } catch { /* Raw text is forwarded unchanged, including non-JSON. */ }
    }
    ledger.records.push(row); ledger.recordedBytes += bytes.length;
    return { row, bytes, binary };
  }
  function forward(destination, item) {
    if (terminal || destination?.socket.readyState !== WebSocket.OPEN) {
      item.row.notForwarded = "Original connection is closed";
      return;
    }
    item.row.forwardRequested = stamp();
    destination.socket.send(item.bytes, { binary: item.binary }, error => {
      if (error) {
        item.row.forwardError = String(error);
        if (!terminal) fail(error);
      } else item.row.forwarded = stamp();
    });
  }
  function track(socket, record, side) {
    let resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    const value = { socket, record, closed };
    socket.on("error", error => {
      record.errors ??= [];
      if (record.errors.length < 4) record.errors.push({ ...stamp(), error: String(error) });
      if (!terminal) fail(error, typeof error.code === "string" && error.code.startsWith("WS_ERR_"));
    });
    socket.once("close", (code, reason) => {
      Object.assign(record, { closeObserved: true, closed: stamp(), closeCode: code, closeReason: reason.toString() });
      terminal = true;
      for (const item of queued) item.row.notForwarded = "Original connection closed before upstream became open";
      queued = [];
      const other = side === "downstream" ? upstream : downstream;
      if (other && other.socket.readyState !== WebSocket.CLOSED) {
        other.record.closeRequested ??= stamp();
        if (other.socket.readyState === WebSocket.OPEN && code !== 1005 && code !== 1006 && code !== 1015) other.socket.close(code, reason);
        else { other.record.terminateRequested ??= stamp(); other.socket.terminate(); }
        clearTimeout(pairTimer);
        pairTimer = setTimeout(() => terminatePair(), timeoutMs);
      } else clearTimeout(pairTimer);
      resolveClosed();
    });
    socket.on("message", (raw, binary) => {
      let item;
      try { item = recordMessage(side, raw, binary); }
      catch (error) { fail(error, true); return; }
      if (terminal) { item.row.notForwarded = "Original connection is closed"; return; }
      if (side === "downstream" && upstream?.socket.readyState === WebSocket.CONNECTING) queued.push(item);
      else forward(side === "downstream" ? upstream : downstream, item);
    });
    return value;
  }
  // Avoid shadowing the side's lifecycle record in track().
  const recordMessage = (side, raw, binary) => record(`${side}->${side === "downstream" ? "upstream" : "downstream"}`, raw, binary);
  server.on("connection", socket => {
    const closed = new Promise(resolve => socket.once("close", () => { rawSockets.delete(socket); resolve(); }));
    rawSockets.set(socket, closed);
  });
  server.on("upgrade", (request, socket, head) => {
    ledger.attemptCount++;
    if (ledger.attempts.length >= maxAttempts) {
      ledger.overflow = true; socket.destroy();
      fail(failure("OVERFLOW", "Connection-attempt evidence capacity exceeded; capture is incomplete"), true);
      return;
    }
    const attempt = { sequence: ledger.attemptCount - 1, ...stamp(), exactPath: request.url === endpoint.pathname, accepted: false };
    ledger.attempts.push(attempt);
    if (!attempt.exactPath || terminal || slotReserved || closePromise) {
      attempt.rejected = stamp();
      attempt.reason = !attempt.exactPath ? "wrong Browser root path" : "original connection cannot reconnect";
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    // Reserve the sole slot before accepting the upgrade; no second attempt
    // can open an upstream, even if this handshake or the upstream fails.
    slotReserved = true;
    try {
      wss.handleUpgrade(request, socket, head, peer => {
        attempt.accepted = true;
        ledger.acceptedConnections++;
        ledger.downstream.opened = stamp();
        downstream = track(peer, ledger.downstream, "downstream");
        ledger.upstreamAttempts++;
        ledger.upstream.connectRequested = stamp();
        upstream = track(new WebSocket(endpoint.targetURL, {
          handshakeTimeout: timeoutMs, maxPayload: Math.min(maxBytes, 4 * 1024 * 1024),
          perMessageDeflate: false, followRedirects: false
        }), ledger.upstream, "upstream");
        upstream.socket.once("open", () => {
          ledger.upstream.opened = stamp();
          if (terminal) { terminatePair(); return; }
          const pending = queued; queued = [];
          for (const item of pending) forward(upstream, item);
        });
      });
    } catch (error) { socket.destroy(); fail(error); }
  });
  server.on("error", error => fail(error));
  wss.on("error", error => fail(error));
  await new Promise((resolve, reject) => {
    const onError = error => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError); server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  ledger.url = `ws://127.0.0.1:${server.address().port}${endpoint.pathname}`;
  ledger.server.listening = stamp();

  async function closePair() {
    terminatePair();
    await within(Promise.all([downstream?.closed, upstream?.closed]), timeoutMs, "Actual upstream/downstream close was not observed");
    clearTimeout(pairTimer);
  }
  function throwFailures() { if (fatal) throw fatal; }
  function disconnect() {
    if (!disconnectPromise) disconnectPromise = (async () => {
      if (!downstream) throw failure("NO_CONNECTION", "No original accepted connection exists to disconnect");
      ledger.faultInjection = { kind: "explicit termination of original upstream and downstream; not natural network loss", requested: stamp() };
      try { await closePair(); ledger.faultInjection.actualCloseObserved = stamp(); }
      catch (error) { remember(error); }
      throwFailures();
    })();
    return disconnectPromise.then(() => { throwFailures(); });
  }
  function close() {
    if (!closePromise) closePromise = (async () => {
      ledger.server.closeRequested ??= stamp();
      const listenerClosed = new Promise(resolve => server.close(error => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") remember(error);
        ledger.server.closeObserved = !error || error.code === "ERR_SERVER_NOT_RUNNING";
        ledger.server.closed = stamp(); resolve();
      }));
      const websocketServerClosed = new Promise(resolve => wss.close(resolve));
      const rawClosed = [...rawSockets.values()];
      terminatePair();
      for (const socket of rawSockets.keys()) socket.destroy();
      try { await closePair(); } catch (error) { remember(error); }
      try { await within(Promise.all([listenerClosed, websocketServerClosed, ...rawClosed]), timeoutMs, "Actual relay server/socket close was not observed"); }
      catch (error) { remember(error); }
      throwFailures();
    })();
    return closePromise;
  }
  return { url: ledger.url, snapshot: () => structuredClone(ledger), disconnect, close };
}
