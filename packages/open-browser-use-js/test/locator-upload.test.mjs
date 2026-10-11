import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { endianness, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { OpenBrowserUseBrowser, OpenBrowserUseClient, encodeFrame } from "../dist/index.js";

async function fixture(t, handler, timeoutMs = 2000) {
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

const state = {controlEpoch: 7, nextTurnId: 'next', closing: false, lifecycleVersion: 1};
const envelope = version => ({value:null, engine:{name:'playwright-crx',version:'1',playwrightVersion:'1',capabilities:{locatorFileUpload:version}}});
const scope = {session_id:'test',turn_id:'initial',control_epoch:7};
function respond(r,reply,version=1) { reply(r.method==='getInfo'?{metadata:{turnLifecycleVersion:1}}:r.method==='getControlState'?state:envelope(version)); }
const tab = client => new OpenBrowserUseBrowser({client}).tab(12);
const isUpload = r => r.method==='browserAction'&&r.params.action==='setInputFiles';

test('locator upload uses exact frame/ref chain, copied paths and bound scope; [] clears; no capability cache', async t=>{
 let release;
 const {client,calls}=await fixture(t,(r,reply)=>{
  if(r.params?.action==='engineInfo'&&!release) release=()=>reply(envelope(1)); else respond(r,reply);
 });
 const files=['/tmp/中文.txt','C:\\folder\\b.bin','\\\\server\\share\\dir'];
 const original=[...files];
 const promise=tab(client).frameLocator('iframe').getByLabel('Files').setInputFiles(files,{timeoutMs:500});
 while(!release) await new Promise(r=>setImmediate(r));
 files[0]='/changed'; release(); await promise;
 await tab(client).getByRef('capture-1','e1').setInputFiles([]);
 const actions=calls.filter(r=>r.method==='browserAction');
 assert.deepEqual(actions.map(r=>r.params.action),['engineInfo','setInputFiles','engineInfo','setInputFiles']);
 assert.deepEqual(actions[1].params.args,{files:original});assert.deepEqual(actions[3].params.args,{files:[]});
 assert.deepEqual(actions[1].params.locator,[{kind:'frame',selector:'iframe'},{kind:'label',value:'Files'}]);
 assert.deepEqual(actions[3].params.locator,[{kind:'ref',captureId:'capture-1',ref:'e1'}]);
 for(const {params} of actions) { for(const [k,v] of Object.entries(scope))assert.equal(params[k],v); assert.equal(params.tabId,12); }
 for(const index of [0,2])assert.equal(actions[index].params.locator,undefined);
});

test('unsupported or malformed engine capability fails before setter, including explicit scope',async t=>{
 for(const capability of [undefined,null,0,2,true,'1']) {
  const {client,calls}=await fixture(t,(r,reply)=>reply(envelope(capability)));
  await assert.rejects(client.request('browserAction',{...scope,tabId:12,action:'setInputFiles',args:{files:[]}}),/OBU_LOCATOR_FILE_UPLOAD_UNSUPPORTED/);
  assert.equal(calls.length,1);assert.equal(calls[0].params.action,'engineInfo');
 }
 const {client,calls}=await fixture(t,(r,reply)=>reply({engine:{capabilities:{locatorFileUpload:1}}}));
 await assert.rejects(client.request('browserAction',{...scope,tabId:12,action:'setInputFiles',args:{files:[]}}),/UNSUPPORTED/);
 assert.equal(calls.length,1);
});

test('locator upload rejects invalid files, Unicode, options and byte limits before any IPC',async t=>{
 const {client,calls}=await fixture(t,()=>assert.fail('invalid request reached IPC'));
 const invalid=[null,'/a',{},[''],['a'],['C:relative'],['\\rooted'],['\\\\server'],['/a\0b'],['/\ud800'],[1],Array(1025).fill('/a'),['/'+ '界'.repeat(43691)],Array(65).fill('/'+'a'.repeat(131071))];
 for(const files of invalid) await assert.rejects(tab(client).locator('input').setInputFiles(files),/setInputFiles/);
 for(const timeoutMs of [null,true,0,1.2,120001]) await assert.rejects(tab(client).locator('input').setInputFiles([],{timeoutMs}),/timeoutMs/);
 await assert.rejects(tab(client).locator('input').setInputFiles([],{force:true}),/options/);
 await assert.rejects(client.request('browserAction',{action:'setInputFiles',args:{files:[],unknown:true}}),/args.files/);
 assert.equal(calls.length,0);
});

test('capability consumes original deadline even after wall clock moves backwards; no late setter',async t=>{
 let shifted=false; const now=Date.now.bind(Date);
 t.mock.method(Date,'now',()=>now()-(shifted?60000:0));
 const {client,calls}=await fixture(t,(r,reply)=>{
  if(r.params?.action==='engineInfo'){shifted=true;setTimeout(()=>reply(envelope(1)),70);}else respond(r,reply);
 });
 await assert.rejects(tab(client).locator('input').setInputFiles(['/tmp/a'],{timeoutMs:25}),/timed out/i);
 assert.equal(calls.filter(isUpload).length,0);
});

test('preflight cannot adopt a concurrent new turn and upload error is not replayed',async t=>{
 let release;let epoch=7;
 const {client,calls}=await fixture(t,(r,reply,fail)=>{
  if(r.params?.action==='engineInfo')release=()=>reply(envelope(1));
  else if(isUpload(r))fail('original upload failure');
  else if(r.method==='getControlState')reply({...state,controlEpoch:epoch});
  else respond(r,reply);
 });
 const pending=tab(client).locator('input').setInputFiles(['/tmp/a']);
 while(!release)await new Promise(r=>setImmediate(r));
 epoch=8;await client.beginTurn('new-turn');release();
 await assert.rejects(pending,/original upload failure/);
 const uploads=calls.filter(isUpload);assert.equal(uploads.length,1);
 assert.equal(uploads[0].params.turn_id,'initial');assert.equal(uploads[0].params.control_epoch,7);
});
