import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { endianness, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { OpenBrowserUseBrowser, OpenBrowserUseClient, encodeFrame } from "../dist/index.js";

async function fixture(t, handler, timeoutMs = 500) {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "obu-control-"));
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\obu-control-${randomUUID()}` : join(directory, "s.sock");
  const calls = [], sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = endianness() === "LE" ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
        if (buffer.length < length + 4) break;
        const request = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        calls.push(request);
        const reply = result => socket.write(encodeFrame({ jsonrpc: "2.0", id: request.id, result }));
        const fail = message => socket.write(encodeFrame({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message } }));
        handler(request, reply, fail);
      }
    });
  });
  await new Promise(resolve => server.listen(endpoint, resolve));
  const client = new OpenBrowserUseClient({ socketPath: endpoint, sessionId: "test", turnId: "initial", timeoutMs });
  t.after(async () => {
    client.close(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    const actual = await realpath(directory);
    assert.equal(dirname(actual), root); assert.equal(actual, directory);
    await rm(actual, { recursive: true, force: true });
  });
  return { client, calls };
}
const state = {controlEpoch: 7, nextTurnId: "next", closing: false, lifecycleVersion: 1};
const info = version => ({metadata: {turnLifecycleVersion: 1, ...(version === undefined ? {} : {backgroundWindowVersion: version})}});
const ok = {value: null, engine: {name: "playwright-crx", version: "1", playwrightVersion: "1"}};

test("background window omission and false preserve original create wire", async t => {
 const {client,calls}=await fixture(t,(r,reply)=>reply(r.method==='getInfo'?info():r.method==='getControlState'?state:{id:12}));
 const browser=new OpenBrowserUseBrowser({client});
 await client.createTab(); await client.createTab({backgroundWindow:false});
 await browser.newTab(); await browser.newTab({backgroundWindow:false});
 assert.deepEqual(calls.map(r=>r.method),['getInfo','getControlState',...Array(4).fill('createTab')]);
 for(const r of calls.filter(r=>r.method==='createTab'))assert.deepEqual(r.params,{session_id:'test',turn_id:'initial',control_epoch:7});
});
test("background window true negotiates each creation and navigation retains scope only", async t => {
 const {client,calls}=await fixture(t,(r,reply)=>reply(r.method==='getInfo'?info(1):r.method==='getControlState'?state:r.method==='browserAction'?ok:{id:12}));
 await client.createTab({backgroundWindow:true});
 const tab=await new OpenBrowserUseBrowser({client}).newTab({backgroundWindow:true,url:'https://fixture.test',timeoutMs:300});
 assert.equal(tab.id,12);
 assert.deepEqual(calls.map(r=>r.method),['getInfo','getControlState','getInfo','createTab','getInfo','createTab','browserAction']);
 for(const r of calls.filter(r=>r.method==='createTab'))assert.deepEqual(r.params,{session_id:'test',turn_id:'initial',control_epoch:7,backgroundWindow:true});
 const navigation=calls.at(-1);assert.equal(navigation.params.backgroundWindow,undefined);assert.equal(navigation.params.control_epoch,7);assert.equal(navigation.params.turn_id,'initial');
});
test("background window missing or malformed capability rejects before creation even with explicit scope", async t => {
 for(const version of [undefined,0,2,'1',true,null]){
  const {client,calls}=await fixture(t,(r,reply)=>reply(info(version)));
  await assert.rejects(client.request('createTab',{backgroundWindow:true,control_epoch:7}),/OBU_BACKGROUND_WINDOW_UNSUPPORTED/);
  assert.deepEqual(calls.map(r=>r.method),['getInfo']);
 }
});
test("background window capability is refreshed after prior successful use", async t => {
 let count=0;
 const {client,calls}=await fixture(t,(r,reply)=>reply(r.method==='getInfo'?info(++count<=2?1:0):r.method==='getControlState'?state:{id:12}));
 await client.createTab({backgroundWindow:true});
 await assert.rejects(client.createTab({backgroundWindow:true}),/OBU_BACKGROUND_WINDOW_UNSUPPORTED/);
 assert.equal(calls.filter(r=>r.method==='createTab').length,1);assert.equal(count,3);
});
test("background window rejects invalid values before IPC", async t => {
 const {client,calls}=await fixture(t,()=>assert.fail('invalid options reached wire'));
 for(const backgroundWindow of [null,0,1,'true',[],{}]){
  await assert.rejects(client.createTab({backgroundWindow}),/boolean/);
  await assert.rejects(new OpenBrowserUseBrowser({client}).newTab({backgroundWindow}),/boolean/);
  await assert.rejects(client.request('createTab',{backgroundWindow}),/boolean/);
 }
 await assert.rejects(client.createTab({unknown:true}),/Invalid createTab options/);
 await assert.rejects(client.createTab(null),/Invalid createTab options/);
 assert.equal(calls.length,0);
});
test("background window discovery consumes original deadline and never emits a late create", async t => {
 const {client,calls}=await fixture(t,(r,reply)=>{if(r.method==='getInfo')setTimeout(()=>reply(info(1)),80);else assert.fail('expired capability read emitted a mutation');},30);
 await assert.rejects(client.request('createTab',{backgroundWindow:true,control_epoch:7}),/timed out|timeout/i);
 await new Promise(resolve=>setTimeout(resolve,100));
 assert.deepEqual(calls.map(r=>r.method),['getInfo']);
});
test("background window native failure never replays create or starts goto", async t => {
 const {client,calls}=await fixture(t,(r,reply,fail)=>r.method==='createTab'?fail('native creation failed'):reply(r.method==='getInfo'?info(1):state));
 await assert.rejects(new OpenBrowserUseBrowser({client}).newTab({backgroundWindow:true,url:'https://fixture.test'}),/native creation failed/);
 assert.equal(calls.filter(r=>r.method==='createTab').length,1);assert.equal(calls.filter(r=>r.method==='browserAction').length,0);
});
