import assert from "node:assert/strict";
import path from "node:path";

const vendors = ["a", "b", "c"];
const requirementFields = ["quantity", "budget", "deadline", "pdWatts", "ethernetMbps", "warrantyMonths"];
const quoteFields = ["vendorId", "name", "revision", "unitPrice", "available", "pdWatts", "ethernetMbps"];
const termsFields = ["vendorId", "revision", "shipping", "deliverBy", "warrantyMonths"];
const numericRowFields = ["unitPrice", "shipping", "available", "warrantyMonths", "pdWatts", "ethernetMbps", "total"];
const css = selector => ({ kind: "css", selector });
const role = (role, name) => ({ kind: "role", role, name, exact: true });
const frame = title => ({ kind: "frame", selector: `iframe[title="${title}"]` });

function integer(value, label) {
  assert.match(String(value), /^(0|[1-9][0-9]*)$/, `${label} must be a decimal integer`);
  const number = Number(value);
  assert.ok(Number.isSafeInteger(number), `${label} exceeds the safe integer range`);
  return number;
}

function date(value, label) {
  assert.match(value, /^\d{4}-\d{2}-\d{2}$/, `${label} must be an ISO calendar date`);
  assert.equal(new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10), value, `${label} is not a calendar date`);
  return value;
}

function requirementsFromVisible(fields) {
  const result = Object.fromEntries(requirementFields.map(key => [key, key === "deadline" ? date(fields[key], key) : integer(fields[key], key)]));
  assert.ok(result.quantity > 0);
  return result;
}

// Input consists solely of visible task requirements and independently read
// current source sections. No fixture/server/oracle module is imported here.
export function compareResearchSources(requirements, observations) {
  const required = requirementsFromVisible(requirements);
  assert.deepEqual(observations.map(item => item.vendorId).sort(), vendors);
  const rows = observations.map(({ vendorId, quote, terms, quoteURL, termsURL }) => {
    assert.equal(quote.vendorId, vendorId, "Quote belongs to the requested vendor");
    assert.equal(terms.vendorId, vendorId, "Terms belong to the requested vendor");
    for (const [source, url] of [[quote, quoteURL], [terms, termsURL]]) {
      assert.ok(typeof source.revision === "string" && source.revision.length > 0);
      assert.deepEqual(new URL(url).searchParams.getAll("revision"), [source.revision], "Citation identifies the observed revision exactly once");
    }
    const row = { vendorId };
    for (const key of ["unitPrice", "available", "pdWatts", "ethernetMbps"]) row[key] = integer(quote[key], key);
    for (const key of ["shipping", "warrantyMonths"]) row[key] = integer(terms[key], key);
    row.deliverBy = date(terms.deliverBy, "deliverBy");
    row.total = required.quantity * row.unitPrice + row.shipping;
    assert.ok(Number.isSafeInteger(row.total), "Total exceeds the safe integer range");
    const failures = [
      [row.available < required.quantity, "数量不足"],
      [row.deliverBy > required.deadline, "到货超期"],
      [row.total > required.budget, "预算超限"],
      [row.pdWatts < required.pdWatts, "PD不足"],
      [row.ethernetMbps < required.ethernetMbps, "网速不足"],
      [row.warrantyMonths < required.warrantyMonths, "保修不足"],
    ].filter(([failed]) => failed).map(([, reason]) => reason);
    return { ...row, eligible: failures.length === 0, reason: failures.join("；") || "满足全部要求", quoteURL, termsURL };
  }).sort((a, b) => a.vendorId.localeCompare(b.vendorId));
  const eligible = rows.filter(row => row.eligible).sort((a, b) => a.total - b.total);
  assert.ok(eligible.length < 2 || eligible[0].total !== eligible[1].total, "The research task must have an unambiguous lowest eligible total");
  const selection = eligible[0]?.vendorId ?? "none";
  const summary = `依据三家供应商当前报价及交付与保修原文，按 ${required.quantity} 台的含运费总价、到货日期、库存、PD、网速及保修逐项核对。` +
    (eligible.length ? `推荐 ${selection}，合规方案中总价最低，为 ${eligible[0].total}；各项结论及原文链接已列入比较表。` : "三家均有不符合要求的项目，因此不推荐任何方案；具体原因及原文链接已列入比较表。");
  return { rows, selection, summary };
}

function typedLocator(tab, steps) {
  let result = tab.playwright;
  for (const step of steps) {
    if (step.kind === "css") result = result.locator(step.selector);
    else if (step.kind === "frame") result = result.frameLocator(step.selector);
    else if (step.kind === "role") result = result.getByRole(step.role, { name: step.name, exact: true });
    else throw new Error(`Unsupported research locator kind ${step.kind}`);
  }
  return result;
}

function traced(detail, transport) {
  return async (operation, args, work) => {
    const item = { sequence: detail.trace.length, transport, operation, args: structuredClone(args), startedAt: performance.now() };
    detail.trace.push(item);
    try { const value = await work(); item.passed = true; return value; }
    catch (error) { item.error = String(error); throw error; }
    finally { item.elapsedMs = performance.now() - item.startedAt; }
  };
}

async function sdkAdapter(options, detail) {
  const browser = await options.connectOpenBrowserUse({ socketPath: options.endpoint, sessionId: options.key, timeoutMs: 15000 });
  const trace = traced(detail, "JS SDK");
  try {
    await trace("beginTurn", {}, () => browser.client.beginTurn());
    detail.scope = { session_id: options.key, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch };
    return {
      async create() { return (await trace("newTab", {}, () => browser.newTab())).id; },
      async action(tabId, action, locator = [], args = {}) {
        return trace(action, { tabId, locator, args }, async () => {
          const tab = browser.tab(tabId), target = typedLocator(tab, locator);
          if (action === "goto") return tab.goto(args.url, { waitUntil: "load", timeoutMs: 10000 });
          if (action === "screenshot") return tab.screenshot({ type: "png", fullPage: true, timeoutMs: 10000 });
          if (action === "fill") return target.fill(args.value);
          if (action === "selectOption") return target.selectOption(args.values);
          if (action === "getAttribute") return target.getAttribute(args.name);
          if (action === "waitFor") return target.waitFor(args);
          return target[action]();
        });
      },
      tabs: () => trace("getTabs", {}, () => browser.client.getTabs()),
      finalize: keep => trace("finalizeTabs", { keep }, () => browser.client.finalizeTabs(keep)),
      close: () => browser.close(),
    };
  } catch (error) { browser.close(); throw error; }
}

async function wireAdapter(call, kind, key, detail) {
  const trace = traced(detail, kind.toUpperCase());
  const send = (method, params) => trace(method, params, () => call(method, params));
  const initial = { session_id: key, turn_id: `research-${key}` };
  const info = await send("getInfo", initial);
  assert.equal(info.metadata.turnLifecycleVersion, 1);
  const control = await send("getControlState", initial);
  assert.equal(control.closing, false);
  assert.ok(Number.isSafeInteger(control.controlEpoch) && control.controlEpoch > 0);
  detail.scope = { ...initial, control_epoch: control.controlEpoch };
  const scoped = (method, params = {}) => send(method, { ...detail.scope, ...params });
  return {
    async create() {
      const created = await scoped("createTab");
      assert.ok(Number.isSafeInteger(created.id) && created.id >= 0);
      return created.id;
    },
    async action(tabId, action, locator = [], args = {}) {
      const response = await scoped("browserAction", { tabId, action, ...(locator.length ? { locator } : {}), args, timeoutMs: 10000 });
      assert.ok(response && Object.hasOwn(response, "value"));
      assert.equal(response.engine?.name, "playwright-crx");
      return response.value;
    },
    tabs: () => scoped("getTabs"),
    finalize: keep => scoped("finalizeTabs", { keep }),
    close() {},
  };
}

function fixtureLink(value, base, key) {
  assert.ok(typeof value === "string" && value.length > 0, "A visible source link is required");
  const url = new URL(value, base), origin = new URL(base);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  assert.equal(url.protocol, "http:"); assert.equal(url.port, origin.port);
  assert.ok(url.pathname.startsWith(`/research-task/${key}/`), "A link must stay in the current synthetic task");
  return url.href;
}

async function executeWorkflow(adapter, options, detail) {
  let finalizeAttempted = false;
  const act = (tab, action, locator, args) => adapter.action(tab, action, locator, args);
  const text = async (tab, locator) => {
    const result = await act(tab, "innerText", locator);
    assert.equal(typeof result, "string"); return result.trim();
  };
  const create = async url => {
    const tabId = await adapter.create(); detail.createdTabIds.push(tabId);
    await act(tabId, "goto", [], { url, waitUntil: "load" }); return tabId;
  };
  const fields = async (tabId, base, keys) => {
    await act(tabId, "waitFor", base, { state: "visible" });
    const result = {};
    for (const key of keys) result[key] = await text(tabId, [...base, css(`dd[data-field="${key}"]`)]);
    return result;
  };
  try {
    const taskURL = new URL(`/research-task/${options.key}`, options.fixtureURL);
    taskURL.searchParams.set("variant", String(options.variant));
    detail.briefTabId = await create(taskURL.href);
    const requirements = {};
    for (const key of requirementFields) requirements[key] = await text(detail.briefTabId, [css(`dd[data-field="${key}"]`)]);
    detail.task = { text: await text(detail.briefTabId, [css("#task")]), requirements: requirementsFromVisible(requirements) };
    const links = {};
    for (const vendorId of vendors) links[vendorId] = fixtureLink(await act(detail.briefTabId, "getAttribute", [css(`a[data-vendor="${vendorId}"]`)], { name: "href" }), taskURL, options.key);
    const reportURL = fixtureLink(await act(detail.briefTabId, "getAttribute", [css('a[data-action="report"]')], { name: "href" }), taskURL, options.key);
    for (const vendorId of vendors) {
      const tabId = await create(links[vendorId]);
      const observation = { vendorId, tabId, supplierURL: links[vendorId] };
      detail.observations.push(observation);
      const framedQuote = await act(tabId, "count", [css('iframe[title="当前报价"]')]);
      assert.ok(framedQuote === 0 || framedQuote === 1);
      const quoteRoot = [...(framedQuote ? [frame("当前报价")] : []), css('section[aria-label="当前报价"]')];
      const quote = await fields(tabId, quoteRoot, quoteFields);
      observation.quote = quote;
      const quoteURL = fixtureLink(await act(tabId, "getAttribute", [...quoteRoot, css('a[data-field="sourceURL"]')], { name: "href" }), links[vendorId], options.key);
      observation.quoteURL = quoteURL;
      const expand = [role("button", "展开交付与保修")], expandable = await act(tabId, "count", expand);
      assert.ok(expandable === 0 || expandable === 1);
      if (expandable) await act(tabId, "click", expand);
      const termsRoot = [frame("交付与保修"), css('section[aria-label="交付与保修"]')];
      const terms = await fields(tabId, termsRoot, termsFields);
      observation.terms = terms;
      const termsURL = fixtureLink(await act(tabId, "getAttribute", [...termsRoot, css('a[data-field="sourceURL"]')], { name: "href" }), links[vendorId], options.key);
      observation.termsURL = termsURL;
    }
    detail.report = compareResearchSources(detail.task.requirements, detail.observations);
    detail.reportTabId = await create(reportURL);
    for (const row of detail.report.rows) {
      const group = [css(`fieldset[data-vendor="${row.vendorId}"]`)];
      for (const key of [...numericRowFields, "deliverBy", "reason", "quoteURL", "termsURL"])
        await act(detail.reportTabId, "fill", [...group, css(`[data-field="${key}"]`)], { value: String(row[key]) });
      await act(detail.reportTabId, "selectOption", [...group, css('[data-field="eligible"]')], { values: { value: row.eligible ? "yes" : "no" } });
    }
    await act(detail.reportTabId, "selectOption", [role("combobox", "推荐方案")], { values: { value: detail.report.selection } });
    await act(detail.reportTabId, "fill", [role("textbox", "评审摘要")], { value: detail.report.summary });
    await act(detail.reportTabId, "click", [role("button", "保存评审报告")]);
    // Wait on the actual receipt DOM; never fetch the submission endpoint or
    // retry the write if the original click/response is uncertain.
    await act(detail.reportTabId, "waitFor", [css("#receipt-json")], { state: "visible" });
    detail.receipt = JSON.parse(await text(detail.reportTabId, [css("#receipt-json")]));
    assert.equal(detail.receipt.version, 1); assert.equal(detail.receipt.key, options.key); assert.equal(detail.receipt.variant, options.variant);
    assert.ok(typeof detail.receipt.reportId === "string" && detail.receipt.reportId.length > 0);
    assert.ok(typeof detail.receipt.savedAt === "string" && detail.receipt.savedAt.length > 0);
    assert.deepEqual(detail.receipt.rows, detail.report.rows); assert.equal(detail.receipt.selection, detail.report.selection); assert.equal(detail.receipt.summary, detail.report.summary);
    detail.screenshot = await act(detail.reportTabId, "screenshot", [], { type: "png", fullPage: true });
    assert.equal(detail.screenshot.mimeType, "image/png"); assert.equal(typeof detail.screenshot.base64, "string");
    detail.tabsBefore = await adapter.tabs();
    assert.deepEqual(detail.tabsBefore.map(tab => tab.id).sort((a, b) => a - b), [...detail.createdTabIds].sort((a, b) => a - b));
    finalizeAttempted = true;
    detail.finalizeResult = await adapter.finalize([{ tabId: detail.reportTabId, status: "deliverable" }]);
    detail.keptTabIds = [detail.reportTabId];
    detail.closedTabIds = detail.createdTabIds.filter(id => id !== detail.reportTabId);
    detail.dispositionEvidence = "Successful public finalize acknowledgement; runner independently verifies actual tab metadata and absence";
    return detail;
  } catch (error) {
    if (!finalizeAttempted) {
      try {
        const keep = detail.receipt ? [{ tabId: detail.reportTabId, status: "deliverable" }] : [];
        detail.cleanupResult = await adapter.finalize(keep);
        detail.keptTabIds = keep.map(item => item.tabId);
        detail.closedTabIds = detail.createdTabIds.filter(id => !detail.keptTabIds.includes(id));
      } catch (cleanupError) { detail.cleanupError = String(cleanupError); }
    }
    detail.failed = true; detail.error = String(error); error.researchWorkflow = detail; throw error;
  } finally { adapter.close(); }
}

export async function checkResearchWorkflow(options) {
  const { kind, key, variant } = options;
  assert.ok(["js", "cli", "mcp"].includes(kind)); assert.match(key, /^[A-Za-z0-9_-]{1,80}$/); assert.ok([1, 2, 3].includes(variant));
  const detail = { caller: kind, key, variant, observations: [], createdTabIds: [], keptTabIds: [], closedTabIds: [], trace: [] };
  const run = adapter => executeWorkflow(adapter, options, detail);
  if (kind === "js") return run(await sdkAdapter(options, detail));
  if (kind === "mcp") return options.withMCPClient(options.executable, options.endpoint, key, async call => run(await wireAdapter(call, kind, key, detail)));
  const call = async (method, params) => {
    const response = JSON.parse(await options.subprocess(path.resolve(options.executable), ["call", "--socket", options.endpoint, "--session-id", key,
      "--method", method, "--params", JSON.stringify(params), "--timeout", "15s"]));
    assert.equal(response.error, undefined, JSON.stringify(response.error)); assert.ok(Object.hasOwn(response, "result"));
    return response.result;
  };
  return run(await wireAdapter(call, kind, key, detail));
}
