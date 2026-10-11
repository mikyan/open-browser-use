import assert from "node:assert/strict";
import test from "node:test";
import { runChooserProcess } from "./chooser-process.mjs";

const env = { ...process.env, OBU_GO_CHOOSER_DIAGNOSTIC: "1" };
const prelude = `
const readline = require('node:readline');
const reader = readline.createInterface({input:process.stdin})[Symbol.asyncIterator]();
const item = {key:'go-chooser-root',variant:'root',tabId:42};
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let id=0;
async function hook(kind, value=item) {
  send({type:'hook',version:1,id:++id,kind,item:value});
  const next=await reader.next(); if(next.done)throw new Error('ACK EOF');
  const ack=JSON.parse(next.value);
  if(ack.type!=='ack'||ack.version!==1||ack.id!==id||typeof ack.ok!=='boolean')throw new Error('ACK identity');
  return ack;
}
function done(result) { send({type:'result',version:1,result}); }
`;
const script = body => prelude + `(async()=>{${body}})().catch(error=>{process.stderr.write(String(error));process.exitCode=1;process.stdin.destroy()});`;
const run = (body, options = {}) => runChooserProcess(process.execPath, ["-e", script(body)], { env, onHook: async () => {}, ...options });
function closed(value) {
  assert.equal(value.process.closeObserved, true);
  assert.equal(typeof value.process.closedAt, "number");
  assert.ok(value.process.closedAt >= value.process.startedAt);
}
function protocolFailed(value, pattern) {
  closed(value); assert.equal(value.protocolComplete, false);
  assert.ok(value.errors.some(error => pattern.test(error.error)), JSON.stringify(value.errors));
}

test("chooser protocol requires the diagnostic flag and a bounded total deadline before spawning", async () => {
  for (const options of [{ env: {} }, { env, onHook: null }, { env, timeoutMs: 0 }, { env, timeoutMs: 120001 }, { env, timeoutMs: NaN }])
    await assert.rejects(runChooserProcess(process.execPath, [], { onHook: async () => {}, ...options }));
});

test("real child completes three ordered variants, ACKs and one result through natural stdin EOF", async () => {
  const seen = [];
  const value = await run(`
    const acks=[];
    for(const [index,variant] of ['root','oopif','dynamic-oopif'].entries()) {
      const current={key:'go-'+variant,variant,tabId:42+index};
      acks.push(await hook('start',current));
      if(variant==='oopif')acks.push(await hook('failure',current));
      acks.push(await hook('finish',current));
    }
    process.stderr.write('original stderr 中文🙂');
    done({caller:'go',acks});
  `, { onHook: async (message, context) => {
    seen.push(message.id); assert.equal(context.signal.aborted, false);
    assert.equal(context.budgetMs, { start: 4000, failure: 3500, finish: 2000 }[message.kind]);
    assert.ok(context.deadlineAt > Date.now());
  } });
  closed(value); assert.equal(value.protocolComplete, true); assert.equal(value.process.exitObserved, true);
  assert.equal(value.process.exitCode, 0); assert.equal(value.process.signal, null);
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7]); assert.deepEqual(value.errors, []);
  assert.ok(value.result.acks.every(ack => ack.ok)); assert.ok(value.hooks.every(record => record.ackWrittenAt));
  assert.equal(value.process.stderr, "original stderr 中文🙂"); assert.deepEqual(value.process.terminationRequests, []);
});

test("split UTF-8 JSONL and a final pipe tail are preserved without resolving on exit", async () => {
  const value = await run(`
    const payload=Buffer.from(JSON.stringify({type:'result',version:1,result:{text:'中文🙂',tail:'x'.repeat(60000)}})+'\\n');
    for(const byte of payload)process.stdout.write(Buffer.from([byte]));
    process.stderr.write('最后的尾部');
  `);
  closed(value); assert.equal(value.protocolComplete, true); assert.equal(value.process.exitCode, 0);
  assert.equal(value.result.text, "中文🙂"); assert.equal(value.result.tail.length, 60000);
  assert.equal(value.process.stderr, "最后的尾部"); assert.ok(value.process.stdout.endsWith("}\n"));
  assert.equal(value.process.stdoutBytes, Buffer.byteLength(value.process.stdout));
});

test("a hook failure sends one negative ACK and permits original failure/finish and partial result", async () => {
  const seen = [];
  const value = await run(`
    const a=await hook('start');
    const b=await hook('failure');
    const c=await hook('finish');
    process.stderr.write('original chooser timeout'); process.exitCode=1;
    done({error:'original chooser timeout',acks:[a,b,c],variants:[{variant:'root'}]});
  `, { onHook: async message => {
    seen.push(message.kind); if (message.kind === "start") throw new Error("diagnostic install failed");
  } });
  closed(value); assert.equal(value.process.exitCode, 1); assert.equal(value.protocolComplete, false);
  assert.deepEqual(seen, ["start", "failure", "finish"]);
  assert.deepEqual(value.result.acks.map(ack => ack.ok), [false, true, true]);
  assert.match(value.result.acks[0].error, /install failed/);
  assert.equal(value.result.error, "original chooser timeout"); assert.equal(value.process.stderr, "original chooser timeout");
  assert.equal(value.errors.length, 1); assert.equal(value.errors[0].kind, "hook");
});

test("a real hook timer rejects a never-settling callback once without retry or a late ACK", async () => {
  const seen = [], signals = [];
  const value = await run(`
    const a=await hook('start'); const b=await hook('finish');
    done({acks:[a,b]});
  `, { onHook: (message, context) => {
    seen.push(message.kind); signals.push(context.signal);
    return message.kind === "finish" ? new Promise(() => {}) : undefined;
  }, timeoutMs: 8000 });
  closed(value); assert.equal(value.process.exitCode, 0); assert.equal(value.protocolComplete, false);
  assert.deepEqual(seen, ["start", "finish"]); assert.equal(signals[1].aborted, true);
  assert.deepEqual(value.result.acks.map(ack => ack.ok), [true, false]);
  assert.match(value.result.acks[1].error, /2000ms/); assert.equal(value.hooks.length, 2);
  assert.deepEqual(value.process.terminationRequests, []);
});

test("original nonzero exit is preserved independently from a complete diagnostic protocol", async () => {
  const value = await run(`await hook('start');await hook('finish');done({error:'native failed',partial:[1]});process.exitCode=7;process.stderr.write('native failure');`);
  closed(value); assert.equal(value.protocolComplete, true); assert.equal(value.process.exitCode, 7);
  assert.equal(value.result.error, "native failed"); assert.equal(value.process.stderr, "native failure");
});

for (const [name, body, pattern] of [
  ["overlapping variants", `await hook('start');send({type:'hook',version:1,id:2,kind:'start',item:{key:'second',variant:'oopif',tabId:43}});`, /Overlapping/],
  ["repeated failure", `await hook('start');await hook('failure');send({type:'hook',version:1,id:3,kind:'failure',item});`, /Repeated chooser failure/],
  ["changed identity", `await hook('start');send({type:'hook',version:1,id:2,kind:'finish',item:{...item,tabId:99}});`, /match the active/],
  ["repeated variant", `await hook('start');await hook('finish');send({type:'hook',version:1,id:3,kind:'start',item});`, /repeated chooser variant/],
  ["skipped ID", `send({type:'hook',version:1,id:2,kind:'start',item});`, /sequence/],
  ["result before finish", `await hook('start');done({partial:true});`, /before variant finish/],
  ["two results", `done({first:true});done({second:true});`, /unique chooser result/],
  ["unknown envelope field", `send({type:'hook',version:1,id:1,kind:'start',item,extra:true});`, /envelope/],
  ["malformed JSON", `process.stdout.write('{bad}\\n');`, /Invalid chooser JSONL/],
  ["nonobject result", `send({type:'result',version:1,result:[]});`, /result envelope/],
  ["unterminated line", `process.stdout.write(JSON.stringify({type:'result',version:1,result:{}}));process.stdin.destroy();`, /incomplete JSONL/],
  ["invalid UTF-8", `process.stdout.write(Buffer.from([123,34,120,34,58,34,255,34,125,10]));`, /Invalid chooser JSONL/]
]) test(`protocol rejects ${name} without accepting a replacement result`, async () => {
  const value = await run(body); protocolFailed(value, pattern);
  if (name === "two results") assert.deepEqual(value.result, { first: true });
});

test("pipelined hook cannot invoke another hook while its predecessor waits for ACK", async () => {
  let calls = 0;
  const value = await run(`
    process.stdout.write(JSON.stringify({type:'hook',version:1,id:1,kind:'start',item})+'\\n'+JSON.stringify({type:'hook',version:1,id:2,kind:'finish',item})+'\\n');
  `, { onHook: async () => { calls++; await new Promise(() => {}); } });
  protocolFailed(value, /before the previous hook ACK/);
  assert.ok(calls <= 1); assert.ok(value.hooks.every(hook => hook.ackSkipped));
});

test("total timeout terminates only its child, awaits close, and aborts pending hooks", async () => {
  let signal;
  const value = await run(`await hook('start');`, { timeoutMs: 400, onHook: (_message, context) => {
    signal = context.signal; return new Promise(() => {});
  } });
  closed(value); assert.equal(value.protocolComplete, false); assert.ok(value.errors.some(error => error.kind === "timeout"));
  assert.ok(value.process.terminationRequests.length >= 1); assert.equal(signal?.aborted, true);
  assert.ok(value.process.durationMs < 5000); assert.equal(value.hooks[0].ackSkipped, true);
});

test("child close aborts an outstanding hook and preserves original stderr and exit", async () => {
  const value = await run(`
    send({type:'hook',version:1,id:1,kind:'start',item});
    setTimeout(()=>{process.stderr.write('Go died before ACK',()=>process.exit(9));},100);
  `, { onHook: async () => new Promise(() => {}) });
  closed(value); assert.equal(value.process.exitCode, 9); assert.equal(value.process.stderr, "Go died before ACK");
  assert.equal(value.protocolComplete, false); assert.ok(value.errors.some(error => /closed before hook/.test(error.error)));
});

for (const [name, body, pattern, limit] of [
  ["line", `process.stdout.write('x'.repeat(1024*1024+1));`, /line exceeded/, 4 * 1024 * 1024],
  ["stdout", `for(const [index,variant]of ['root','oopif','dynamic-oopif'].entries()){const large={key:'k'.repeat(740000)+index,variant,tabId:42+index};await hook('start',large);await hook('finish',large);}`, /stdout exceeded/, 4 * 1024 * 1024],
  ["stderr", `process.stderr.write('e'.repeat(64*1024+1));`, /stderr exceeded/, 64 * 1024]
]) test(`${name} capacity overflow is explicit and retained output remains bounded`, async () => {
  const value = await run(body); protocolFailed(value, pattern);
  assert.ok(Buffer.byteLength(name === "stderr" ? value.process.stderr : value.process.stdout) <= limit);
  if (name === "stdout") assert.equal(value.process.stdoutTruncated, true);
  if (name === "stderr") { assert.equal(value.process.stderrTruncated, true); assert.equal(value.process.stderr.length, limit); }
});

test("spawn failure is a report with real close evidence, not a false zero exit", async () => {
  const value = await runChooserProcess(`obu-missing-chooser-${process.pid}`, [], { env, onHook: async () => {} });
  closed(value); assert.equal(value.protocolComplete, false); assert.ok(value.process.spawnError);
  assert.notEqual(value.process.exitCode, 0); assert.equal(value.result, null);
});
