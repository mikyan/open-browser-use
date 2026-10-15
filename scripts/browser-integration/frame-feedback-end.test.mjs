import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
// Exercise the saved runner without importing its browser-launching entry point.
const sourcePath = new URL('./run.mjs', import.meta.url);
const source = fs.readFileSync(sourcePath, 'utf8');
const start = source.indexOf('  async function endFrameTargetFeedback(');
const end = source.indexOf('  for (const pointerMode of ', start);
assert.ok(start > 0 && end > start);
const helper = source.slice(start, end).trim();
assert.equal(source.split('  async function endFrameTargetFeedback(').length, 2);
assert.equal(source.split('  for (const pointerMode of ').length, 2);
const turn = () => new Promise(resolve => setImmediate(resolve));
function setup({ beforeVisible = true, beforeError, hiddenError, endError, holdEnd = false } = {}) {
  let reads = 0, ends = 0, clock = 0, release;
  const trace = [], gate = new Promise(resolve => { release = resolve; });
  const value = { states: [{ tabId: 7, frames: [{ frameId: 0, documentId: 'original-document' }] }] };
  const worker = { async evaluate() { reads++; trace.push(`read${reads}`); if (reads === 1 && beforeError) throw beforeError; if (reads === 2 && hiddenError) throw hiddenError;
    return [{ frameId: 0, documentId: 'original-document', result: { state: { business: { original: true }, geometry: { x: 10 } }, openAgentLayers: reads === 1 && beforeVisible ? 1 : 0, opacity: reads === 1 && beforeVisible ? '1' : '0', rings: 0 } }]; } };
  const owner = { client: { async turnEnded() { ends++; trace.push('end-request'); if (holdEnd) await gate; if (endError) { trace.push('end-reject'); throw endError; } trace.push('end-ack'); } } };
  const context = vm.createContext({ assert, worker, until: async fn => { const result = await fn(); assert.ok(result); return result; }, Date: { now: () => clock }, setTimeout: (fn, ms) => { clock += ms; queueMicrotask(fn); } });
  const invoke = vm.runInContext(`(${helper})`, context);
  return { invoke: options => invoke(owner, value, options), value, trace, release, ends: () => ends, reads: () => reads };
}
test('deferred missing layer waits actual single End ACK then records hidden proof before preserving failure', async () => {
  const f = setup({ beforeVisible: false, holdEnd: true }); let settled = false;
  const pending = f.invoke({ deferVisibleAssertion: true }).then(() => { settled = true; throw Error('unexpected success'); }, e => { settled = true; return e; });
  await turn(); assert.equal(f.ends(), 1); assert.equal(f.reads(), 1); assert.equal(settled, false); assert.equal(f.value.endCleanup.endRequested, true); assert.equal(f.value.endCleanup.endAcknowledged, undefined);
  f.release(); const error = await pending; assert.equal(error.code, 'ERR_ASSERTION'); assert.equal(f.value.endCleanup.endAcknowledged, true); assert.equal(f.value.endCleanup.hiddenObservedMs, 550);
  assert.equal(f.value.endCleanup.closed.length, 1); assert.equal(f.value.endCleanup.after.length, 1); assert.equal(f.ends(), 1); assert.deepEqual(f.trace, ['read1','end-request','end-ack','read2','read3']);
});
test('deferred initial read error still waits single original End ACK and preserves exact error identity', async () => {
  const original = Error('original read failed'), f = setup({ beforeError: original, holdEnd: true }); let settled = false;
  const pending = f.invoke({ deferVisibleAssertion: true }).catch(e => { settled = true; return e; });
  await turn(); assert.equal(f.ends(), 1); assert.equal(settled, false); f.release(); assert.equal(await pending, original);
  assert.equal(f.value.endCleanup.endAcknowledged, true); assert.equal(f.value.endCleanup.beforeError, String(original)); assert.equal(f.value.endCleanup.closed, undefined); assert.equal(f.reads(), 1);
});
test('deferred read and End failures keep original read identity and actual failed End evidence', async () => {
  const original = Error('original read failed'), native = Error('original End failed'), f = setup({ beforeError: original, endError: native });
  await assert.rejects(f.invoke({ deferVisibleAssertion: true }), e => e === original);
  assert.equal(f.ends(), 1); assert.equal(f.value.endCleanup.endAcknowledged, undefined); assert.equal(f.value.endCleanup.endError, String(native));
});
test('deferred missing layer and hidden read failure retain original visible failure and both error observations', async () => {
  const hidden = Error('hidden observation failed'), f = setup({ beforeVisible: false, hiddenError: hidden });
  await assert.rejects(f.invoke({ deferVisibleAssertion: true }), e => e.code === 'ERR_ASSERTION' && e !== hidden);
  assert.equal(f.value.endCleanup.endAcknowledged, true); assert.equal(f.value.endCleanup.hiddenError, String(hidden)); assert.ok(f.value.endCleanup.beforeVisibilityError); assert.equal(f.ends(), 1);
});
test('deferred missing layer and rejected End retain the original visibility failure without a second End', async () => {
  const native = Error('original End failed'), f = setup({ beforeVisible: false, endError: native });
  await assert.rejects(f.invoke({ deferVisibleAssertion: true }), e => e.code === 'ERR_ASSERTION' && e !== native);
  assert.equal(f.ends(), 1); assert.equal(f.reads(), 1);
  assert.equal(f.value.endCleanup.endError, String(native));
  assert.ok(f.value.endCleanup.beforeVisibilityError);
  assert.equal(f.value.endCleanup.endAcknowledged, undefined);
  assert.equal(f.value.endCleanup.closed, undefined);
});
test('deferred healthy initial state preserves a rejected End as the original failure', async () => {
  const native = Error('original End failed'), f = setup({ endError: native });
  await assert.rejects(f.invoke({ deferVisibleAssertion: true }), e => e === native);
  assert.equal(f.ends(), 1); assert.equal(f.reads(), 1);
  assert.equal(f.value.endCleanup.endError, String(native));
  assert.equal(f.value.endCleanup.beforeVisibilityError, undefined);
});
test('default missing layer keeps preexisting validation-before-End behavior', async () => {
  const f = setup({ beforeVisible: false }); await assert.rejects(f.invoke(), { code: 'ERR_ASSERTION' }); assert.equal(f.ends(), 0); assert.equal(f.reads(), 1); assert.equal(f.value.endCleanup.endRequested, undefined);
});
test('default healthy helper keeps one End and all original hide observations without new-mode flags', async () => {
  const f = setup(); const result = await f.invoke(); assert.equal(result.hidden, true); assert.equal(result.originalDocuments, 1); assert.equal(result.hiddenObservedMs, 550); assert.equal(f.ends(), 1); assert.equal(f.reads(), 3); assert.equal(f.value.endCleanup.endRequested, undefined);
});
test('deferred healthy helper records actual ACK and does not replay End', async () => {
  const f = setup(); const result = await f.invoke({ deferVisibleAssertion: true }); assert.equal(result.hidden, true); assert.equal(f.value.endCleanup.endRequested, true); assert.equal(f.value.endCleanup.endAcknowledged, true); assert.equal(f.ends(), 1);
});
test('root-only adapter finally retains end evidence even when helper rejects', async () => {
  const anchor = source.indexOf('if (coldRootRebuild) await test('), from = source.indexOf('checkEnd: async (value, owner) => {', anchor), to = source.indexOf('\n    });', from);
  assert.ok(from > anchor && to > from); const adapter = source.slice(from + 'checkEnd: '.length, to).trim();
  const original = Error('original helper failure'), evidence = { endRequested: true, endAcknowledged: true };
  const fn = vm.runInNewContext(`(${adapter})`, { endFrameTargetFeedback: async (_owner, value, options) => { assert.equal(options.deferVisibleAssertion, true); value.endCleanup = evidence; throw original; } });
  const value = { states: [] }; await assert.rejects(fn(value, {}), e => e === original); assert.equal(value.endEvidence, evidence);
});
