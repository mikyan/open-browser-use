import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { KEYBOARD_INPUT_TRACE_LIMITS as limits, startKeyboardInputTrace } from "./keyboard-input-trace.mjs";

// Protocol responses below are simulations for collector correctness. They are
// not evidence of Chromium suppression, native focus or real event delivery.
const tick = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function environment(options = {}) {
  const calls = [], saved = [], details = [], markers = [], events = options.events ?? [];
  let offset = 0, bytes, reads = 0;
  const fixture = { calls, saved, details, markers, get bytes() { return bytes; },
    connection: { events, async call(method, params) {
      calls.push({ method, params: structuredClone(params) });
      if (method === "Tracing.start") { if (options.startError) throw Error(options.startError); return {}; }
      if (method === "Tracing.recordClockSyncMarker") {
        markers.push(params.syncId);
        if (options.markerError === markers.length) throw Error("simulated marker failure");
        return {};
      }
      if (method === "Tracing.end") {
        const trace = { traceEvents: [
          ...markers.map((sync_id, index) => ({ name: "clock_sync", cat: "__metadata", ph: "c", ts: index + 1,
            pid: 9, tid: 10, args: { sync_id } })),
          { name: "Input Suppressed", cat: "input", ph: "I", ts: 4, pid: 77, tid: 78,
            args: { suppress_input: { DeferMainFrameUpdates: false, DeferCommits: true, HasNotPainted: false } } },
          { name: "RenderWidgetHostImpl::ForwardKeyboardEvent", cat: "input", ph: "B", ts: 5, pid: 1, tid: 2, args: {} }
        ] };
        options.transformTrace?.(trace);
        bytes = options.bytes ?? Buffer.from(JSON.stringify(trace));
        if (!options.noCompletion) events.push({ method: "Tracing.tracingComplete", params: {
          stream: "original-stream", traceFormat: "json", streamCompression: "none", dataLossOccurred: false,
          ...options.completion } });
        if (options.endError) throw Error(options.endError);
        return {};
      }
      if (method === "IO.read") {
        assert.equal(params.handle, "original-stream"); assert.equal(params.size, limits.chunkBytes);
        if (options.read) return options.read(reads++, bytes);
        const part = bytes.subarray(offset, offset + (options.chunkSize ?? 107)); offset += part.length;
        return { data: options.text ? part.toString("utf8") : part.toString("base64"), eof: offset === bytes.length,
          ...(options.text ? {} : { base64Encoded: true }) };
      }
      if (method === "IO.close") { assert.equal(params.handle, "original-stream"); if (options.closeError) throw Error("simulated close failure"); return {}; }
      throw Error("Unexpected protocol method");
    } },
    saveArtifact: async (name, data) => { saved.push({ name, bytes: Buffer.from(data) }); if (options.saveError) throw Error("simulated artifact save failure"); },
    saveDetail: async detail => { details.push(structuredClone(detail)); if (options.detailError) throw Error("simulated detail save failure"); }
  };
  return fixture;
}
async function failed(fixture) {
  let controller;
  try { controller = await startKeyboardInputTrace(fixture); await controller.stop(); }
  catch (error) { assert.ok(error.keyboardInputTrace); return error; }
  assert.fail("Collector accepted failed evidence");
}
const count = (fixture, method) => fixture.calls.filter(row => row.method === method).length;

test("one native trace and exact original stream survive chunking; repeated stop shares the same operation", async () => {
  const fixture = environment({ events: [{ method: "Tracing.tracingComplete", params: { stream: "stale" } }] });
  const controller = await startKeyboardInputTrace(fixture), first = controller.stop();
  assert.strictEqual(controller.stop(), first);
  const detail = await first;
  assert.equal(detail.passed, true); assert.equal(detail.artifact.completeRead, true);
  assert.deepEqual(fixture.calls[0], { method: "Tracing.start", params: {
    transferMode: "ReturnAsStream", streamFormat: "json", streamCompression: "none",
    traceConfig: { recordMode: "recordUntilFull", traceBufferSizeInKb: 16384, includedCategories: ["input"] }
  } });
  assert.equal(count(fixture, "Tracing.start"), 1); assert.equal(count(fixture, "Tracing.end"), 1);
  assert.equal(count(fixture, "IO.close"), 1); assert.equal(count(fixture, "Tracing.recordClockSyncMarker"), 2);
  assert.deepEqual(fixture.saved[0].bytes, fixture.bytes); assert.equal(detail.artifact.sha256, hash(fixture.bytes));
  assert.equal(detail.summary.counts["Input Suppressed"], 1);
  const { name, ...suppressed } = JSON.parse(fixture.bytes).traceEvents[2];
  assert.deepEqual(detail.summary.suppressed[0], suppressed);
});

test("clock labels retain Node epochs and actual marker ACK; text chunks retain exact UTF-8", async () => {
  const fixture = environment({ text: true, chunkSize: limits.chunkBytes });
  const detail = await (await startKeyboardInputTrace(fixture)).stop();
  for (const marker of detail.markers) {
    assert.ok(marker.syncId.endsWith(`-${marker.phase}-${marker.requestedAt.epochMs}`));
    assert.ok(marker.acknowledgedAt.monotonicMs >= marker.requestedAt.monotonicMs);
    assert.ok(detail.summary.clocks.some(event => event.args.sync_id === marker.syncId));
  }
  assert.match(detail.summary.pageAttribution, /Not inferred/);
  assert.equal(Object.hasOwn(detail.summary.suppressed[0], "tabId"), false);
  assert.deepEqual(fixture.saved[0].bytes, fixture.bytes);
});

test("ACK without the two exact original native clock markers cannot prove coverage", async t => {
  const variants = {
    missing(trace) { trace.traceEvents.shift(); },
    duplicate(trace) { trace.traceEvents.push(structuredClone(trace.traceEvents[0])); },
    foreign(trace) { trace.traceEvents[0].args.sync_id = "someone-else"; },
    reversed(trace) { trace.traceEvents[0].ts = 999; },
    invalidTime(trace) { trace.traceEvents[0].ts = "not a timestamp"; }
  };
  for (const [name, transformTrace] of Object.entries(variants)) await t.test(name, async () => {
    const fixture = environment({ transformTrace, chunkSize: limits.chunkBytes }), error = await failed(fixture);
    assert.match(error.message, /clock markers/); assert.equal(count(fixture, "IO.close"), 1);
    assert.deepEqual(fixture.saved[0].bytes, fixture.bytes); assert.equal(fixture.details[0].passed, false);
  });
});

test("suppression summary count and bytes are bounded; full original bytes remain available", async t => {
  for (const transformTrace of [
    trace => { for (let i = 0; i < limits.suppressedEvents; i++) trace.traceEvents.push(structuredClone(trace.traceEvents[2])); },
    trace => { trace.traceEvents[2].args.extra = "x".repeat(256 * 1024); }
  ]) await t.test("bounded summary", async () => {
    const fixture = environment({ transformTrace, chunkSize: limits.chunkBytes }), error = await failed(fixture);
    assert.match(error.message, /metadata .*limit/); assert.deepEqual(fixture.saved[0].bytes, fixture.bytes);
  });
});

test("both true and missing native data-loss values fail despite valid bytes; owned stream is still closed", async t => {
  for (const value of [true, undefined]) await t.test(String(value), async () => {
    const fixture = environment({ completion: { dataLossOccurred: value } }), error = await failed(fixture);
    assert.match(error.message, /dataLossOccurred/); assert.equal(count(fixture, "IO.close"), 1);
    assert.deepEqual(fixture.saved[0].bytes, fixture.bytes); assert.equal(fixture.details[0].passed, false);
  });
});

test("unconfirmed start cannot stop another trace or claim cleanup", async () => {
  const fixture = environment({ startError: "already tracing" }), error = await failed(fixture);
  assert.match(error.message, /already tracing/); assert.equal(count(fixture, "Tracing.end"), 0);
  assert.equal(fixture.saved[0].bytes.length, 0); assert.equal(error.keyboardInputTrace.started, false);
  assert.equal(error.keyboardInputTrace.startOutcome, "unconfirmed"); assert.equal(error.keyboardInputTrace.cleanupUnconfirmed, true);
});

test("marker failure is never silent and cannot skip owned end/read/close", async t => {
  for (const markerError of [1, 2]) await t.test(`marker ${markerError}`, async () => {
    const fixture = environment({ markerError }), error = await failed(fixture);
    assert.match(error.message, /marker failure/); assert.equal(count(fixture, "Tracing.start"), 1);
    assert.equal(count(fixture, "Tracing.end"), 1); assert.equal(count(fixture, "IO.close"), 1);
    assert.deepEqual(fixture.saved[0].bytes, fixture.bytes); assert.equal(error.keyboardInputTrace.passed, false);
  });
});

test("end rejection still consumes the actual completion/stream instead of replaying end", async () => {
  const fixture = environment({ endError: "end reply failure" }), error = await failed(fixture);
  assert.match(error.message, /end reply failure/); assert.equal(count(fixture, "Tracing.end"), 1);
  assert.equal(count(fixture, "IO.close"), 1); assert.deepEqual(fixture.saved[0].bytes, fixture.bytes);
});

test("partial original bytes are persisted after a read rejection", async () => {
  const original = Buffer.from('{"traceEvents":[');
  const fixture = environment({ read(index) { if (index) throw Error("read failed"); return { data: original.toString("base64"), base64Encoded: true, eof: false }; } });
  const error = await failed(fixture);
  assert.deepEqual(fixture.saved[0].bytes, original); assert.equal(error.keyboardInputTrace.artifact.completeRead, false);
  assert.equal(error.keyboardInputTrace.artifact.sha256, hash(original)); assert.equal(count(fixture, "IO.close"), 1);
});

test("malformed, no-progress and oversized chunks fail with no retry and close the original handle", async t => {
  for (const [name, response] of [
    ["empty", { data: "", eof: false }], ["noncanonical", { data: "YR==", base64Encoded: true, eof: true }],
    ["bad padding", { data: "aaaa====", base64Encoded: true, eof: true }],
    ["oversize", { data: "x".repeat(limits.chunkBytes + 1), eof: true }],
    ["surrogate", { data: "\ud800", eof: true }], ["no EOF", { data: "{}" }]
  ]) await t.test(name, async () => {
    const fixture = environment({ read: () => response }); await failed(fixture);
    assert.equal(count(fixture, "IO.read"), 1); assert.equal(count(fixture, "IO.close"), 1);
    assert.equal(fixture.details[0].passed, false);
  });
});

test("retained-byte cap saves exactly the original prefix and refuses further reads", async () => {
  const chunk = "x".repeat(limits.chunkBytes), fixture = environment({ read: () => ({ data: chunk, eof: false }) });
  const error = await failed(fixture);
  assert.match(error.message, /retained-byte limit/); assert.equal(fixture.saved[0].bytes.length, limits.retainedBytes);
  assert.equal(count(fixture, "IO.read"), limits.retainedBytes / limits.chunkBytes + 1); assert.equal(count(fixture, "IO.close"), 1);
});

test("tiny nonempty chunks cannot exceed the bounded original read count", async () => {
  const fixture = environment({ read: () => ({ data: " ", eof: false }) }), error = await failed(fixture);
  assert.match(error.message, /read count limit/); assert.equal(count(fixture, "IO.read"), limits.reads);
  assert.equal(fixture.saved[0].bytes.length, limits.reads); assert.equal(count(fixture, "IO.close"), 1);
});

test("total read deadline does not restart per chunk and close runs after failure", async t => {
  let now = 0; t.mock.method(performance, "now", () => now);
  const fixture = environment({ read() { now += 16_000; return { data: " ", eof: false }; } });
  const error = await failed(fixture);
  assert.match(error.message, /total read deadline/); assert.equal(count(fixture, "IO.read"), 2);
  assert.equal(count(fixture, "IO.close"), 1); assert.equal(fixture.saved[0].bytes.length, 2);
});

test("a final EOF response after the original read deadline still fails", async t => {
  let now = 0; t.mock.method(performance, "now", () => now);
  const fixture = environment({ read(index, bytes) { now = limits.readMs + 1; return { data: bytes.toString("base64"), base64Encoded: true, eof: true }; } });
  const error = await failed(fixture); assert.match(error.message, /total read deadline/);
  assert.deepEqual(fixture.saved[0].bytes, fixture.bytes); assert.equal(count(fixture, "IO.close"), 1);
});

test("pending read times out visibly, closes once, and is not claimed settled", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const held = deferred(), fixture = environment({ read: () => held.promise });
  const controller = await startKeyboardInputTrace(fixture), stopped = controller.stop();
  const outcome = stopped.catch(error => error); await tick();
  assert.equal(count(fixture, "IO.read"), 1); t.mock.timers.tick(limits.commandMs); await tick();
  const error = await outcome;
  assert.match(error.message, /IO.read exceeded/); assert.equal(count(fixture, "IO.close"), 1);
  const read = fixture.details[0].commands.find(row => row.method === "IO.read");
  assert.equal(read.settled, false); assert.equal(read.timedOut, true);
  held.resolve({ data: "", eof: true }); await tick(); assert.equal(count(fixture, "IO.read"), 1);
});

test("missing completion is bounded and cannot manufacture a stream to close", async t => {
  let now = 0; t.mock.method(performance, "now", () => now); t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = environment({ noCompletion: true }), controller = await startKeyboardInputTrace(fixture);
  const outcome = controller.stop().catch(error => error); await tick(); now = limits.completionMs; t.mock.timers.tick(20); await tick();
  const error = await outcome; assert.match(error.message, /tracingComplete deadline/);
  assert.equal(count(fixture, "IO.close"), 0); assert.equal(fixture.saved[0].bytes.length, 0);
});

test("invalid UTF-8/JSON and unexpected native stream metadata remain failed with original bytes", async t => {
  for (const options of [{ bytes: Buffer.from([0xff, 0xfe]) }, { bytes: Buffer.from('{"traceEvents":[') },
    { bytes: Buffer.from('{}') }, { completion: { traceFormat: "proto" } }, { completion: { streamCompression: "gzip" } }])
    await t.test(JSON.stringify(options), async () => {
      const fixture = environment(options); await failed(fixture);
      assert.deepEqual(fixture.saved[0].bytes, fixture.bytes); assert.equal(count(fixture, "IO.close"), 1);
    });
});

test("IO.close rejection and save callback failures cannot report success or retry cleanup", async t => {
  for (const options of [{ closeError: true }, { saveError: true }, { detailError: true }]) await t.test(JSON.stringify(options), async () => {
    const fixture = environment(options), error = await failed(fixture);
    assert.equal(error.keyboardInputTrace.passed, false); assert.equal(count(fixture, "IO.close"), 1);
    assert.equal(count(fixture, "Tracing.start"), 1);
  });
});
