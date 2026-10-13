import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
import { OpenBrowserUseBrowser, OpenBrowserUseClient, encodeFrame } from "../dist/index.js";
import { responseBodyParams, validateResponseBody, MAX_RESPONSE_BODY_BYTES } from "../dist/response-body.js";
const ref = { captureId: "diag,[]中文", requestId: "request-7" };
const info = { metadata: { turnLifecycleVersion: 1, responseBodyVersion: 1 } };
const state = { controlEpoch: 7, nextTurnId: "next", lifecycleVersion: 1, closing: false };
const body = (bytes = Buffer.from([0, 255, 13, 10])) => ({...ref, encoding:"base64", data:bytes.toString("base64"), byteLength:bytes.length});
const envelope = value => ({value,engine:{name:"playwright-crx",version:"1",playwrightVersion:"1",capabilities:{responseBody:1}}});
async function fixture(t, handler) {
  const path = process.platform === "win32" ? `\\\\.\\pipe\\obu-export-${randomUUID()}` : join(tmpdir(), `obu-export-${randomUUID()}.sock`);
  const calls = [], sockets = new Set(), timers = [];
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = endianness() === "LE" ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
        if (buffer.length < size + 4) break;
        const request = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4); calls.push(request);
        handler(request, value => socket.write(encodeFrame({ id: request.id, result: value })), message => socket.write(encodeFrame({ id: request.id, error: { message } })), (fn, ms) => timers.push(setTimeout(fn, ms)));
      }
    });
  });
  await new Promise(resolve => server.listen(path, resolve));
  const client = new OpenBrowserUseClient({ socketPath: path, turnId: "initial" });
  t.after(async () => { timers.forEach(clearTimeout); client.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { client, calls, tab: new OpenBrowserUseBrowser({ client }).tab(9) };
}


test("responseBody facade and alias use one original request, captured refs and scope", async t => {
 const input={...ref}, options={maxBytes:32,timeoutMs:1000};
 const f=await fixture(t,(req,reply)=>{
  if(req.method==="getInfo"){input.requestId="changed";options.maxBytes=1;return reply(info)}
  if(req.method==="getControlState") return reply(state);
  assert.equal(req.method,"browserAction");assert.equal(req.params.action,"responseBody");
  assert.deepEqual(req.params.args,{...ref,maxBytes:32});assert.equal(req.params.locator,undefined);
  assert.equal(req.params.turn_id,"initial");assert.equal(req.params.control_epoch,7);
  assert.ok(req.params.timeoutMs>0&&req.params.timeoutMs<=1000);reply(envelope(body()));
 });
 assert.deepEqual(await f.tab.responseBody(input,options),body());
 assert.deepEqual(await f.tab.playwright.responseBody(ref,{maxBytes:32,timeoutMs:1000}),body());
 assert.equal(f.calls.filter(r=>r.method==="browserAction").length,2);
});
test("responseBody rejects invalid ref/options/raw locator before connecting",async t=>{
 const f=await fixture(t,()=>assert.fail("invalid input reached wire"));
 for(const bad of [null,{}, {...ref,extra:1},{...ref,requestId:""},{...ref,captureId:"中".repeat(43)},{...ref,requestId:"\ud800"}]) await assert.rejects(f.tab.responseBody(bad),/OBU_RESPONSE_BODY_INVALID/);
 for(const options of [null,{maxBytes:0},{maxBytes:MAX_RESPONSE_BODY_BYTES+1},{maxBytes:true},{timeoutMs:null},{timeoutMs:1.5},{timeoutMs:120001},{url:"https://example.com"}]) await assert.rejects(f.tab.responseBody(ref,options),/OBU_RESPONSE_BODY_INVALID/);
 for(const extra of [{locator:[]},{args:{...ref,maxBytes:null}},{args:{...ref,url:"x"}}]) await assert.rejects(f.client.request("browserAction",{tabId:9,action:"responseBody",args:ref,...extra}),/OBU_RESPONSE_BODY_INVALID/);
 assert.equal(f.calls.length,0);assert.equal(responseBodyParams(ref).args.maxBytes,1048576);
});
test("canonical bytes include empty body and reject mismatched refs/schema/base64/length",()=>{
 assert.deepEqual(validateResponseBody(body(Buffer.alloc(0)),ref,1),body(Buffer.alloc(0)));
 const valid=body(Buffer.from([255]));
 for(const value of [null,{}, {...valid,extra:1},{...valid,captureId:"wrong"},{...valid,requestId:"wrong"},{...valid,data:"/x=="},{...valid,data:"_w=="},{...valid,data:"/w=\n"},{...valid,byteLength:0},{...valid,byteLength:true},{...valid,encoding:"utf8"}]) assert.throws(()=>validateResponseBody(value,ref,32),/OBU_RESPONSE_BODY_FAILED/);
 assert.throws(()=>validateResponseBody(body(),ref,3),/FAILED/);
 const boundary=body(Buffer.alloc(MAX_RESPONSE_BODY_BYTES,255));assert.equal(validateResponseBody(boundary,ref,MAX_RESPONSE_BODY_BYTES).byteLength,MAX_RESPONSE_BODY_BYTES);
});
test("typed and explicit-epoch raw calls negotiate metadata and validate engine capability",async t=>{
 for(const version of [undefined,true,2]) for(const raw of [false,true]) {
  const f=await fixture(t,(req,reply)=>{assert.notEqual(req.method,"browserAction");reply(req.method==="getInfo"?{metadata:{turnLifecycleVersion:1,responseBodyVersion:version}}:state)});
  await assert.rejects(raw?f.client.request("browserAction",{tabId:9,action:"responseBody",args:ref,control_epoch:7}):f.tab.responseBody(ref),/UNSUPPORTED/);
 }
 for(const invalid of [{...envelope(body()),engine:{...envelope(body()).engine,capabilities:{responseBody:true}}},envelope({...body(),requestId:"other"})]) {
  const f=await fixture(t,(req,reply)=>reply(req.method==="getInfo"?info:req.method==="getControlState"?state:invalid));
  await assert.rejects(f.client.request("browserAction",{tabId:9,action:"responseBody",args:ref,control_epoch:7}),/UNSUPPORTED|FAILED/);
 }
});
test("discovery consumes original body deadline and no request is replayed after failure",async t=>{
 const f=await fixture(t,(req,reply,fail,later)=>{if(req.method==="getInfo")return later(()=>reply(info),80);if(req.method==="getControlState")return reply(state);assert.fail("expired request sent")});
 await assert.rejects(f.tab.responseBody(ref,{timeoutMs:10}),/timed out/);assert.equal(f.calls.some(r=>r.method==="browserAction"),false);
 for(const message of ["OBU_RESPONSE_BODY_EXPIRED", "OBU_RESPONSE_BODY_UNAVAILABLE", "OBU_RESPONSE_BODY_TOO_LARGE"]) {
  const one=await fixture(t,(req,reply,fail)=>req.method==="browserAction"?fail(message):reply(req.method==="getInfo"?info:state));
  await assert.rejects(one.tab.responseBody(ref),new RegExp(message));assert.equal(one.calls.filter(r=>r.method==="browserAction").length,1);
 }
});

test("body already submitted in an ended turn keeps the original epoch and is not replayed",async t=>{
 let entered,finish;const ready=new Promise(resolve=>{entered=resolve});
 const f=await fixture(t,(req,reply,fail)=>{
  if(req.method==="getInfo")return reply(info);
  if(req.method==="getControlState")return reply(state);
  if(req.method==="turnEnded")return reply({...state,controlEpoch:8,nextTurnId:"next-8",endedTurnId:"initial"});
  assert.equal(req.params.control_epoch,7);assert.equal(req.params.turn_id,"initial");
  finish=()=>fail("OBU_RESPONSE_BODY_EXPIRED: original scope ended");entered();
 });
 const pending=f.tab.responseBody(ref);await ready;
 const rejected=assert.rejects(pending,/OBU_RESPONSE_BODY_EXPIRED/);
 await f.client.turnEnded();finish();await rejected;
 assert.equal(f.calls.filter(r=>r.method==="browserAction").length,1);
});
