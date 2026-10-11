// A controlled research task, not a general-web or model-reasoning benchmark.
// Only the server owns the oracle. Callers receive URLs and read rendered sources.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

export const RESEARCH_WORKFLOW_VERSION = 1;
const limit = 128 * 1024;
const constraints = Object.freeze({ quantity: 12, budget: 9000, deadline: "2026-11-20", pdWatts: 90, ethernetMbps: 1000, warrantyMonths: 24 });
const vendors = Object.freeze({ a: "晨星设备", b: "北杉科技", c: "海岬配件" });
const labels = Object.freeze({ quantity: "采购数量（台）", budget: "总预算（元）", deadline: "最迟到货日期", pdWatts: "PD 功率（W）", ethernetMbps: "网速（Mbps）", warrantyMonths: "保修（月）", vendorId: "供应商编号", name: "供应商名称", revision: "资料修订号", unitPrice: "含税单价（元）", available: "可供数量（台）", shipping: "整单运费（元）", deliverBy: "到货日期", total: "含运费总价（元）", reason: "判定依据", quoteURL: "当前报价来源", termsURL: "交付条款来源" });
const numericFields = ["unitPrice", "shipping", "available", "warrantyMonths", "pdWatts", "ethernetMbps", "total"];
const rowFields = ["vendorId", ...numericFields, "deliverBy", "eligible", "reason", "quoteURL", "termsURL"];
const escape = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const json = value => JSON.stringify(value).replace(/</g, "\\u003c");
const hash = value => createHash("sha256").update(value).digest("hex");
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|");

export function researchWorkflowTask() {
  return "为团队采购 12 台 USB-C 扩展坞，做一份可复核的采购评审，不下单或付款。总预算 9000 元，最迟 2026-11-20 到货；每台必须支持至少 90W PD、1000Mbps 网口和 24 个月保修。分别打开三家供应商页面，核对当前报价及交付与保修条款；旧摘要已过期，不能当作当前报价。总价 = 含税单价 × 12 + 整单运费。比较全部三家，在满足所有条件的方案中选择总价最低者；如果全部不满足，选择“无合规方案”。在报告中保存每家原始数据、准确总价、合规结论和两份当前资料的完整来源链接。所有适用的不合规原因使用“数量不足、到货超期、预算超限、PD不足、网速不足、保修不足”；合规原因写“满足全部要求”。摘要说明选择或无法选择的依据，不少于 20 字。只保存一次报告，核对报告页后，将报告作为交付页保留，关闭本任务新开的任务页和资料页，不改变其他用户页面。";
}

function shell(title, content) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>
  *{box-sizing:border-box}body{font:16px/1.55 system-ui,sans-serif;color:#172d3f;background:#f4f7fa;margin:0;padding:28px;max-width:1180px;margin-inline:auto}h1{font-size:28px;line-height:1.3}h2{font-size:21px}section,fieldset,article{background:white;border:1px solid #c7d4df;border-radius:9px;padding:18px;margin:18px 0}legend{font-weight:700}a{color:#145ca4;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:minmax(140px,1fr) minmax(160px,2fr);gap:7px 20px}dt{color:#40586d}dd{margin:0;font-weight:600;overflow-wrap:anywhere}label{display:block;margin:10px 0}input,select,textarea,button{font:inherit;padding:8px;border:1px solid #91a8bb;border-radius:5px}input,textarea{width:100%}textarea{min-height:110px}button{cursor:pointer;background:#eaf3fd}iframe{width:100%;height:480px;border:1px solid #9fb4c5;background:white}table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:10px;border:1px solid #c7d4df;text-align:left;vertical-align:top}th{background:#eaf1f7}.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:8px 18px}.muted{color:#5c6c79}.decision{padding:18px;background:#e9f3ed;border-left:5px solid #30714b}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}[hidden]{display:none!important}</style></head><body>${content}</body></html>`;
}

function definition(fields) {
  return `<dl>${Object.entries(fields).map(([key, value]) => `<dt>${escape(labels[key] ?? key)}</dt><dd data-field="${key}">${escape(value)}</dd>`).join("")}</dl>`;
}

// A nonce changes source values as well as revisions; layout does not determine an answer.
function generate(key, variant, port) {
  const nonce = randomUUID(), bytes = createHash("sha256").update(nonce).digest();
  const mode = bytes[0] % 4, documents = {}, rows = [];
  const base = `/research-task/${key}`, origin = `http://127.0.0.1:${port}`;
  for (const [index, [vendorId, name]] of Object.entries(vendors).entries()) {
    const selected = index === mode;
    const quote = { vendorId, name, revision: `Q-${nonce.slice(0, 8)}-${vendorId}`, unitPrice: (selected ? 450 : 550) + bytes[1 + index] % 100,
      available: 12 + bytes[4 + index] % 15, pdWatts: 100, ethernetMbps: 1000 };
    const terms = { vendorId, revision: `T-${nonce.slice(9, 17)}-${vendorId}`, shipping: 60 + 12 * (bytes[7 + index] % 15) + index * 3,
      deliverBy: `2026-11-${16 + bytes[10 + index] % 5}`, warrantyMonths: 24 + 12 * (bytes[13 + index] % 2) };
    // Some alternatives fail real requirements, while the nominated offer stays
    // valid. Always rank actual totals, including shipping. Mode 3 has no valid offer.
    if (mode === 3 || (!selected && bytes[16 + index] % 2 === 0)) {
      switch (bytes[19 + index] % 6) {
        case 0: quote.available = 6 + bytes[22 + index] % 6; break;
        case 1: terms.deliverBy = "2026-11-23"; break;
        case 2: quote.unitPrice = 790 + bytes[22 + index] % 40; break;
        case 3: quote.pdWatts = 65; break;
        case 4: quote.ethernetMbps = 100; break;
        case 5: terms.warrantyMonths = 12; break;
      }
    }
    const quoteURL = `${origin}${base}/${variant === 1 ? `supplier/${vendorId}` : `source/${vendorId}/quote`}?revision=${quote.revision}`;
    const termsURL = `http://localhost:${port}${base}/source/${vendorId}/terms?revision=${terms.revision}`;
    documents[vendorId] = { quote, terms, quoteURL, termsURL };
    const row = { vendorId, unitPrice: quote.unitPrice, shipping: terms.shipping, available: quote.available, deliverBy: terms.deliverBy,
      warrantyMonths: terms.warrantyMonths, pdWatts: quote.pdWatts, ethernetMbps: quote.ethernetMbps,
      total: quote.unitPrice * constraints.quantity + terms.shipping, quoteURL, termsURL };
    const reasons = [];
    if (row.available < constraints.quantity) reasons.push("数量不足");
    if (row.deliverBy > constraints.deadline) reasons.push("到货超期");
    if (row.total > constraints.budget) reasons.push("预算超限");
    if (row.pdWatts < constraints.pdWatts) reasons.push("PD不足");
    if (row.ethernetMbps < constraints.ethernetMbps) reasons.push("网速不足");
    if (row.warrantyMonths < constraints.warrantyMonths) reasons.push("保修不足");
    rows.push({ ...row, eligible: reasons.length === 0, reason: reasons.length ? reasons.join("；") : "满足全部要求" });
  }
  const ranked = rows.filter(row => row.eligible).sort((a, b) => a.total - b.total);
  assert.ok(ranked.length < 2 || ranked[0].total !== ranked[1].total);
  return { version: RESEARCH_WORKFLOW_VERSION, key, variant, nonce, createdAt: Date.now(), documents,
    oracle: { constraints: { ...constraints }, rows, selection: ranked[0]?.vendorId ?? "none" },
    requests: [], posts: [], acceptedSubmissions: 0, duplicateSubmissions: 0, receipt: null, overflow: false };
}

function brief(record) {
  const base = `/research-task/${record.key}`, order = record.variant === 2 ? ["c", "a", "b"] : record.variant === 3 ? ["b", "c", "a"] : ["a", "b", "c"];
  return shell("团队扩展坞采购评审", `<h1>团队扩展坞采购评审</h1><p id="task">${escape(researchWorkflowTask())}</p><p class="muted">任务 ${escape(record.key)} · 布局 ${record.variant} · 本地模拟资料</p>
  <section aria-label="采购要求"><h2>采购要求</h2>${definition(constraints)}</section><section><h2>供应商资料</h2><p>每份当前资料都显示修订号及可引用的原文链接。请在独立资料页核对，避免混用供应商。</p><ul>${order.map(id => `<li><a data-vendor="${id}" href="${escape(record.variant === 1 ? record.documents[id].quoteURL : `${base}/supplier/${id}`)}">研究 ${vendors[id]}</a></li>`).join("")}</ul></section>
  <p><a data-action="report" href="${base}/editor">填写评审报告</a></p>`);
}

function sourceSection(record, vendorId, kind) {
  const doc = record.documents[vendorId], title = kind === "quote" ? "当前报价" : "交付与保修";
  const fields = doc[kind], entries = record.variant === 2 ? Object.fromEntries(Object.entries(fields).reverse()) : fields;
  return `<section aria-label="${title}" id="${kind === "quote" ? "current-quote" : "current-terms"}"><h2>${title}</h2><p>${vendors[vendorId]} · 当前有效资料，替代旧摘要</p>${definition(entries)}<p><a data-field="sourceURL" href="${escape(doc[`${kind}URL`])}">来源原文 · ${escape(fields.revision)}</a></p></section>`;
}

function supplier(record, vendorId) {
  const doc = record.documents[vendorId], quoteFrame = `<iframe title="当前报价" src="${escape(doc.quoteURL)}"></iframe>`;
  const termsFrame = `<iframe title="交付与保修" src="${escape(doc.termsURL)}"></iframe>`;
  const quote = record.variant === 1 ? sourceSection(record, vendorId, "quote") : quoteFrame;
  const terms = record.variant === 3 ? `<button type="button" id="expand-terms">展开交付与保修</button><div id="terms-slot"></div><script>
    document.getElementById('expand-terms').addEventListener('click',function(){if(document.getElementById('terms-slot').children.length)return;const frame=document.createElement('iframe');frame.title='交付与保修';frame.src=${json(doc.termsURL)};document.getElementById('terms-slot').append(frame);this.disabled=true;});</script>` : termsFrame;
  return shell(`${vendors[vendorId]} · 资料核对`, `<h1>${vendors[vendorId]} · 资料核对</h1><p>供应商编号 ${vendorId}。请区分当前资料与已过期摘要，两份当前资料必须同时采用。</p>
    <section aria-label="过期摘要"><h2>过期摘要 · 不可作为本次报价</h2><p>2026-09-01 的目录价：每台 ${Math.max(199, doc.quote.unitPrice - 175)} 元，曾标注库存充足。该摘要已过期，当前单价、可供数量、到货及保修以以下修订资料为准。</p></section>
    ${record.variant === 2 ? terms + quote : quote + terms}`);
}

function editor(record) {
  const base = `/research-task/${record.key}`;
  const fields = ["unitPrice", "shipping", "available", "deliverBy", "warrantyMonths", "pdWatts", "ethernetMbps", "total", "reason", "quoteURL", "termsURL"];
  const groups = Object.entries(vendors).map(([vendorId, name]) => `<fieldset data-vendor="${vendorId}"><legend>${name}（${vendorId}）</legend><div class="fields">${fields.map(field => `<label>${labels[field]}<input data-field="${field}" autocomplete="off" required${numericFields.includes(field) ? ' inputmode="numeric"' : ""}></label>`).join("")}<label>合规结论<select data-field="eligible" required><option value="">请选择</option><option value="yes">合规</option><option value="no">不合规</option></select></label></div></fieldset>`).join("");
  return shell("保存采购评审报告", `<h1>保存采购评审报告</h1><p>录入三家的当前事实、比较结论和完整来源URL。保存后生成可阅读、可交付的报告；这不会创建订单。判定依据按任务书规定列出全部适用原因，合规写“满足全部要求”。</p>
    <form id="report-form">${groups}<label>推荐方案<select aria-label="推荐方案" id="selection" required><option value="">请选择</option>${Object.entries(vendors).map(([id, name]) => `<option value="${id}">${name}</option>`).join("")}<option value="none">无合规方案</option></select></label>
    <label>评审摘要<textarea aria-label="评审摘要" id="summary" minlength="20" maxlength="2000" required></textarea></label><button id="save-report">保存评审报告</button><p role="status" id="status">尚未保存</p></form><script>
    const events=[];for(const type of ['pointerdown','click','input','change','submit'])document.addEventListener(type,event=>{if(events.length>=256)return;const node=event.composedPath()[0];events.push({index:events.length,type,trusted:event.isTrusted,id:node.id??'',vendorId:node.closest?.('[data-vendor]')?.dataset.vendor??'',field:node.dataset?.field??'',at:Date.now()});},true);
    document.getElementById('report-form').addEventListener('submit',async event=>{event.preventDefault();const button=document.getElementById('save-report');if(button.disabled)return;button.disabled=true;
      const rows=Array.from(document.querySelectorAll('fieldset[data-vendor]'),group=>{const row={vendorId:group.dataset.vendor};for(const node of group.querySelectorAll('[data-field]')){const field=node.dataset.field;row[field]=${json(numericFields)}.includes(field)?Number(node.value):field==='eligible'?node.value==='yes':node.value.trim();}return row;});
      try{const response=await fetch(${json(`${base}/submit`)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce:${json(record.nonce)},rows,selection:document.getElementById('selection').value,summary:document.getElementById('summary').value.trim(),events})});const result=await response.json();if(!response.ok)throw new Error(result.error);location.assign(result.reportURL);}
      catch(error){document.getElementById('status').textContent='保存失败：'+error.message;button.disabled=false;}});</script>`);
}

function reportPage(record) {
  const receipt = record.receipt;
  return shell("采购评审报告", `<h1>团队扩展坞采购评审报告</h1><p class="muted">报告 ${escape(receipt.reportId)} · 任务 ${escape(record.key)} · ${escape(receipt.savedAt)}</p>
    <div class="decision"><strong>推荐：${receipt.selection === "none" ? "无合规方案" : vendors[receipt.selection]}</strong><p>${escape(receipt.summary)}</p></div>
    <h2>三家方案比较</h2><p>数量 12 台；预算 9000 元；最迟 2026-11-20；PD≥90W、网速≥1000Mbps、保修≥24月。</p>
    <table><thead><tr><th>供应商</th><th>价格与数量</th><th>交付与能力</th><th>结论</th><th>当前来源</th></tr></thead><tbody>${receipt.rows.map(row => `<tr data-vendor="${row.vendorId}"><th>${vendors[row.vendorId]}</th><td>含税单价 ${row.unitPrice} 元<br>整单运费 ${row.shipping} 元<br>可供 ${row.available} 台<br><strong>总价 ${row.total} 元</strong></td><td>到货 ${escape(row.deliverBy)}<br>PD ${row.pdWatts}W / ${row.ethernetMbps}Mbps<br>保修 ${row.warrantyMonths} 月</td><td>${row.eligible ? "合规" : "不合规"}<br>${escape(row.reason)}</td><td><a href="${escape(row.quoteURL)}">${escape(record.documents[row.vendorId].quote.revision)} · 报价</a><br><a href="${escape(row.termsURL)}">${escape(record.documents[row.vendorId].terms.revision)} · 条款</a></td></tr>`).join("")}</tbody></table>
    <p>这是一份已保存的评审报告，没有提交采购订单。</p><details open><summary>核验收据</summary><pre id="receipt-json">${escape(JSON.stringify(receipt, null, 2))}</pre></details>`);
}

function validatePayload(payload, record) {
  if (!exactKeys(payload, ["nonce", "rows", "selection", "summary", "events"]) || payload.nonce !== record.nonce || !Array.isArray(payload.rows) || payload.rows.length !== 3 ||
      typeof payload.summary !== "string" || payload.summary.trim().length < 20 || payload.summary.length > 2000 ||
      !Array.isArray(payload.events) || payload.events.length > 256 || !payload.events.every(event => event && typeof event.type === "string" && typeof event.trusted === "boolean" && Number.isFinite(event.at))) return false;
  if (payload.selection !== record.oracle.selection) return false;
  const found = new Set();
  for (const row of payload.rows) {
    if (!exactKeys(row, rowFields) || found.has(row.vendorId)) return false;
    found.add(row.vendorId);
    const expected = record.oracle.rows.find(candidate => candidate.vendorId === row.vendorId);
    if (!expected || numericFields.some(field => !Number.isSafeInteger(row[field]))) return false;
    if (Object.keys(expected).some(field => field !== "reason" && expected[field] !== row[field])) return false;
    if (typeof row.reason !== "string" || row.reason.split(/[；;、，,]/u).map(part => part.trim()).filter(Boolean).sort().join("|") !== expected.reason.split("；").sort().join("|")) return false;
  }
  return true;
}

export function createResearchWorkflowFixture({ onChange = () => {} } = {}) {
  const records = new Map();
  const changed = () => onChange();
  const reply = (response, status, body, type = "text/html; charset=utf-8") => {
    response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(body);
  };
  const fail = (response, status, message) => reply(response, status, JSON.stringify({ error: message }), "application/json; charset=utf-8");
  function handle(request, response, port) {
    let url;
    try { url = new URL(request.url, `http://${request.headers.host}`); } catch { return false; }
    const match = /^\/research-task\/([A-Za-z0-9_-]{1,100})(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return false;
    const [, key, route = ""] = match;
    let record = records.get(key);
    if (!record) {
      if (route || request.method !== "GET") { fail(response, 404, "Task not found"); return true; }
      const variant = Number(url.searchParams.get("variant") ?? 1);
      if (![1, 2, 3].includes(variant) || records.size >= 128) { fail(response, 400, "Invalid task or capacity reached"); return true; }
      record = generate(key, variant, port); records.set(key, record);
    }
    if (record.requests.length >= 512) { record.overflow = true; changed(); fail(response, 429, "Evidence capacity reached"); return true; }
    record.requests.push({ index: record.requests.length, at: Date.now(), method: request.method, url: url.href, route }); changed();
    if (request.method === "POST" && route === "submit") {
      let bytes = 0, chunks = [], exceeded = false;
      request.on("data", chunk => { bytes += chunk.length; if (bytes > limit) exceeded = true; else if (!exceeded) chunks.push(chunk); });
      request.on("error", () => { if (!response.writableEnded) fail(response, 400, "Body read failed"); });
      request.on("end", () => {
        if (exceeded) { fail(response, 413, "Report too large"); return; }
        const buffer = Buffer.concat(chunks), raw = buffer.toString("utf8");
        if (record.posts.length >= 32) { record.overflow = true; changed(); fail(response, 429, "Evidence capacity reached"); return; }
        const entry = { at: Date.now(), route, bytes: buffer.length, raw, base64: buffer.toString("base64"), sha256: hash(buffer), status: 400 };
        record.posts.push(entry);
        try {
          if (record.receipt) { record.duplicateSubmissions++; entry.status = 409; fail(response, 409, "Report already saved"); return; }
          let payload; try { payload = JSON.parse(raw); } catch { fail(response, 400, "Invalid report body"); return; }
          if (!validatePayload(payload, record)) { entry.status = 422; fail(response, 422, "Report does not match the current sources and task requirements"); return; }
          record.receipt = { version: RESEARCH_WORKFLOW_VERSION, key, variant: record.variant, reportId: `REVIEW-${randomUUID()}`,
            rows: structuredClone(payload.rows), selection: payload.selection, summary: payload.summary.trim(), savedAt: new Date().toISOString() };
          record.acceptedSubmissions++; entry.status = 201;
          reply(response, 201, JSON.stringify({ reportURL: `/research-task/${key}/report` }), "application/json; charset=utf-8");
        } finally { changed(); }
      });
      return true;
    }
    if (request.method !== "GET") { fail(response, 405, "Method not allowed"); return true; }
    if (!route) { reply(response, 200, brief(record)); return true; }
    if (route === "editor") { reply(response, 200, editor(record)); return true; }
    if (route === "report") { if (record.receipt) reply(response, 200, reportPage(record)); else fail(response, 404, "Report not saved"); return true; }
    const supplierMatch = /^supplier\/([abc])$/.exec(route);
    if (supplierMatch) {
      if (record.variant === 1 && url.searchParams.get("revision") !== record.documents[supplierMatch[1]].quote.revision) { fail(response, 409, "A current source revision is required"); return true; }
      reply(response, 200, supplier(record, supplierMatch[1])); return true;
    }
    const sourceMatch = /^source\/([abc])\/(quote|terms)$/.exec(route);
    if (sourceMatch) {
      const [, id, kind] = sourceMatch;
      if (url.searchParams.get("revision") !== record.documents[id][kind].revision) { fail(response, 409, "A current source revision is required"); return true; }
      reply(response, 200, shell(`${vendors[id]} · ${kind === "quote" ? "当前报价" : "交付与保修"}`, sourceSection(record, id, kind))); return true;
    }
    fail(response, 404, "Route not found"); return true;
  }
  return { handle, stats: key => structuredClone(records.get(key) ?? null), allStats: () => structuredClone([...records.values()]) };
}

// Run only after the solver has returned. This verifier does not drive a browser.
export function checkResearchReceipt(receipt, ledger) {
  assert.ok(ledger && !ledger.overflow, "Research evidence is present and bounded");
  assert.deepEqual(receipt, ledger.receipt);
  assert.equal(ledger.acceptedSubmissions, 1); assert.equal(ledger.duplicateSubmissions, 0);
  assert.equal(ledger.posts.length, 1, "One actual submission, without failed answer probing");
  const post = ledger.posts[0]; assert.equal(post.status, 201);
  assert.equal(hash(Buffer.from(post.base64, "base64")), post.sha256);
  assert.equal(Buffer.byteLength(post.raw), post.bytes); assert.equal(Buffer.from(post.base64, "base64").toString("utf8"), post.raw);
  const payload = JSON.parse(post.raw); assert.ok(validatePayload(payload, ledger));
  assert.equal(receipt.selection, ledger.oracle.selection); assert.deepEqual(receipt.rows, payload.rows);
  assert.equal(receipt.summary, payload.summary.trim()); assert.equal(receipt.key, ledger.key); assert.equal(receipt.variant, ledger.variant);
  for (const row of ledger.oracle.rows) for (const field of ["quoteURL", "termsURL"]) {
    assert.ok(ledger.requests.some(request => request.method === "GET" && request.url === row[field] && request.at <= post.at), `Current ${row.vendorId} ${field} was served before submission`);
  }
  assert.ok(ledger.requests.some(request => request.method === "GET" && request.route === "report" && request.at >= post.at), "Saved report was actually read");
  assert.equal(payload.events.filter(event => event.type === "submit").length, 1);
  assert.ok(payload.events.some(event => event.type === "submit" && event.trusted), "Browser observed the form submission");
  assert.ok(payload.events.some(event => event.type === "click" && event.id === "save-report" && event.trusted), "Browser observed the save action");
  return { reportId: receipt.reportId, selection: receipt.selection, sourceCount: 6, submissionSha256: post.sha256 };
}
