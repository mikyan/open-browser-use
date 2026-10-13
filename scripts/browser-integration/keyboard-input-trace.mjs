import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";

export const KEYBOARD_INPUT_TRACE_LIMITS = Object.freeze({
  bufferKiB: 16 * 1024, retainedBytes: 32 * 1024 * 1024,
  chunkBytes: 64 * 1024, reads: 1024, readMs: 30_000,
  commandMs: 20_000, completionMs: 20_000, suppressedEvents: 256
});
const interesting = ["Input Suppressed", "RenderWidgetHostImpl::ForwardKeyboardEvent",
  "LatencyInfo.Flow", "RenderWidgetHostImpl::SetPageFocus", "clock_sync"];
const stamp = () => ({ epochMs: Date.now(), monotonicMs: performance.now() });
const failure = message => new Error(`Keyboard input trace: ${message}`);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

// Only the input category is needed for Input Suppressed and its latency flow.
// SetPageFocus is counted if present but belongs to content, which is not enabled.
// No event in this browser-wide trace is attributed to a page by this helper.
function summarize(bytes, detail) {
  let trace;
  try { trace = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw failure("retained stream is not complete UTF-8 trace JSON"); }
  if (!object(trace) || !Array.isArray(trace.traceEvents)) throw failure("traceEvents array is missing");
  const counts = Object.fromEntries(interesting.map(name => [name, 0]));
  const suppressed = [], clocks = []; let metadataBytes = 0;
  for (const event of trace.traceEvents) {
    if (!object(event) || typeof event.name !== "string") throw failure("malformed trace event");
    if (Object.hasOwn(counts, event.name)) counts[event.name]++;
    if (event.name === "Input Suppressed") {
      if (suppressed.length === KEYBOARD_INPUT_TRACE_LIMITS.suppressedEvents)
        throw failure("suppression metadata limit exceeded; original stream retained");
      const row = { pid: event.pid, tid: event.tid, ts: event.ts, ph: event.ph, cat: event.cat, args: event.args };
      metadataBytes += Buffer.byteLength(JSON.stringify(row));
      if (metadataBytes > 256 * 1024) throw failure("suppression metadata byte limit exceeded; original stream retained");
      suppressed.push(row);
    }
    if (event.name === "clock_sync" && detail.markers.some(marker => marker.syncId === event.args?.sync_id)) {
      if (clocks.length >= 4) throw failure("duplicate original clock markers; original stream retained");
      clocks.push({ pid: event.pid, tid: event.tid, ts: event.ts, ph: event.ph, cat: event.cat, args: event.args });
    }
  }
  detail.summary = { eventCount: trace.traceEvents.length, counts, suppressed, clocks,
    pageAttribution: "Not inferred; browser-wide native events require independent process/widget correlation." };
  const positions = detail.markers.map(marker => clocks.filter(event => event.args?.sync_id === marker.syncId));
  if (detail.markers.length !== 2 || positions.some(values => values.length !== 1 || !Number.isFinite(values[0].ts)) ||
      positions[0][0].ts > positions[1][0].ts)
    throw failure("original start/end clock markers are missing, duplicated or out of order");
  detail.summary.clockMarkersVerified = true;
}

function decodePart(part) {
  if (!object(part) || typeof part.data !== "string" || typeof part.eof !== "boolean" ||
      (part.base64Encoded !== undefined && typeof part.base64Encoded !== "boolean"))
    throw failure("malformed IO.read response");
  let bytes;
  if (part.base64Encoded === true) {
    if (part.data.length > Math.ceil(KEYBOARD_INPUT_TRACE_LIMITS.chunkBytes / 3) * 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data) || part.data.length % 4 !== 0)
      throw failure("invalid or oversized base64 chunk");
    bytes = Buffer.from(part.data, "base64");
    if (bytes.toString("base64") !== part.data) throw failure("noncanonical base64 chunk");
  } else {
    if (part.data.length > KEYBOARD_INPUT_TRACE_LIMITS.chunkBytes) throw failure("oversized text chunk");
    bytes = Buffer.from(part.data, "utf8");
    if (bytes.toString("utf8") !== part.data) throw failure("invalid Unicode text chunk");
  }
  if (bytes.length > KEYBOARD_INPUT_TRACE_LIMITS.chunkBytes) throw failure("chunk exceeded requested size");
  if (!bytes.length && !part.eof) throw failure("trace stream made no progress");
  return bytes;
}

export async function startKeyboardInputTrace({ connection, saveArtifact, saveDetail }) {
  if (!connection || typeof connection.call !== "function" || !Array.isArray(connection.events) ||
      typeof saveArtifact !== "function" || typeof saveDetail !== "function")
    throw new TypeError("Keyboard input trace requires connection and save callbacks");
  const limits = KEYBOARD_INPUT_TRACE_LIMITS, id = randomUUID(), cursor = connection.events.length;
  const detail = { version: 1, id, passed: false, started: false, startOutcome: "pending", requestedAt: stamp(),
    limits, config: { transferMode: "ReturnAsStream", streamFormat: "json", streamCompression: "none",
      traceConfig: { recordMode: "recordUntilFull", traceBufferSizeInKb: limits.bufferKiB, includedCategories: ["input"] } },
    markers: [], commands: [], reads: [], errors: [], completion: null, streamClose: null,
    artifact: null, summary: null };
  const chunks = []; let length = 0, eof = false, stopPromise, primary;
  const remember = (stage, error) => {
    primary ??= error;
    detail.errors.push({ stage, message: String(error?.message ?? error).slice(0, 2048) });
  };
  const call = async (method, params, timeoutMs = limits.commandMs) => {
    if (!(timeoutMs > 0)) throw failure(`${method} exceeded its deadline`);
    const entry = { sequence: detail.commands.length + 1, method, requestedAt: stamp(), settled: false };
    detail.commands.push(entry);
    let timer;
    const actual = Promise.resolve().then(() => connection.call(method, params));
    actual.then(() => { entry.settled = true; entry.settledAt = stamp(); }, error => {
      entry.settled = true; entry.settledAt = stamp(); entry.error = String(error?.message ?? error).slice(0, 2048);
    });
    try {
      return await Promise.race([actual, new Promise((_, reject) => {
        timer = setTimeout(() => { entry.timedOut = true; reject(failure(`${method} exceeded its deadline`)); }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  const marker = async phase => {
    const requestedAt = stamp(), syncId = `obu-keyboard-${id}-${phase}-${requestedAt.epochMs}`;
    const entry = { phase, syncId, requestedAt }; detail.markers.push(entry);
    try { await call("Tracing.recordClockSyncMarker", { syncId }); entry.acknowledgedAt = stamp(); }
    catch (error) { entry.error = String(error?.message ?? error).slice(0, 2048); throw error; }
  };
  const completion = async () => {
    const deadline = performance.now() + limits.completionMs;
    while (true) {
      if (connection.events.length < cursor) throw failure("native event history was truncated");
      const matches = connection.events.slice(cursor).filter(event => event.method === "Tracing.tracingComplete");
      if (matches.length > 1) throw failure("multiple tracingComplete events for one trace");
      if (matches.length) return matches[0].params;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw failure("tracingComplete deadline expired");
      await new Promise(resolve => setTimeout(resolve, Math.min(20, remaining)));
    }
  };
  const persist = async () => {
    const bytes = Buffer.concat(chunks, length), name = "keyboard-input-trace.json";
    detail.artifact = { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      completeRead: eof, parsed: detail.summary !== null };
    try { await saveArtifact(name, bytes); detail.artifact.saved = true; }
    catch (error) { remember("save-artifact", error); detail.artifact.saved = false; }
    detail.finishedAt = stamp();
    detail.passed = !primary;
    try { await saveDetail(detail); }
    catch (error) { remember("save-detail", error); detail.passed = false; }
  };
  const finish = async () => {
    let stream;
    if (detail.started) {
      try { await marker("end"); } catch (error) { remember("end-marker", error); }
      try { await call("Tracing.end", {}); } catch (error) { remember("end", error); }
      try {
        const value = await completion();
        // Preserve exact completion fields. A known stream is closed even if
        // format or data-loss metadata is invalid.
        detail.completion = value;
        if (!object(value) || typeof value.stream !== "string" || !value.stream || value.stream.length > 1024)
          throw failure("native completion did not provide a bounded stream handle");
        stream = value.stream;
        if (value.dataLossOccurred !== false) remember("data-loss", failure("dataLossOccurred is not false"));
        if (value.traceFormat !== "json" || ![undefined, "none"].includes(value.streamCompression))
          remember("trace-format", failure("native trace format/compression differs from request"));
        const deadline = performance.now() + limits.readMs;
        while (true) {
          if (detail.reads.length >= limits.reads) throw failure("trace read count limit exceeded");
          const remaining = deadline - performance.now();
          if (remaining <= 0) throw failure("trace total read deadline expired");
          const part = await call("IO.read", { handle: stream, size: limits.chunkBytes }, Math.min(limits.commandMs, remaining));
          const bytes = decodePart(part), available = limits.retainedBytes - length;
          const retained = bytes.subarray(0, Math.max(0, available));
          chunks.push(retained); length += retained.length;
          detail.reads.push({ index: detail.reads.length, bytes: bytes.length, retainedBytes: retained.length,
            base64Encoded: part.base64Encoded === true, eof: part.eof });
          if (bytes.length > available) throw failure("trace retained-byte limit exceeded");
          if (performance.now() >= deadline) throw failure("trace total read deadline expired");
          if (part.eof) { eof = true; break; }
        }
      } catch (error) { remember("stream", error); }
      finally {
        if (stream) {
          detail.streamClose = { handle: stream, requestedAt: stamp(), acknowledged: false };
          try { await call("IO.close", { handle: stream }); detail.streamClose.acknowledged = true; detail.streamClose.acknowledgedAt = stamp(); }
          catch (error) { detail.streamClose.error = String(error?.message ?? error).slice(0, 2048); remember("stream-close", error); }
        }
      }
      if (eof) try { summarize(Buffer.concat(chunks, length), detail); } catch (error) { remember("parse", error); }
    }
    await persist();
    if (primary) {
      const error = failure(detail.errors.map(value => `${value.stage}: ${value.message}`).join("; "));
      error.keyboardInputTrace = detail; throw error;
    }
    return detail;
  };
  const stop = () => stopPromise ??= finish();
  try {
    await call("Tracing.start", detail.config); detail.started = true; detail.startOutcome = "acknowledged"; detail.startedAt = stamp();
    await marker("start");
    return Object.freeze({ stop });
  } catch (error) {
    remember(detail.started ? "start-marker" : "start", error);
    if (!detail.started) { detail.startOutcome = "unconfirmed"; detail.cleanupUnconfirmed = true; }
    // The connection cannot distinguish every timeout/disconnect from a native
    // start rejection. Without its ACK we cannot safely end someone else's
    // trace or claim cleanup. The isolated browser must be torn down by caller.
    // An acknowledged start with marker failure still owns mandatory cleanup.
    return stop();
  }
}
