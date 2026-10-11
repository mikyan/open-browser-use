import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export const FORM_WORKFLOW_VERSION = 1;
const bodyLimit = 128 * 1024;
const html = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const json = value => JSON.stringify(value).replace(/</g, "\\u003c");

export function expectedFormWorkflow(variant = 1) {
  if (![1, 2, 3].includes(variant)) throw new Error("Unknown form workflow variant");
  return { recipientName: "林晓🧪", recipientEmail: "lin@example.test", billingName: "保留此值", kit: "research",
    delivery: "pickup", materials: ["manual", "sticker"], voucher: "digital", subscribe: false, terms: true,
    greeting: "谢谢，团队 🚀", recipientConfirmed: true, department: "研发二组", preference: "周三上午" };
}

export function formWorkflowTask(variant = 1) {
  expectedFormWorkflow(variant);
  return "完成这份本地模拟领用单（不涉及付款）。选择可用且未停用的研发套装。只修改收件信息：姓名“林晓🧪”（填好后按 End 键将光标移到末尾）、邮箱“lin@example.test”，并点该组的“确认”；账单姓名“保留此值”不能改。配送选“自提”，附加材料只选“手册”和“贴纸”，凭证选“电子凭证”；取消订阅，接受条款。赠言填写“谢谢，团队 🚀”。在“部门设置”框架中将备注填为“研发二组”并确认；在“配送偏好”框架中将备注填为“周三上午”并确认。提交按钮可用后，只提交一次模拟申请。最后读取收据中的准确提交 JSON，并打开服务端证据链接核对两次框架保存与一次最终提交。";
}

const role = (name, accessibleName) => ({ kind: "role", role: name, ...(accessibleName === undefined ? {} : { name: accessibleName, exact: true }) });
const label = value => ({ kind: "label", value, exact: true });
const css = selector => ({ kind: "css", selector });

// This finite specification is also consumed by CLI/MCP and the other SDK checkers.
// The JS driver below reconstructs public Locator calls, never writes DOM or POSTs itself.
export function formWorkflowSteps(variant = 1) {
  const values = expectedFormWorkflow(variant);
  const recipient = [role("group", "收件信息")];
  const kitHeading = [css("h3"), { kind: "filter", hasText: "研发套装" }];
  const kit = [css("li"), { kind: "filter", has: kitHeading,
    hasNot: [{ kind: "text", value: "停用", exact: true }], visible: true }, { kind: "and", locator: [css('[data-available="true"]')] }];
  const submit = [role("button", "提交模拟申请"), { kind: "or", locator: [role("button", "发送模拟申请")] }, { kind: "filter", visible: true }];
  const step = (id, action, locator, args = {}, expected) => ({ id, action, locator, args, ...(expected === undefined ? {} : { expected }) });
  const output = [
    step("ambiguous-kit-count", "count", [css("li"), { kind: "filter", has: kitHeading }], {}, 3),
    step("composed-kit-count", "count", kit, {}, 1),
    step("choose-kit", "click", [...kit, role("button", "选用")]),
    step("recipient-name", "fill", [...recipient, label("姓名")], { value: values.recipientName }),
    step("recipient-key", "press", [...recipient, label("姓名")], { key: "End" }),
    step("recipient-email", "fill", [...recipient, label("邮箱")], { value: values.recipientEmail }),
    step("recipient-confirm", "click", [...recipient, role("button", "确认")]),
    step("billing-unchanged", "inputValue", [role("group", "账单信息"), label("姓名")], {}, values.billingName),
    // String "自提" is a label, not the value "pickup".
    step("delivery-label-string", "selectOption", [role("combobox", "配送方式")], { values: "自提" }, ["pickup"]),
    step("materials-mixed", "selectOption", [role("listbox", "附加材料")], { values: ["手册", { index: 2 }] }, ["manual", "sticker"]),
    step("materials-descriptors", "selectOption", [role("listbox", "附加材料")], { values: [{ value: "manual", label: "手册" }, { label: "贴纸", index: 2 }] }, ["manual", "sticker"]),
    step("digital-voucher", "check", [role("radio", "电子凭证")]),
    step("unsubscribe", "uncheck", [role("checkbox", "订阅通知")]),
    step("unsubscribe-idempotent", "uncheck", [role("checkbox", "订阅通知")]),
    step("accept-terms", "check", [role("checkbox", "接受模拟条款")]),
    step("accept-terms-idempotent", "check", [role("checkbox", "接受模拟条款")]),
    step("shadow-greeting", "fill", [label("赠言")], { value: values.greeting }),
  ];
  for (const [scope, title, value] of [["same", "部门设置", values.department], ["cross", "配送偏好", values.preference]]) {
    const frame = { kind: "frame", selector: `iframe[title="${title}"]` };
    output.push(step(`${scope}-note`, "fill", [frame, label("备注"), { kind: "and", locator: [frame, css('input[data-field="note"]')] }], { value }));
    output.push(step(`${scope}-confirm`, "click", [frame, role("button", "确认")]));
    output.push(step(`${scope}-saved`, "waitFor", [frame, role("status"), { kind: "filter", hasText: "已保存" }], { state: "visible" }));
  }
  output.push(step("submit-once", "click", submit));
  return output;
}

function shell(title, body) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${html(title)}</title>
  <style>body{font:16px system-ui,sans-serif;max-width:920px;margin:24px auto;padding:0 20px;color:#162c3c;background:#f8fafc}fieldset,section{margin:14px 0;padding:16px;border:1px solid #b6c8d6;border-radius:8px;background:white}label{display:block;margin:10px 0}input,select,button,textarea{font:inherit;padding:7px}button{cursor:pointer;margin:5px}li{padding:10px;border-bottom:1px solid #ddd}iframe{width:100%;height:230px;border:1px solid #b6c8d6}pre{white-space:pre-wrap;overflow-wrap:anywhere}output{display:block}[hidden]{display:none!important}</style>${body}</html>`;
}

const eventScript = `const evidence=[];
for(const type of ['pointerdown','click','keydown','input','change'])document.addEventListener(type,event=>{
  const target=event.composedPath()[0];if(!target?.id||evidence.length>=256)return;
  evidence.push({sequence:evidence.length,type,trusted:event.isTrusted,id:target.id,
    value:target instanceof HTMLSelectElement?Array.from(target.selectedOptions,option=>option.value):
      target.type==='checkbox'||target.type==='radio'?target.checked:String(target.value??'').slice(0,160),
    ...(type==='keydown'?{key:event.key}: {})});
},true);`;

function rootHTML(record, port) {
  const base = `/form-task/${record.key}`, v = record.variant;
  const recipient = '<fieldset><legend>收件信息</legend><label>姓名 <input id="recipient-name" autocomplete="off"></label><label>邮箱 <input id="recipient-email" type="email" autocomplete="off"></label><button id="recipient-confirm" type="button">确认</button><output id="recipient-status" aria-live="polite">待确认</output></fieldset>';
  const billing = '<fieldset><legend>账单信息</legend><label>姓名 <input id="billing-name" value="保留此值" autocomplete="off"></label><button id="billing-confirm" type="button">确认</button></fieldset>';
  const cards = [
    '<li data-available="true"><h3>研发套装</h3><p>可用 · 手册和贴纸可选</p><button id="choose-research" type="button" data-kit="research">选用</button></li>',
    '<li data-available="false"><h3>研发套装</h3><p>停用</p><button id="choose-retired" type="button" data-kit="retired">选用</button></li>',
    '<li hidden data-available="true"><h3>研发套装</h3><p>预览副本</p><button id="choose-hidden" type="button" data-kit="hidden">选用</button></li>'
  ];
  const ordered = v === 1 ? cards : v === 2 ? [cards[1], cards[2], cards[0]] : [cards[2], cards[0], cards[1]];
  const finalLabel = v === 2 ? "发送模拟申请" : "提交模拟申请";
  const alternate = v === 2 ? "提交模拟申请" : "发送模拟申请";
  return shell("模拟领用申请", `<h1>团队物资领用 · 模拟任务</h1><p id="task">${html(formWorkflowTask(v))}</p>
  <p>版本 ${FORM_WORKFLOW_VERSION} · 变体 ${v} · 任务 ${html(record.key)}</p><form id="request-form">
  <section aria-label="物资套装"><h2>可选套装</h2><ul>${ordered.join("")}</ul><output id="kit-status">尚未选择</output></section>
  ${v === 3 ? billing + recipient : recipient + billing}
  <fieldset><legend>领用选项</legend><label>配送方式 <select id="delivery"><option value="courier">快递</option><option value="pickup">自提</option></select></label>
  <label>附加材料 <select id="materials" multiple size="3"><option value="none">无附加材料</option><option value="manual">手册</option><option value="sticker">贴纸</option></select></label>
  <label><input id="voucher-paper" type="radio" name="voucher" value="paper" checked>纸质凭证</label><label><input id="voucher-digital" type="radio" name="voucher" value="digital">电子凭证</label>
  <label><input id="subscribe" type="checkbox" checked>订阅通知</label><label><input id="terms" type="checkbox">接受模拟条款</label><div id="gift-host"></div></fieldset>
  <section><h2>独立设置</h2><iframe id="same-frame" title="部门设置" src="${base}/frame/same"></iframe>
  <iframe id="cross-frame" title="配送偏好" src="http://localhost:${port}${base}/frame/cross"></iframe></section>
  <p id="submit-status" role="status">请完成所有信息与两份设置</p><button id="submit-request" disabled>${finalLabel}</button><button hidden type="button">${alternate}</button></form>
  <p><a href="${base}/evidence">查看服务端证据</a></p><script>
  const base=${json(base)},nonce=${json(record.nonce)},variant=${v},expected=${json(expectedFormWorkflow(v))};${eventScript}
  const get=id=>document.getElementById(id),nativeFetch=fetch.bind(globalThis);
  const shadow=get('gift-host').attachShadow({mode:'open'});shadow.innerHTML='<label>赠言 <textarea id="greeting"></textarea></label>';
  let kit='',confirmed=false,readyRevision=0;
  function values(){return {recipientName:get('recipient-name').value,recipientEmail:get('recipient-email').value,billingName:get('billing-name').value,kit,
    delivery:get('delivery').value,materials:Array.from(get('materials').selectedOptions,option=>option.value),voucher:document.querySelector('input[name=voucher]:checked').value,
    subscribe:get('subscribe').checked,terms:get('terms').checked,greeting:shadow.getElementById('greeting').value,recipientConfirmed:confirmed};}
  function valid(){const data=values();return Object.keys(data).every(key=>JSON.stringify(data[key])===JSON.stringify(expected[key]));}
  async function refresh(){const revision=++readyRevision;get('submit-request').disabled=true;if(!valid())return;
    try{const response=await nativeFetch(base+'/ready'),state=await response.json();if(revision===readyRevision&&valid()&&state.ready){get('submit-request').disabled=false;get('submit-status').textContent='所有信息已通过，可以提交';}}
    catch{get('submit-status').textContent='状态检查失败，请重新确认';}}
  document.querySelectorAll('[data-kit]').forEach(button=>button.addEventListener('click',()=>{kit=button.dataset.kit;get('kit-status').textContent=kit==='research'?'已选择研发套装':'选择无效';refresh();}));
  get('recipient-confirm').addEventListener('click',()=>{confirmed=get('recipient-name').value===expected.recipientName&&get('recipient-email').value===expected.recipientEmail;get('recipient-status').textContent=confirmed?'已确认':'请检查收件信息';refresh();});
  get('billing-confirm').addEventListener('click',()=>{get('billing-confirm').textContent='账单已变更';});
  document.addEventListener('input',event=>{if(['recipient-name','recipient-email'].includes(event.composedPath()[0]?.id))confirmed=false;refresh();});
  document.addEventListener('change',refresh);
  addEventListener('message',event=>{const same=get('same-frame'),cross=get('cross-frame');if(event.data?.tag!=='form-saved'||event.data?.nonce!==nonce)return;
    if(event.source===same.contentWindow&&event.origin===location.origin||event.source===cross.contentWindow&&event.origin===${json(`http://localhost:${port}`)})refresh();});
  get('request-form').addEventListener('submit',async event=>{event.preventDefault();if(get('submit-request').disabled)return;get('submit-request').disabled=true;
    try{const response=await nativeFetch(base+'/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce,variant,values:values(),events:evidence})});
    const data=await response.json();if(!response.ok)throw Error(data.error);location.assign(data.receiptURL);}catch(error){get('submit-status').textContent='提交失败: '+error.message;}});
  </script>`);
}

function frameHTML(record, scope, port) {
  const title = scope === "same" ? "部门设置" : "配送偏好", base = `/form-task/${record.key}`;
  return shell(title, `<h2>${title}</h2><form><label>备注 <input id="note" data-field="note" autocomplete="off"></label><button id="confirm">确认</button><output id="save-status" role="status">尚未保存</output></form><script>
  const nonce=${json(record.nonce)},scope=${json(scope)},base=${json(base)};${eventScript}
  document.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();const status=document.getElementById('save-status');
    try{const response=await fetch(base+'/save/'+scope,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce,note:document.getElementById('note').value,events:evidence})});
    const data=await response.json();if(!response.ok)throw Error(data.error);status.textContent='已保存';parent.postMessage({tag:'form-saved',nonce},${json(`http://127.0.0.1:${port}`)});}
    catch(error){status.textContent='保存失败: '+error.message;}});</script>`);
}

function sameKeys(value, keys) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|"); }
function validEvents(value) {
  return Array.isArray(value) && value.length <= 256 && value.every((event, index) =>
    event !== null && typeof event === "object" && sameKeys(event, event.type === "keydown" ? ["sequence", "type", "trusted", "id", "value", "key"] : ["sequence", "type", "trusted", "id", "value"]) &&
    event.sequence === index && ["pointerdown", "click", "keydown", "input", "change"].includes(event.type) && typeof event.trusted === "boolean" &&
    typeof event.id === "string" && event.id.length <= 80 && (typeof event.value === "boolean" || typeof event.value === "string" && event.value.length <= 160 ||
      Array.isArray(event.value) && event.value.length <= 3 && event.value.every(item => typeof item === "string" && item.length <= 160)) &&
    (event.type !== "keydown" || typeof event.key === "string" && event.key.length <= 80));
}

export function createFormWorkflowFixture({ onChange } = {}) {
  const records = new Map();
  const snapshot = key => records.has(key) ? structuredClone(records.get(key)) : null;
  const notify = record => { if (onChange) onChange(snapshot(record.key)); };
  const reply = (response, status, value) => { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value)); };
  return {
    stats: snapshot,
    allStats: () => [...records.keys()].map(snapshot),
    handle(request, response, port) {
      const url = new URL(request.url, "http://localhost");
      if (!url.pathname.startsWith("/form-task/")) return false;
      response.setHeader("Cache-Control", "no-store");
      const matched = /^\/form-task\/([A-Za-z0-9_-]{1,80})(?:\/(frame\/(?:same|cross)|save\/(?:same|cross)|submit|ready|receipt|evidence))?$/.exec(url.pathname);
      if (!matched) { reply(response, 404, { error: "Unknown synthetic form route" }); return true; }
      const [, key, route = ""] = matched;
      let record = records.get(key);
      if (!record && route === "" && request.method === "GET") {
        const variant = Number(url.searchParams.get("variant") ?? 1);
        if (![1, 2, 3].includes(variant) || records.size >= 128) { reply(response, 400, { error: "Invalid variant or fixture capacity reached" }); return true; }
        record = { version: FORM_WORKFLOW_VERSION, key, variant, nonce: randomUUID(), requests: [], posts: [], saved: {}, submitAttempts: 0, acceptedSubmissions: 0, duplicateSubmissions: 0, receipt: null };
        records.set(key, record);
      }
      if (!record) { reply(response, 404, { error: "Unknown task" }); return true; }
      const sequence = record.requests.length;
      record.requests.push({ sequence, method: request.method, route, variant: record.variant, key,
        userAgent: String(request.headers["user-agent"] ?? "").slice(0,256), host: String(request.headers.host ?? "").slice(0,128) });
      notify(record);
      if (request.method === "GET") {
        if (route === "ready") { reply(response, 200, { ready: Boolean(record.saved.same && record.saved.cross) }); return true; }
        if (!["", "frame/same", "frame/cross", "receipt", "evidence"].includes(route)) { reply(response, 405, { error: "POST required" }); return true; }
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        if (route === "") response.end(rootHTML(record, port));
        else if (route.startsWith("frame/")) response.end(frameHTML(record, route.slice(6), port));
        else if (route === "receipt" && !record.receipt) { response.statusCode = 409; response.end(shell("尚未提交", "<h1>尚无有效收据</h1>")); }
        else if (route === "receipt") response.end(shell("模拟申请收据", `<h1>模拟申请已提交</h1><pre id="receipt-json">${html(JSON.stringify(record.receipt, null, 2))}</pre><a href="/form-task/${key}/evidence">查看服务端证据</a>`));
        else response.end(shell("服务端证据", `<h1>服务端接收记录</h1><p>原始 POST 与规范化提交来自此本地 HTTP 服务端。事件字段是页面观察结果，非服务端伪造的浏览器信任证明。</p><pre id="evidence-json">${html(JSON.stringify(snapshot(key), null, 2))}</pre>`));
        return true;
      }
      if (request.method !== "POST" || !["save/same", "save/cross", "submit"].includes(route)) { reply(response, 405, { error: "Unsupported method" }); return true; }
      let bytes = 0, oversized = false; const chunks = [];
      request.on("data", chunk => { bytes += chunk.length; if (bytes > bodyLimit) { oversized = true; chunks.length = 0; } else if (!oversized) chunks.push(chunk); });
      request.on("end", () => {
        const post = { sequence, route, bytes, raw: oversized ? null : Buffer.concat(chunks).toString("utf8"), accepted: false };
        record.posts.push(post);
        if (route === "submit") record.submitAttempts++;
        const reject = (status, message) => { post.error = message; notify(record); reply(response, status, { error: message }); };
        if (oversized) return reject(413, "Body exceeds fixture limit");
        let data; try { data = JSON.parse(post.raw); } catch { return reject(400, "Malformed JSON"); }
        if (!data || data.nonce !== record.nonce || !validEvents(data.events)) return reject(400, "Invalid task nonce or event evidence");
        const expected = expectedFormWorkflow(record.variant);
        if (route.startsWith("save/")) {
          const scope = route.slice(5), value = scope === "same" ? expected.department : expected.preference;
          if (!sameKeys(data, ["nonce", "note", "events"]) || data.note !== value) return reject(422, "Frame value failed validation");
          if (record.saved[scope]) return reject(409, "Frame was already saved");
          record.saved[scope] = { sequence, note: data.note, events: data.events }; post.accepted = true; notify(record); return reply(response, 200, { saved: scope });
        }
        if (record.receipt) { record.duplicateSubmissions++; return reject(409, "Application was already submitted"); }
        const { department, preference, ...rootExpected } = expected;
        if (!sameKeys(data, ["nonce", "variant", "values", "events"]) || data.variant !== record.variant || !sameKeys(data.values, Object.keys(rootExpected)) ||
          Object.keys(rootExpected).some(name => JSON.stringify(data.values[name]) !== JSON.stringify(rootExpected[name])) || !record.saved.same || !record.saved.cross) return reject(422, "Application failed authoritative validation");
        record.acceptedSubmissions++; post.accepted = true;
        record.receipt = { version: FORM_WORKFLOW_VERSION, key, variant: record.variant, nonce: record.nonce, receiptId: `SIM-${key}`,
          submitted: { ...data.values, department: record.saved.same.note, preference: record.saved.cross.note },
          frameSaveSequences: [record.saved.same.sequence, record.saved.cross.sequence], submitSequence: sequence };
        notify(record); reply(response, 201, { receiptURL: `/form-task/${key}/receipt`, receiptId: record.receipt.receiptId });
      });
      request.on("error", () => { if (!response.writableEnded) reply(response, 400, { error: "Request interrupted" }); });
      return true;
    }
  };
}

export function checkFormReceipt(receipt, ledger, variant = 1) {
  assert.equal(receipt.version, FORM_WORKFLOW_VERSION); assert.equal(receipt.variant, variant);
  assert.deepEqual(receipt.submitted, expectedFormWorkflow(variant)); assert.deepEqual(receipt, ledger.receipt);
  assert.equal(ledger.submitAttempts, 1); assert.equal(ledger.acceptedSubmissions, 1); assert.equal(ledger.duplicateSubmissions, 0);
  assert.equal(ledger.posts.length, 3); assert.ok(ledger.posts.every(post => post.accepted));
  assert.ok(receipt.frameSaveSequences.every(sequence => sequence < receipt.submitSequence));
  const root = JSON.parse(ledger.posts.find(post => post.route === "submit").raw).events;
  const clicks = (events, id) => events.filter(event => event.type === "click" && event.id === id);
  for (const id of ["choose-research", "recipient-confirm", "voucher-digital", "subscribe", "terms", "submit-request"]) {
    assert.equal(clicks(root, id).length, 1, `Exactly one ${id} click, including idempotent checks`);
    assert.ok(clicks(root, id)[0].trusted, `${id} has a real trusted click`);
    assert.ok(root.some(event => event.id === id && event.type === "pointerdown" && event.trusted), `${id} has a trusted pointerdown`);
  }
  assert.ok(root.some(event => event.id === "recipient-name" && event.type === "keydown" && event.key === "End" && event.trusted));
  assert.ok(!root.some(event => ["billing-name", "billing-confirm", "choose-retired", "choose-hidden"].includes(event.id)), "Unrelated fields/cards remain untouched");
  for (const id of ["delivery", "materials"]) assert.ok(root.some(event => event.id === id && event.type === "change"), `Selection ${id} emitted change; trust is intentionally not required`);
  for (const scope of ["same", "cross"]) {
    assert.equal(clicks(ledger.saved[scope].events, "confirm").length, 1);
    assert.ok(clicks(ledger.saved[scope].events, "confirm")[0].trusted);
  }
  return { receipt, requestSequence: ledger.requests.map(item => ({ sequence: item.sequence, method: item.method, route: item.route })), rootEvents: root, frameEvents: { same: ledger.saved.same.events, cross: ledger.saved.cross.events } };
}

function publicLocator(tab, steps) {
  let locator = tab.playwright;
  for (const step of steps) {
    if (step.kind === "role") locator = locator.getByRole(step.role, { name: step.name, exact: step.exact });
    else if (step.kind === "label") locator = locator.getByLabel(step.value, { exact: step.exact });
    else if (step.kind === "text") locator = locator.getByText(step.value, { exact: step.exact });
    else if (step.kind === "css") locator = locator.locator(step.selector);
    else if (step.kind === "frame") locator = locator.frameLocator(step.selector);
    else if (step.kind === "filter") locator = locator.filter({ ...("hasText" in step ? { hasText: step.hasText } : {}),
      ...("visible" in step ? { visible: step.visible } : {}), ...(step.has ? { has: publicLocator(tab, step.has) } : {}), ...(step.hasNot ? { hasNot: publicLocator(tab, step.hasNot) } : {}) });
    else if (step.kind === "and" || step.kind === "or") locator = locator[step.kind](publicLocator(tab, step.locator));
    else throw new Error("Unknown synthetic workflow locator step");
  }
  return locator;
}

export async function checkFormWorkflow({ browser, fixtureURL, server, variant = 1, key: requestedKey, onReceipt }) {
  const startedAt = performance.now(), trace = [], url = new URL(fixtureURL); url.searchParams.set("variant", String(variant));
  if (requestedKey !== undefined) { assert.match(requestedKey, /^[A-Za-z0-9_-]{1,80}$/); url.pathname = `/form-task/${requestedKey}`; }
  const key = url.pathname.split("/").at(-1); let tab, navigation, detail, primary;
  try {
    tab = await browser.newTab({ url: url.href });
    for (const step of formWorkflowSteps(variant)) {
      if (step.id === "submit-once") navigation = await tab.expectURL(new URL(`/form-task/${key}/receipt`, url).href, { timeoutMs: 10000 });
      const locator = publicLocator(tab, step.locator), at = performance.now();
      const args = step.action === "fill" ? [step.args.value] : step.action === "press" ? [step.args.key] : step.action === "selectOption" ? [step.args.values] : step.action === "waitFor" ? [step.args] : [];
      const result = await locator[step.action](...args);
      trace.push({ id: step.id, action: step.action, elapsedMs: performance.now() - at, ...(result === undefined ? {} : { result }) });
      if ("expected" in step) assert.deepEqual(result, step.expected, step.id);
    }
    await navigation.result(); navigation = null;
    const receipt = JSON.parse(await tab.locator("#receipt-json").innerText());
    const ledger = server.stats(key); detail = { key, variant, task: formWorkflowTask(variant), trace, ...checkFormReceipt(receipt, ledger, variant), ledger, elapsedMs: performance.now() - startedAt };
    if (onReceipt) await onReceipt(tab, detail);
    await tab.getByRole("link", { name: "查看服务端证据", exact: true }).click();
    const visibleLedger = JSON.parse(await tab.locator("#evidence-json").innerText());
    assert.deepEqual(visibleLedger.receipt, receipt); assert.equal(visibleLedger.acceptedSubmissions, 1);
    detail.visibleEvidence = { receiptId: visibleLedger.receipt.receiptId, acceptedSubmissions: visibleLedger.acceptedSubmissions };
  } catch (error) { primary = error; }
  finally {
    const cleanupErrors = [];
    if (navigation) try { await navigation.cancel(); } catch (error) { cleanupErrors.push(String(error)); }
    if (tab) try { await tab.close(); } catch (error) { cleanupErrors.push(String(error)); }
    if (primary || cleanupErrors.length) {
      const error = primary ?? new Error("Form workflow cleanup failed");
      error.formWorkflow = { ...(detail ?? {}), key, variant, trace, ledger: server.stats(key), cleanupErrors, elapsedMs: performance.now() - startedAt }; throw error;
    }
  }
  return detail;
}
