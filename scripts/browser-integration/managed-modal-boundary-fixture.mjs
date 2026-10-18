import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

export const managedModalBoundaryCases = Object.freeze(["native-navigation", "native-pre-attach"]);
const encoded = value => { const bytes = Buffer.from(value); return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), base64: bytes.toString("base64") }; };
const js = value => JSON.stringify(value).replaceAll("<", "\\u003c");

// One original navigation or one original gate release. Telemetry GETs never
// stand in for a native dialog Opening; only the emitter sends a business POST.
export function createManagedModalBoundaryFixture({ baseURL, scenario }) {
  const base = new URL(baseURL);
  assert.equal(base.protocol, "http:"); assert.equal(base.hostname, "127.0.0.1");
  assert.ok(Number(base.port) >= 49152 && Number(base.port) <= 65535);
  assert.equal(base.pathname, "/"); assert.equal(base.search + base.hash + base.username + base.password, "");
  assert.ok(managedModalBoundaryCases.includes(scenario));
  const workflowId = randomUUID(), prefix = `/modal-boundary/${workflowId}/`;
  const urls = Object.fromEntries(["source", "destination", "gate", "entered", "receipt"].map(role => [role, new URL(prefix + role, base).href]));
  const emitterRole = scenario === "native-navigation" ? "destination" : "source";
  const prompt = { type: "prompt", message: `Original ${scenario} prompt`, defaultPrompt: "原始默认值" };
  const requests = [], tokens = {}; let overflow = false, receipt = null, attempted = false, gate, gateReleased = false;
  const stats = () => structuredClone({ workflowId, scenario, urls, emitterRole, tokens, requests, overflow, receipt, gateReleased });
  function html(role) {
    const emitter = role === emitterRole;
    const state = { workflowId, scenario, role, documentToken: tokens[role], sourceDocumentToken: tokens.source, phase: emitter ? "waiting" : "ready", clicks: [], events: [], answer: null, postAttempts: 0, error: null };
    const call = `state.phase='dialog';state.events.push({phase:'before',type:'prompt'});render();
fetch(${js(urls.entered)},{cache:'no-store'}).catch(()=>{});
const answer=window.prompt(${js(prompt.message)},${js(prompt.defaultPrompt)});
if(answer!==null)throw Error('diagnostic permits original cancellation only');
state.answer=answer;state.events.push({phase:'after',type:'prompt',answer});state.postAttempts++;state.phase='posting';render();
const body={workflowId:state.workflowId,scenario:state.scenario,role:state.role,documentToken:state.documentToken,sourceDocumentToken:state.sourceDocumentToken,clicks:state.clicks,events:state.events,answer:state.answer,postAttempts:state.postAttempts};
const response=await fetch(${js(urls.receipt)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const result=await response.json();document.querySelector('#result').textContent=JSON.stringify(result);if(!response.ok||result.ok!==true)throw Error('original receipt rejected');state.phase='committed';render();`;
    return `<!doctype html><meta charset="utf-8"><title>Original modal boundary ${role}</title><link rel="icon" href="data:,">
<style>body{font:18px sans-serif;margin:20px;background:#edf4ff;color:#17324d}a{display:inline-block;padding:16px;background:white;border:2px solid #456}pre{white-space:pre-wrap}[hidden]{display:none!important}</style>
<h1>${scenario} · ${role}</h1>${!emitter ? `<a id="navigate" href=${js(urls.destination)}>Navigate once to original prompt</a>` : '<p>Original native prompt diagnostic</p>'}
<p id="phase"></p><pre id="state" hidden></pre><pre id="result"></pre><script>
const state=${js(state)},key=${js(prefix)},render=()=>{document.querySelector('#state').textContent=JSON.stringify(state);document.querySelector('#phase').textContent=state.phase};render();
${!emitter ? `document.querySelector('#navigate').addEventListener('click',event=>{const click={trusted:event.isTrusted,button:event.button,ctrlKey:event.ctrlKey,altKey:event.altKey,shiftKey:event.shiftKey,metaKey:event.metaKey};state.clicks.push(click);if(state.clicks.length!==1||!click.trusted||click.button!==0||click.ctrlKey||click.altKey||click.shiftKey||click.metaKey){event.preventDefault();state.error='one original unmodified click required';state.phase='failed';render();return}sessionStorage.setItem(key,JSON.stringify({sourceDocumentToken:state.documentToken,clicks:state.clicks}));state.phase='navigating';render()});` : `(async()=>{try{${scenario === "native-pre-attach" ? `const gate=await fetch(${js(urls.gate)},{cache:'no-store'});if(!gate.ok||await gate.text()!=='release-original-once')throw Error('original gate rejected');` : `const previous=JSON.parse(sessionStorage.getItem(key));if(previous.sourceDocumentToken!==state.sourceDocumentToken)throw Error('original source token mismatch');state.clicks=previous.clicks;`}${call}}catch(error){state.error=String(error).slice(0,1024);state.phase='failed';render()}})();`}
</script>`;
  }
  function handle(request, response) {
    let url; try { url = new URL(request.url, base); } catch { return false; }
    if (!url.pathname.startsWith(prefix)) return false;
    if (requests.length >= 16) { overflow = true; request.resume(); response.writeHead(429); response.end(); return true; }
    const hit = { sequence: requests.length + 1, at: Date.now(), method: request.method, host: request.headers.host, url: request.url, body: encoded(""), finished: false, aborted: false, errors: [] }; requests.push(hit);
    response.once("finish", () => { hit.finished = true; }); response.once("close", () => { hit.aborted = !response.writableFinished; });
    for (const stream of [request, response]) stream.once("error", error => hit.errors.push(String(error).slice(0,256)));
    const reply = (status, text, type = "application/json; charset=utf-8") => { const bytes=Buffer.from(text); hit.status=status;hit.response=encoded(bytes);response.writeHead(status,{"Content-Type":type,"Content-Length":bytes.length,"Cache-Control":"no-store"});response.end(bytes); };
    const reject = (status, message) => { request.resume();reply(status,JSON.stringify({ok:false,error:message})); };
    if (request.url !== url.pathname || request.headers.host !== base.host) { reject(400,"exact original host/route required");return true; }
    const role = Object.keys(urls).find(role=>new URL(urls[role]).pathname===url.pathname);
    if (!role) { reject(404,"unknown original route");return true; }
    if (request.method === "GET") {
      request.resume();
      if (requests.some(row=>row!==hit&&row.method==="GET"&&row.url===request.url)) { reject(409,"GET replay forbidden");return true; }
      if (role === "source" || role === "destination" && scenario === "native-navigation" && tokens.source) { tokens[role]=randomUUID();hit.documentToken=tokens[role];reply(200,html(role),"text/html; charset=utf-8");return true; }
      if (role === "gate" && scenario === "native-pre-attach" && tokens.source) { gate={reply};return true; }
      if (role === "entered" && tokens[emitterRole]) { reply(200,'{"observed":"before-call-marker-only"}');return true; }
      reject(409,"original document order required");return true;
    }
    if (request.method !== "POST" || role !== "receipt") { reject(405,"original receipt POST required");return true; }
    const duplicate=attempted;attempted=true;let size=0;const chunks=[];
    request.on("data",bytes=>{size+=bytes.length;if(size<=16384)chunks.push(bytes)});
    request.once("end",()=>{const bytes=Buffer.concat(chunks);hit.body={...encoded(bytes),receivedBytes:size,truncated:size>16384};
      if(duplicate||size>16384){reply(duplicate?409:413,'{"ok":false}');return;}
      try{const body=JSON.parse(bytes);assert.equal(JSON.stringify(body),bytes.toString());assert.deepEqual(body,expectedBody());
        receipt={ok:true,workflowId,scenario,documentToken:tokens[emitterRole],sourceDocumentToken:tokens.source,answer:null,postAttempts:1,receiptId:randomUUID()};reply(200,JSON.stringify(receipt));
      }catch{reply(400,'{"ok":false,"error":"original evidence mismatch"}');}});return true;
  }
  function expectedBody() { assert.ok(tokens[emitterRole]&&tokens.source); return { workflowId,scenario,role:emitterRole,documentToken:tokens[emitterRole],sourceDocumentToken:tokens.source,
    clicks:scenario==="native-navigation"?[{trusted:true,button:0,ctrlKey:false,altKey:false,shiftKey:false,metaKey:false}]:[],events:[{phase:"before",type:"prompt"},{phase:"after",type:"prompt",answer:null}],answer:null,postAttempts:1 }; }
  function releaseGate() { assert.equal(scenario,"native-pre-attach");assert.ok(gate&&!gateReleased);gateReleased=true;gate.reply(200,"release-original-once","text/plain; charset=utf-8");return{at:Date.now(),scope:"server gate release is not native modal proof"}; }
  function verify(document) { assert.ok(receipt);assert.equal(overflow,false);assert.equal(requests.filter(row=>row.method==="POST").length,1);assert.ok(requests.every(row=>row.finished&&!row.aborted&&!row.errors.length&&row.status===200));
    const expected = scenario==="native-navigation"?["source","destination","entered","receipt"]:["source","gate","entered","receipt"];
    assert.deepEqual(requests.map(row=>row.url).sort(),expected.map(role=>new URL(urls[role]).pathname).sort());
    assert.equal(document.url,urls[emitterRole]);assert.equal(document.state.phase,"committed");assert.equal(document.state.error,null);
    for(const [key,value]of Object.entries(expectedBody()))assert.deepEqual(document.state[key],value);assert.deepEqual(document.result,receipt);return structuredClone(receipt); }
  return { workflowId,scenario,urls:Object.freeze(urls),emitterRole,prompt:Object.freeze(prompt),handle,stats,releaseGate,verify };
}

export function readManagedModalBoundaryDocument() { const read=id=>JSON.parse(document.querySelector(id).textContent||"null");return{url:location.href,state:read("#state"),result:read("#result")}; }
export function measureManagedModalBoundaryLink() { const node=document.querySelector("#navigate"),r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2; if(r.width<=0||r.height<=0||x<=0||y<=0||x>=innerWidth||y>=innerHeight||document.elementFromPoint(x,y)!==node)throw Error("original link is not visible");return{x,y,url:location.href,href:node.href,viewport:{width:innerWidth,height:innerHeight}}; }
