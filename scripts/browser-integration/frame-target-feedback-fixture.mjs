import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { decodeParallelPNG } from "./background-parallel-workflow.mjs";
import { installBoundingGeometryProbe } from "./bounding-geometry-fixture.mjs";

const route = "/frame-target-feedback/", hash = bytes => createHash("sha256").update(bytes).digest("hex"), errorText = error => error?.stack ?? String(error);
export const frameTargetLayouts = ["same", "oopif", "dynamic-oopif", "nested", "scaled-oopif", "rotated-oopif"];
const keyPattern = /^frame-feedback-[a-f0-9]{32}$/;
const near = (a, b, label, tolerance = .08) => assert.ok(Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance, `${label}: ${a} versus ${b}`);
const center = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const bounds = points => { const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y)); return { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y }; };
const nearPoint = (a, b, label, tolerance = .08) => { near(a?.x, b?.x, `${label} x`, tolerance); near(a?.y, b?.y, `${label} y`, tolerance); };
const nearBox = (a, b, label, tolerance = .08) => { for (const k of ["x", "y", "width", "height"]) near(a?.[k], b?.[k], `${label} ${k}`, tolerance); };

export function frameTargetURLs(base, key, layout) {
  assert.match(key, keyPattern); assert.ok(frameTargetLayouts.includes(layout));
  const root = new URL(`${route}page`, base); root.hostname = "127.0.0.1"; root.search = new URLSearchParams({ key, layout });
  const leaf = new URL(root); leaf.pathname = `${route}frame`; leaf.searchParams.set("role", "leaf"); if (layout !== "same" && layout !== "nested") leaf.hostname = "localhost";
  const middle = layout === "nested" ? new URL(leaf) : null; if (middle) { middle.hostname = "localhost"; middle.searchParams.set("role", "middle"); }
  return { root: root.href, middle: middle?.href ?? null, leaf: leaf.href };
}

export function frameTargetStyle(layout, role) {
  return role === "middle" ? { left: 24, top: 36, width: 510, height: 300, border: 4, originX: 17, originY: 13, angle: 0, sx: 1, sy: 1 } :
    { left: 76, top: 74, width: layout === "nested" ? 590 : 510, height: layout === "nested" ? 380 : 300, border: 6, originX: 21, originY: 17,
      angle: layout === "rotated-oopif" ? 11 : 0, sx: layout === "scaled-oopif" ? 1.17 : layout === "rotated-oopif" ? .94 : 1, sy: layout === "scaled-oopif" ? .88 : 1 };
}

// Fixture-owned passive observations; never focus, move or repair feedback.
export function installFrameTargetDocument(config) {
  const originalDocument = document, originalWindow = window, windowToken = crypto.randomUUID(), nodes = new Map();
  const events = [], focus = [], changes = [], rings = [], errors = [], roots = [], seen = new WeakSet(); let receipt = null, overflow = false;
  const add = (rows, row) => { if (rows.length >= 128) overflow = true; else rows.push({ sequence: rows.length + 1, ...row }); };
  const remember = () => { for (const id of ["note", "submit", "form", "panel", "proof", "frame", "add"]) { const node = document.getElementById(id); if (node && !nodes.has(id)) nodes.set(id, node); } }; remember();
  const box = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const describe = node => { if (!node) return null; const s = getComputedStyle(node); return { id: node.id, connected: node.isConnected, rect: box(node), styles: Object.fromEntries(["left", "top", "width", "height", "boxSizing", "borderLeftWidth", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "paddingLeft", "paddingTop", "transform", "transformOrigin", "zoom"].map(k => [k, s[k]])) }; };
  const observe = () => {
    const current = document.getElementById("open-browser-use-cursor-root");
    if (current && !roots.some(row => row.node === current)) { if (roots.length >= 8) overflow = true; else { const tree = current.shadowRoot ?? current; roots.push({ node: current, tree }); new MutationObserver(observe).observe(tree, { childList: true, subtree: true }); } }
    for (const [rootIndex, root] of roots.entries()) for (const ring of root.tree.querySelectorAll('[data-testid="browser-agent-click"]')) if (!seen.has(ring)) {
      seen.add(ring); const style = getComputedStyle(ring); add(rings, { documentToken: config.documentToken, rootIndex, connected: ring.isConnected, currentRoot: current === root.node, rect: box(ring),
        modelPoint: { x: parseFloat(ring.style.left), y: parseFloat(ring.style.top) }, color: style.borderTopColor, opacity: Number(style.opacity) });
    }
  };
  new MutationObserver(observe).observe(document, { childList: true, subtree: true }); observe();
  window.frameTargetFeedbackState = () => {
    const input = nodes.get("note"), current = document.getElementById("open-browser-use-cursor-root"), selected = roots.find(row => row.node === current), tree = selected?.tree;
    const cursor = tree?.querySelector('[data-testid="browser-agent-cursor"]'), target = tree?.querySelector('[data-testid="browser-agent-target"]'), transform = cursor?.style.transform.match(/^translate3d\(([-\d.]+)px,\s*([-\d.]+)px,/);
    return { business: { key: config.key, layout: config.layout, role: config.role, documentToken: config.documentToken, windowToken, href: location.href,
      sameDocument: document === originalDocument, sameWindow: window === originalWindow, nodes: [...nodes].map(([id, node]) => ({ id, token: node.dataset.token, connected: node.isConnected, original: node === document.getElementById(id) })),
      value: input?.value ?? null, activeElement: document.activeElement?.id ?? "", selection: input ? { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } : null,
      events: structuredClone(events), focus: structuredClone(focus), changes: structuredClone(changes), errors: [...errors], overflow, receipt },
      geometry: { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX, scrollY }, button: describe(nodes.get("submit")), proof: describe(nodes.get("proof")), frame: describe(nodes.get("frame")),
        markers: [...document.querySelectorAll("#proof i")].map(node => ({ id: node.id, ...box(node) })) }, rings: structuredClone(rings),
      feedback: { connected: !!selected?.node.isConnected, currentRoot: !!selected, currentCount: document.querySelectorAll('[id="open-browser-use-cursor-root"]').length, rootIndex: selected ? roots.indexOf(selected) : -1,
        cursor: box(cursor), target: target && getComputedStyle(target).display !== "none" ? box(target) : null,
        modelPoint: transform ? { x: Number(transform[1]) + parseFloat(cursor.style.width) / 2, y: Number(transform[2]) + parseFloat(cursor.style.height) / 2 } : null } };
  };
  for (const type of ["input", "click", "submit", "pointerdown", "pointerup", "keydown", "keyup"]) document.addEventListener(type, event => add(events, { type, targetId: event.target.id ?? "", nodeToken: event.target.dataset?.token ?? null, trusted: event.isTrusted,
    value: event.target.value ?? null, key: event.key ?? null, ...(["click", "pointerdown", "pointerup"].includes(type) ? { x: event.clientX, y: event.clientY } : {}) }), { capture: true, passive: true });
  for (const type of ["focusin", "focusout"]) document.addEventListener(type, event => add(focus, { type, targetId: event.target.id ?? "", trusted: event.isTrusted }), { capture: true, passive: true });
  nodes.get("add")?.addEventListener("click", event => {
    if (document.getElementById("frame")) { errors.push("Duplicate dynamic Add"); return; }
    const frame = document.createElement("iframe"); frame.id = "frame"; frame.dataset.token = `${config.key}-root-frame`; frame.title = "Original feedback form"; frame.src = config.childURL;
    document.body.appendChild(frame); remember(); add(changes, { type: "add-frame", trusted: event.isTrusted, documentToken: config.documentToken, sourceNode: event.target.dataset.token, childURL: frame.src });
  });
  nodes.get("form")?.addEventListener("submit", event => {
    event.preventDefault(); const body = { key: config.key, layout: config.layout, trustedSubmit: event.isTrusted, business: window.frameTargetFeedbackState().business };
    fetch(`/frame-target-feedback/post?key=${config.key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(response => { if (!response.ok) throw Error(`Receipt HTTP ${response.status}`); return response.json(); })
      .then(value => { receipt = value; document.getElementById("receipt").textContent = `Saved ${config.layout} ${value.bodySHA256}`; }).catch(error => errors.push(String(error)));
  });
}

export function frameTargetFeedbackHTML(url, documentToken) {
  const key = url.searchParams.get("key"), layout = url.searchParams.get("layout"), role = url.pathname.endsWith("/page") ? "root" : url.searchParams.get("role");
  const urls = frameTargetURLs(url, key, layout); assert.ok(["root", "leaf", ...(layout === "nested" ? ["middle"] : [])].includes(role));
  const f = frameTargetStyle(layout, role), childURL = role === "root" ? urls.middle ?? urls.leaf : urls.leaf, angle = layout === "rotated-oopif" ? -7 : 0;
  const token = id => `data-token="${key}-${role}-${id}"`, marker = (id, x, y) => `<i id="${id}" style="left:${x}px;top:${y}px"></i>`;
  const form = `<section id="panel" ${token("panel")}><form id="form" ${token("form")}><label for="note">Original note</label><input id="note" ${token("note")}><button id="submit" ${token("submit")}>Save</button></form><div id="proof" ${token("proof")} aria-hidden="true">${[["nw",0,0],["ne",280,0],["se",280,64],["sw",0,64]].map(args => marker(...args)).join("")}</div><output id="receipt"></output></section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Frame feedback ${layout} ${role}</title><style>
html,body{margin:0;background:#eee;color:#333;font:16px sans-serif}*{box-sizing:border-box}#panel{position:absolute;inset:0;background:#eee}label{position:absolute;left:46px;top:20px}input{position:absolute;left:46px;top:48px;width:280px;height:36px;background:#fafafa;border:1px solid #777}input:focus{outline:2px solid #555}#submit,#proof{position:absolute;left:46px;top:134px;width:280px;height:64px;padding:0;border:0;margin:0;transform:rotate(${angle}deg);transform-origin:27px 19px;zoom:1}#submit{background:#ddd;color:#333;text-align:left;padding-left:12px;font:16px sans-serif}#submit:focus{outline:1px solid #555}#proof{pointer-events:none;background:transparent}#proof i{position:absolute;width:0;height:0;border:0;padding:0;pointer-events:none}#receipt{position:absolute;left:46px;top:228px;font-size:12px}iframe{position:absolute;left:${f.left}px;top:${f.top}px;width:${f.width}px;height:${f.height}px;border:${f.border}px solid #888;box-sizing:content-box;padding:0;transform:rotate(${f.angle}deg) scale(${f.sx},${f.sy});transform-origin:${f.originX}px ${f.originY}px;zoom:1}#add{position:absolute;left:76px;top:20px;width:210px;height:32px;background:#ddd;color:#333;border:1px solid #777}
</style></head><body>${role === "leaf" ? form : layout === "dynamic-oopif" && role === "root" ? `<button id="add" ${token("add")}>Add original form</button>` : `<iframe id="frame" ${token("frame")} title="Original feedback form" src="${childURL}"></iframe>`}
<script>(${installFrameTargetDocument.toString()})(${JSON.stringify({ key, layout, role, documentToken, childURL })});</script></body></html>`;
}

export function createFrameTargetFeedbackFixtures() {
  const records = new Map();
  return { stats: key => structuredClone(records.get(key)), allStats: () => structuredClone([...records.values()]), handle(request, response, suppliedURL) {
    if (![`${route}page`, `${route}frame`, `${route}post`].includes(suppliedURL.pathname)) return false;
    const url = new URL(request.url, `http://${request.headers.host}`), key = url.searchParams.get("key");
    if (!keyPattern.test(key ?? "") || !["127.0.0.1", "localhost"].includes(url.hostname)) { response.writeHead(400); response.end("Invalid frame feedback request"); return true; }
    if (!records.has(key)) records.set(key, { key, gets: [], posts: [] }); const record = records.get(key);
    if (url.pathname !== `${route}post`) {
      try { assert.equal(request.method, "GET"); assert.ok(!record.gets.some(row => row.url === url.href), "Original document requested twice"); const documentToken = randomUUID(), html = frameTargetFeedbackHTML(url, documentToken), bytes = Buffer.from(html);
        record.gets.push({ url: url.href, documentToken, role: url.pathname.endsWith("/page") ? "root" : url.searchParams.get("role"), layout: url.searchParams.get("layout"), bytes: bytes.length, sha256: hash(bytes) });
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(bytes);
      } catch (error) { response.writeHead(400); response.end(String(error)); } return true;
    }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return true; }
    const post = { index: record.posts.length + 1, url: url.href, receivedAt: Date.now() }, chunks = []; let size = 0; record.posts.push(post);
    request.on("data", chunk => { size += chunk.length; if (size <= 128 * 1024) chunks.push(chunk); }); request.once("error", error => { post.error = String(error); }); request.once("aborted", () => { post.error = "Original POST aborted"; });
    request.once("end", () => { const bytes = Buffer.concat(chunks); Object.assign(post, { bodyBytes: size, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes) });
      try { assert.ok(size <= 128 * 1024); post.value = JSON.parse(bytes); const original = record.gets.find(row => row.role === "leaf"); assert.ok(original); assert.equal(post.index, 1); assert.equal(post.value.key, key); assert.equal(post.value.layout, original.layout); assert.equal(post.value.business.documentToken, original.documentToken); assert.equal(post.value.business.href, original.url); assert.equal(post.value.trustedSubmit, true);
        post.receipt = { key, layout: original.layout, index: post.index, bodySHA256: post.bodySHA256 }; response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(post.receipt));
      } catch (error) { post.error = errorText(error); response.writeHead(400); response.end("Invalid original frame receipt"); }
    }); return true;
  } };
}

// Independently authored affine plane: no product projection/boundingBox is read.
function project(point, f, viewport) { const a = f.angle * Math.PI / 180, x = (point.x + f.border - f.originX) * f.sx, y = (point.y + f.border - f.originY) * f.sy; return { x: f.left + f.originX + Math.cos(a) * x - Math.sin(a) * y - viewport.scrollX, y: f.top + f.originY + Math.sin(a) * x + Math.cos(a) * y - viewport.scrollY }; }
export function frameTargetRootPoint(point, documents, layout, sourceIndex = documents.length - 1) {
  let result = point; for (let index = sourceIndex - 1; index >= 0; index--) result = project(result, frameTargetStyle(layout, documents[index].business.role), documents[index].geometry.viewport); return result;
}
export function frameTargetGeometry(documents, layout) {
  for (const [i, document] of documents.entries()) {
    assert.equal(document.geometry.viewport.scrollX, 0); assert.equal(document.geometry.viewport.scrollY, 0);
    if (i === documents.length - 1) continue;
    const f = frameTargetStyle(layout, document.business.role), actual = document.geometry.frame; assert.equal(actual.connected, true);
    for (const name of ["left", "top", "width", "height"]) near(parseFloat(actual.styles[name]), f[name], `Authored iframe ${name}`, .001);
    for (const name of ["borderLeftWidth", "borderTopWidth", "borderRightWidth", "borderBottomWidth"]) near(parseFloat(actual.styles[name]), f.border, name, .001);
    assert.equal(actual.styles.boxSizing, "content-box"); assert.equal(actual.styles.zoom, "1"); assert.equal(actual.styles.paddingLeft, "0px"); assert.equal(actual.styles.paddingTop, "0px"); assert.equal(actual.styles.transformOrigin, `${f.originX}px ${f.originY}px`);
    const r = f.angle * Math.PI / 180, wanted = [Math.cos(r)*f.sx, Math.sin(r)*f.sx, -Math.sin(r)*f.sy, Math.cos(r)*f.sy, 0, 0], match = /^matrix\(([^)]+)\)$/.exec(actual.styles.transform); assert.ok(match); match[1].split(",").map(Number).forEach((value, n) => near(value, wanted[n], "Original iframe transform", .000005));
    const local = [[-f.border,-f.border],[f.width+f.border,-f.border],[f.width+f.border,f.height+f.border],[-f.border,f.height+f.border]].map(([x,y]) => project({x,y},f,document.geometry.viewport)); nearBox(actual.rect, bounds(local), "Original iframe border plane");
  }
  const leaf = documents.at(-1).geometry; assert.equal(leaf.button.connected, true); assert.equal(leaf.proof.connected, true); nearBox(leaf.button.rect, leaf.proof.rect, "Independent button proof plane");
  for (const name of ["left", "top", "width", "height", "transform", "transformOrigin", "zoom", "boxSizing"]) assert.equal(leaf.button.styles[name], leaf.proof.styles[name]);
  assert.equal(leaf.button.styles.width, "280px"); assert.equal(leaf.button.styles.height, "64px"); assert.deepEqual(leaf.markers.map(row => row.id), ["nw","ne","se","sw"]); assert.ok(leaf.markers.every(row => row.width === 0 && row.height === 0));
  nearBox(bounds(leaf.markers), leaf.button.rect, "Leaf border corners");
  const corners = leaf.markers.map(p => frameTargetRootPoint(p, documents, layout));
  const parents = documents.slice(0,-1).map((document,i) => { const f=frameTargetStyle(layout,document.business.role), points=[[-f.border,-f.border],[f.width+f.border,-f.border],[f.width+f.border,f.height+f.border],[-f.border,f.height+f.border]].map(([x,y]) => frameTargetRootPoint(project({x,y},f,document.geometry.viewport),documents,layout,i)); return bounds(points); });
  return { corners, button: bounds(corners), parents, viewport: documents[0].geometry.viewport };
}

export async function waitForFrameTargetFeedback(expected) {
  return new Promise((resolve,reject) => { let poll, done=false; const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(poll);error?reject(error):resolve(value);}; const timer=setTimeout(()=>finish(Error("Original frame feedback model did not arrive")),5000);
    const root=document.getElementById("open-browser-use-cursor-root"),tree=root?.shadowRoot??root;
    Promise.all([document.fonts.ready,...[...document.images,...(tree?.querySelectorAll("img")??[])].map(image=>image.decode())]).then(()=>{const check=()=>{if(done)return;try{const state=window.frameTargetFeedbackState(),point=state.feedback.modelPoint;if(point&&Math.abs(point.x-expected.x)<=1&&Math.abs(point.y-expected.y)<=1)return finish(null,state);poll=setTimeout(check,16);}catch(error){finish(error);}};check();},finish);
  });
}

export function measureFrameTargetPixels(bytes, geometry) {
  const png=decodeParallelPNG(bytes),sx=png.width/geometry.viewport.width,sy=png.height/geometry.viewport.height,button=geometry.button,c=center(button); near(sx,sy,"PNG scale",.01);near(sx,geometry.viewport.dpr,"PNG DPR",.02);
  assert.ok(button.width>100&&button.height>30&&button.x>4&&button.y>4&&button.x+button.width+4<geometry.viewport.width&&button.y+button.height+4<geometry.viewport.height);
  const edges={top:0,bottom:0,left:0,right:0},parentEdges=geometry.parents.map(()=>({top:0,bottom:0,left:0,right:0}));let cursorDark=0;
  const classify=(x,y,r,counts)=>{if(x>r.x+r.width*.2&&x<r.x+r.width*.8){if(Math.abs(y-r.y)<=3)counts.top++;if(Math.abs(y-r.y-r.height)<=3)counts.bottom++;}if(y>r.y+r.height*.2&&y<r.y+r.height*.8){if(Math.abs(x-r.x)<=3)counts.left++;if(Math.abs(x-r.x-r.width)<=3)counts.right++;}};
  for(let y=0;y<png.height;y++)for(let x=0;x<png.width;x++){const px=(x+.5)/sx,py=(y+.5)/sy,[r,g,b]=png.pixel(x,y);if(Math.abs(px-c.x)<=18&&Math.abs(py-c.y)<=18&&Math.max(r,g,b)<90)cursorDark++;if(b-r>=35&&b-g>=10){classify(px,py,button,edges);geometry.parents.forEach((rect,i)=>classify(px,py,rect,parentEdges[i]));}}
  return {width:png.width,height:png.height,bytes:bytes.length,sha256:hash(bytes),scale:sx,cursorDark,edges,parentEdges};
}

export function checkFrameTargetBusiness(item) {
  const roles=item.layout==="nested"?["root","middle","leaf"]:["root","leaf"],original=item.before;assert.deepEqual(original.map(d=>d.business.role),roles);assert.equal(item.server.posts.length,1);const post=item.server.posts[0],bytes=Buffer.from(post.bodyBase64,"base64");assert.equal(post.error,undefined);assert.equal(bytes.length,post.bodyBytes);assert.equal(hash(bytes),post.bodySHA256);assert.deepEqual(JSON.parse(bytes),post.value);
  for(const snapshot of [item.rendered,item.after])for(let i=0;i<roles.length;i++){const a=original[i],b=snapshot[i];assert.equal(b.nativeDocumentId,a.nativeDocumentId);assert.equal(b.nativeFrameId,a.nativeFrameId);assert.equal(b.nativeProcessId,a.nativeProcessId);for(const key of ["key","layout","role","documentToken","windowToken","href"])assert.equal(b.business[key],a.business[key]);assert.equal(b.business.sameDocument,true);assert.equal(b.business.sameWindow,true);assert.deepEqual(b.business.nodes,a.business.nodes);assert.ok(b.business.nodes.every(n=>n.original&&n.connected&&typeof n.token==="string"&&n.token));assert.equal(b.business.overflow,false);assert.deepEqual(b.business.errors,[]);assert.deepEqual(b.geometry,a.geometry);}
  for(let i=0;i<roles.length;i++){const before=original[i].business,rendered=item.rendered[i].business;assert.equal(rendered.activeElement,before.activeElement);assert.deepEqual(rendered.selection,before.selection);assert.deepEqual(rendered.focus,before.focus);assert.deepEqual(rendered.events,before.events);assert.equal(before.activeElement,i===roles.length-1?"note":"frame");const get=item.server.gets.find(row=>row.role===roles[i]);assert.equal(before.documentToken,get.documentToken);assert.equal(before.href,get.url);}
  const leaf=item.after.at(-1).business;assert.equal(leaf.value,item.value);assert.equal(post.value.trustedSubmit,true);assert.deepEqual({...post.value.business,receipt:post.receipt},leaf);assert.deepEqual(leaf.receipt,post.receipt);
  for(const [type,id]of[["input","note"],["pointerdown","submit"],["pointerup","submit"],["click","submit"],["submit","form"]]){const rows=leaf.events.filter(row=>row.type===type);assert.equal(rows.length,1,`Exactly one original ${type}`);assert.equal(rows[0].targetId,id);assert.equal(rows[0].trusted,true);assert.equal(rows[0].nodeToken,`${item.key}-leaf-${id}`);}
  for(const parent of item.after.slice(0,-1)){assert.equal(parent.business.events.filter(row=>row.type==="submit"||row.type==="input").length,0);const clicks=parent.business.events.filter(row=>row.type==="click");assert.equal(clicks.length,item.layout==="dynamic-oopif"&&parent.business.role==="root"?1:0);if(clicks.length){assert.equal(clicks[0].targetId,"add");assert.equal(clicks[0].trusted,true);assert.equal(parent.business.changes.length,1);assert.equal(parent.business.changes[0].trusted,true);}}
  const click=leaf.events.find(row=>row.type==="click"),rootClick=frameTargetRootPoint(click,item.after,item.layout);nearPoint(rootClick,center(item.geometry.button),"Original root click",1.1);item.rootClick=rootClick;
}

export function checkFrameTargetNative(item, bytes) {
  const probe=item.native;assert.equal(probe.restored,true);assert.equal(probe.pending,0);assert.equal(probe.overflow,false);assert.equal(probe.recordingErrors,0);assert.ok(probe.records.every((r,i)=>r.sequence===i+1));const calls=probe.records.filter(row=>row.kind==="invoke"),acks=new Map();
  for(const call of calls){const rows=probe.records.filter(row=>row.invocation===call.sequence);assert.equal(rows.length,1);assert.equal(rows[0].kind,"settled");assert.equal(rows[0].ok,true);assert.ok(rows[0].sequence>call.sequence);acks.set(call.sequence,rows[0]);}assert.equal(probe.records.filter(row=>row.kind==="settled").length,calls.length);
  const shots=calls.filter(row=>row.method==="Page.captureScreenshot");assert.equal(shots.length,1);assert.deepEqual(shots[0].source,{tabId:item.tabId});assert.deepEqual(Buffer.from(acks.get(shots[0].sequence).result.data,"base64"),bytes);const captureACK=acks.get(shots[0].sequence).sequence;
  const buttons=calls.filter(row=>row.sequence>captureACK&&row.method==="Input.dispatchMouseEvent"&&["mousePressed","mouseReleased"].includes(row.params.type));assert.deepEqual(buttons.map(row=>row.params.type),["mousePressed","mouseReleased"]);for(const call of buttons){assert.deepEqual(call.source,{tabId:item.tabId});assert.equal(call.params.button,"left");assert.equal(call.params.clickCount,1);nearPoint(call.params,item.rootClick,"Native original submit coordinate",1.1);}assert.ok(acks.get(buttons[0].sequence).sequence<buttons[1].sequence);
  return {captureInvocation:shots[0].sequence,captureACK,submitInvocations:buttons.map(row=>row.sequence),submitACKs:buttons.map(row=>acks.get(row.sequence).sequence)};
}

export function checkFrameTargetVisible(item) {
  const root=item.rendered[0],feedback=root.feedback;assert.equal(feedback.connected,true);assert.equal(feedback.currentRoot,true);assert.equal(feedback.currentCount,1);nearBox(feedback.target,item.geometry.button,"Original leaf button outline",1);nearPoint(center(feedback.cursor),center(item.geometry.button),"Visible root cursor",1);
  assert.ok(item.pixels.cursorDark>=8*item.pixels.scale**2,"Original cursor pixels missing");for(const [side,count]of Object.entries(item.pixels.edges))assert.ok(count>=4*item.pixels.scale**2,`Original leaf ${side} outline pixels missing`);for(const edges of item.pixels.parentEdges)for(const count of Object.values(edges))assert.equal(count,0,"Ancestor iframe outline remains visible");
  assert.deepEqual(item.after[0].rings.slice(0,root.rings.length),root.rings);const rings=item.after[0].rings.slice(root.rings.length);assert.equal(rings.length,1,"Exactly one new original submit ring");const ring=rings[0];assert.equal(ring.sequence,root.rings.length+1);assert.equal(ring.documentToken,root.business.documentToken);assert.equal(ring.rootIndex,feedback.rootIndex);assert.equal(ring.connected,true);assert.equal(ring.currentRoot,true);nearPoint(ring.modelPoint,item.rootClick,"Original ring association",1.1);nearPoint(center(ring.rect),item.rootClick,"Actual ring center",1.1);assert.equal(ring.color,"rgb(20, 184, 166)");assert.ok(ring.opacity>0);item.submitRing=ring;
}

export function selectFrameTargetDocuments(frames,urls,layout) {
  const selected=[];let parent=-1;for(const url of [urls.root,urls.middle,urls.leaf].filter(Boolean)){const matches=frames.filter(row=>row.url===url&&row.parentFrameId===parent&&row.documentLifecycle==="active"&&!row.errorOccurred&&typeof row.documentId==="string"&&row.documentId);if(matches.length!==1)return null;selected.push(matches[0]);parent=matches[0].frameId;}
  assert.equal(selected[0].frameId,0);assert.equal(new Set(selected.map(row=>row.documentId)).size,selected.length);if(layout==="same")assert.equal(selected[0].processId,selected[1].processId);else assert.notEqual(selected[0].processId,selected[1].processId,"Actual first OOPIF required");if(layout==="nested")assert.notEqual(selected[1].processId,selected[2].processId,"Actual nested OOPIF required");return selected;
}
async function readDocuments(worker,tabId,frames) {
  const rows=await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId},documentIds:${JSON.stringify(frames.map(row=>row.documentId))}},world:'MAIN',func:()=>window.frameTargetFeedbackState?.()??null})`);
  return frames.map(frame=>{const matches=rows.filter(row=>row.frameId===frame.frameId&&row.documentId===frame.documentId);assert.equal(matches.length,1);assert.ok(matches[0].result);assert.equal(matches[0].result.business.href,frame.url);return {...matches[0].result,nativeFrameId:frame.frameId,nativeDocumentId:frame.documentId,nativeProcessId:frame.processId};});
}

export async function checkFrameTargetFeedback({browser,getWorker,fixtureURL,fixtures,until,saveArtifact,saveDetail,checkEnd,closeTab=tab=>tab.close()}) {
  const detail={states:[],tabIds:[],childTargetIds:[],cleanup:[],boundary:"Original trusted frame form submissions and native PNG bytes; independently authored CSS border-corner planes determine root AABB. Ring rectangles are passive transient evidence, not ring PNG proof. No input replay or focus allowance."},tabs=[];let failure;
  try {
    for(const layout of frameTargetLayouts){const key=`frame-feedback-${randomUUID().replaceAll("-","")}`,urls=frameTargetURLs(fixtureURL,key,layout),item={key,layout,urls,value:`Original ${layout} π note`};detail.states.push(item);const tab=await browser.newTab({url:urls.root});tabs.push(tab);item.tabId=tab.id;detail.tabIds.push(tab.id);const worker=getWorker();let installed=false,bytes;
      try {await worker.evaluate(`(${installBoundingGeometryProbe.toString()})(chrome,globalThis,${JSON.stringify({id:key,tabId:tab.id})})`);installed=true;
        if(layout==="dynamic-oopif"){item.initialFrames=await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`);assert.equal(item.initialFrames.filter(row=>row.url===urls.leaf).length,0);await tab.locator("#add").click();}
        let leaf=tab.frameLocator("#frame");if(layout==="nested")leaf=leaf.frameLocator("#frame");await leaf.locator("#note").waitFor({state:"visible",timeoutMs:5000});
        await until(async()=>{const frames=await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`),selected=selectFrameTargetDocuments(frames,urls,layout);if(!selected)return false;item.frames=selected;return true;},"original feedback documents committed",5000);
        await leaf.locator("#note").fill(item.value);item.before=await readDocuments(worker,tab.id,item.frames);item.geometry=frameTargetGeometry(item.before,layout);
        await leaf.locator("#submit").hover();item.arrival=await tab.evaluate(`(${waitForFrameTargetFeedback.toString()})(${JSON.stringify(center(item.geometry.button))})`,{awaitPromise:true});
        const shot=await tab.screenshot();assert.equal(shot.mimeType,"image/png");bytes=Buffer.from(shot.base64,"base64");item.artifact=`frame-target-${layout}.png`;await saveArtifact(item.artifact,bytes);item.rendered=await readDocuments(worker,tab.id,item.frames);
        await leaf.locator("#submit").click();await leaf.getByText(`Saved ${layout}`,{exact:false}).waitFor({timeoutMs:5000});item.after=await readDocuments(worker,tab.id,item.frames);item.server=fixtures.stats(key);item.pixels=measureFrameTargetPixels(bytes,item.geometry);
      }catch(error){item.error=errorText(error);failure??=error;}
      finally {if(installed)try{item.native=await worker.evaluate(`(()=>{const probe=globalThis.__obuBoundingGeometry;if(probe?.id!==${JSON.stringify(key)})throw Error('Original frame observer changed');return probe.restore()})()`);}catch(error){item.nativeError=errorText(error);failure??=error;}
        try{item.inventory=await worker.evaluate(`(async()=>({frames:await chrome.webNavigation.getAllFrames({tabId:${tab.id}}),targets:await chrome.debugger.getTargets(),attachments:globalThis.__integrationFrames.filter(row=>row.tabId===${tab.id})}))()`);const targets=item.inventory.targets.filter(row=>item.inventory.attachments.some(a=>a.targetId===row.id));item.childTargetIds=targets.map(row=>row.id);detail.childTargetIds.push(...item.childTargetIds);
          if(item.frames){const current=selectFrameTargetDocuments(item.inventory.frames,urls,layout);assert.ok(current);assert.deepEqual(current.map(row=>[row.frameId,row.documentId,row.processId]),item.frames.map(row=>[row.frameId,row.documentId,row.processId]));for(let i=1;i<item.frames.length;i++)if(item.frames[i].processId!==item.frames[i-1].processId){const matches=targets.filter(row=>row.url===item.frames[i].url);assert.equal(matches.length,1,"Original OOPIF target required");const attachments=item.inventory.attachments.filter(row=>row.targetId===matches[0].id);assert.equal(attachments.length,1);assert.equal(attachments[0].type,"iframe");assert.ok(attachments[0].sessionId);}}
        }catch(error){item.identityError=errorText(error);failure??=error;}}
      if(item.after&&bytes)for(const [name,check]of[["business",()=>checkFrameTargetBusiness(item)],["native",()=>{item.nativeProof=checkFrameTargetNative(item,bytes);}],["visible",()=>checkFrameTargetVisible(item)]])try{check();item[`${name}Passed`]=true;}catch(error){item[`${name}Passed`]=false;item[`${name}Error`]=errorText(error);failure??=error;}
      if(item.error)break;
    }
    // A visual red must retain normal end/hide evidence after every original
    // PNG and business transaction, without reopening the SDK turn afterward.
    if(detail.states.length===frameTargetLayouts.length&&detail.states.every(item=>item.after&&item.artifact)&&checkEnd)try{detail.end=await checkEnd(detail);}catch(error){detail.endError=errorText(error);failure??=error;}
  }catch(error){failure??=error;}
  finally {try{detail.serverLedger=fixtures.allStats();}catch(error){detail.serverLedgerError=errorText(error);failure??=error;}
    for(const tab of tabs)try{await closeTab(tab);detail.cleanup.push({tabId:tab.id,closed:true});}catch(error){detail.cleanup.push({tabId:tab.id,error:errorText(error)});failure??=error;}
    try{detail.cleanupInventory=await getWorker().evaluate(`(async()=>({tabs:(await chrome.tabs.query({})).filter(row=>${JSON.stringify(detail.tabIds)}.includes(row.id)),targets:(await chrome.debugger.getTargets()).filter(row=>${JSON.stringify(detail.tabIds)}.includes(row.tabId)||${JSON.stringify(detail.childTargetIds)}.includes(row.id))}))()`);assert.deepEqual(detail.cleanupInventory,{tabs:[],targets:[]});}catch(error){detail.cleanupError=errorText(error);failure??=error;}
    if(failure)detail.error=errorText(failure);try{await saveDetail(detail);}catch(error){failure??=error;}}
  if(failure)throw failure;return detail;
}
