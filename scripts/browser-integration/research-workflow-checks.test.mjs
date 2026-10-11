import assert from "node:assert/strict";
import test from "node:test";
import { checkResearchWorkflow, compareResearchSources } from "./research-workflow-checks.mjs";

const requirements = { quantity: 12, budget: 9000, deadline: "2026-11-20", pdWatts: 90, ethernetMbps: 1000, warrantyMonths: 24 };
const source = (vendorId, unitPrice, extraQuote = {}, extraTerms = {}) => ({ vendorId,
  quote: { vendorId, name: `Visible supplier ${vendorId}`, revision: `q-${vendorId}`, unitPrice: String(unitPrice), available: "12", pdWatts: "90", ethernetMbps: "1000", ...extraQuote },
  terms: { vendorId, revision: `t-${vendorId}`, shipping: "120", deliverBy: "2026-11-20", warrantyMonths: "24", ...extraTerms },
  quoteURL: `http://127.0.0.1:8000/research-task/test/vendor/${vendorId}?revision=q-${vendorId}`,
  termsURL: `http://localhost:8000/research-task/test/terms/${vendorId}?revision=t-${vendorId}`,
});

test("comparison uses observed shipping and all six constraints, not supplier order or cheapest sticker price", () => {
  const a = source("a", 400, { available: "11", pdWatts: "89", ethernetMbps: "999" }, { shipping: "5000", deliverBy: "2026-11-21", warrantyMonths: "23" });
  const b = source("b", 700, {}, { shipping: "600" });
  const c = source("c", 701, {}, { shipping: "0" });
  const result = compareResearchSources(requirements, [c, a, b]);
  assert.equal(result.selection, "c");
  assert.equal(result.rows[0].reason, "数量不足；到货超期；预算超限；PD不足；网速不足；保修不足");
  assert.equal(result.rows[1].total, 9000); assert.equal(result.rows[1].eligible, true);
  assert.equal(result.rows[2].total, 8412); assert.equal(result.rows[2].reason, "满足全部要求");
  assert.ok(result.summary.length >= 20 && result.summary.length <= 2000);
  assert.equal(result.rows[2].quoteURL, c.quoteURL);
});

test("comparison handles no compliant option and rejects ambiguous, crossed, stale or malformed evidence", () => {
  assert.equal(compareResearchSources(requirements, [source("a", 800), source("b", 900), source("c", 1000)]).selection, "none");
  assert.throws(() => compareResearchSources(requirements, [source("a", 600), source("b", 600), source("c", 700)]), /unambiguous/);
  assert.throws(() => compareResearchSources(requirements, [source("a", 600, { vendorId: "b" }), source("b", 700), source("c", 800)]), /Quote belongs/);
  assert.throws(() => compareResearchSources(requirements, [source("a", 600, { revision: "retired" }), source("b", 700), source("c", 800)]), /observed revision/);
  assert.throws(() => compareResearchSources(requirements, [source("a", "600 USD"), source("b", 700), source("c", 800)]), /decimal integer/);
  assert.throws(() => compareResearchSources(requirements, [source("a", 600, {}, { deliverBy: "2026-02-30" }), source("b", 700), source("c", 800)]), /calendar date/);
});

// A transport contract double: only public requests expose its synthetic DOM.
// It does not import the research server or its independent expected answers.
function publicBrowser({ key = "test", variant = 1, failAction, failFinalize = false } = {}) {
  const sources = [source("a", 600), source("b", 640), source("c", 500, { pdWatts: "45" })];
  const calls = [], tabs = new Map(), form = {}, expanded = new Set();
  const control = { controlEpoch: 41, nextTurnId: "next", closing: false, lifecycleVersion: 1 };
  let nextId = 10, receipt, submitCount = 0, finalized = 0;
  function action(tabId, action, locator = [], args = {}) {
    if (failAction === action) throw new Error(`Injected ${action} failure`);
    const tab = tabs.get(tabId); assert.ok(tab, "Every action has a created tab");
    if (action === "goto") { tab.url = args.url; return null; }
    if (action === "screenshot") return { mimeType: "image/png", base64: "fixture-test-image" };
    const selected = locator.at(-1), selector = selected?.selector ?? "", field = /data-field="([^"]+)"/.exec(selector)?.[1];
    const vendorId = /\/vendor\/([abc])/.exec(tab.url)?.[1];
    const observation = sources.find(item => item.vendorId === vendorId);
    if (action === "count") {
      if (selector === 'iframe[title="当前报价"]') return variant === 1 ? 0 : 1;
      if (selected?.name === "展开交付与保修") return variant === 3 ? 1 : 0;
      throw new Error(`Unexpected count ${selector}`);
    }
    if (action === "waitFor") {
      if (selector === "#receipt-json") assert.ok(receipt, "Receipt exists only after the actual submit action");
      return null;
    }
    if (action === "innerText") {
      if (selector === "#task") return "读取三家当前原文，比较并保存采购评审报告。";
      if (selector === "#receipt-json") return JSON.stringify(receipt);
      if (!observation) return String(requirements[field]);
      const isTerms = locator.some(item => item.kind === "frame" && item.selector.includes("交付与保修"));
      if (isTerms && variant === 3) assert.ok(expanded.has(tabId), "Dynamic terms were expanded through a click");
      const quoteFrame = locator.some(item => item.kind === "frame" && item.selector.includes("当前报价"));
      if (!isTerms) assert.equal(quoteFrame, variant !== 1);
      return (isTerms ? observation.terms : observation.quote)[field];
    }
    if (action === "getAttribute") {
      if (selector.includes("data-vendor")) return sources.find(item => selector.includes(`"${item.vendorId}"`)).quoteURL;
      if (selector.includes("data-action")) return `/research-task/${key}/edit`;
      return locator.some(item => item.kind === "frame" && item.selector.includes("交付与保修")) ? observation.termsURL : observation.quoteURL;
    }
    if (action === "fill" || action === "selectOption") {
      const vendor = /data-vendor="([abc])"/.exec(locator[0]?.selector ?? "")?.[1];
      const target = vendor ? (form[vendor] ??= { vendorId: vendor }) : form;
      const name = vendor ? field : selected.name === "推荐方案" ? "selection" : "summary";
      let value = action === "fill" ? args.value : args.values.value;
      if (vendor && ["unitPrice", "shipping", "available", "warrantyMonths", "pdWatts", "ethernetMbps", "total"].includes(name)) value = Number(value);
      if (name === "eligible") value = value === "yes";
      target[name] = value;
      return action === "selectOption" ? [args.values.value] : null;
    }
    if (action === "click" && selected.name === "展开交付与保修") { assert.ok(!expanded.has(tabId)); expanded.add(tabId); return null; }
    if (action === "click" && selected.name === "保存评审报告") {
      submitCount++;
      receipt = { version: 1, key, variant, reportId: "test-report", rows: [form.a, form.b, form.c], selection: form.selection, summary: form.summary, savedAt: "2026-10-11" };
      tab.url = `http://127.0.0.1:8000/research-task/${key}/report`; return null;
    }
    throw new Error(`Unexpected ${action} ${JSON.stringify(locator)}`);
  }
  async function call(method, params) {
    calls.push({ method, params: structuredClone(params) });
    assert.equal(params.session_id, key);
    if (!["getInfo", "getControlState"].includes(method)) assert.equal(params.control_epoch, control.controlEpoch);
    if (method === "getInfo") return { metadata: { turnLifecycleVersion: 1 } };
    if (method === "getControlState") return control;
    if (method === "createTab") { const tab = { id: nextId++, url: "about:blank" }; tabs.set(tab.id, tab); return tab; }
    if (method === "browserAction") return { value: action(params.tabId, params.action, params.locator, params.args), engine: { name: "playwright-crx" } };
    if (method === "getTabs") return [...tabs.values()];
    if (method === "finalizeTabs") {
      finalized++; assert.equal(finalized, 1, "An uncertain finalization is not replayed");
      if (failFinalize) throw new Error("Injected finalize acknowledgement loss");
      for (const id of tabs.keys()) if (!params.keep.some(item => item.tabId === id)) tabs.delete(id);
      return { controlEpoch: 42, nextTurnId: "done", endedTurnId: params.turn_id, lifecycleVersion: 1 };
    }
    throw new Error(`Unexpected public method ${method}`);
  }
  const scope = { session_id: key, turn_id: `research-${key}`, control_epoch: control.controlEpoch };
  const typedAction = async (id, name, steps, args = {}) => (await call("browserAction", { ...scope, tabId: id, action: name, locator: steps, args })).value;
  function locator(id, steps = []) {
    const result = {
      locator: selector => locator(id, [...steps, { kind: "css", selector }]),
      frameLocator: selector => locator(id, [...steps, { kind: "frame", selector }]),
      getByRole: (role, options) => locator(id, [...steps, { kind: "role", role, ...options }]),
    };
    for (const name of ["innerText", "click", "count"]) result[name] = () => typedAction(id, name, steps);
    result.fill = value => typedAction(id, "fill", steps, { value });
    result.selectOption = values => typedAction(id, "selectOption", steps, { values });
    result.getAttribute = name => typedAction(id, "getAttribute", steps, { name });
    result.waitFor = args => typedAction(id, "waitFor", steps, args);
    return result;
  }
  return { calls, tabs, get submitCount() { return submitCount; },
    async connect() {
      return { client: {
        turnId: scope.turn_id, controlEpoch: scope.control_epoch,
        beginTurn: () => call("getControlState", scope),
        getTabs: () => call("getTabs", scope),
        finalizeTabs: keep => call("finalizeTabs", { ...scope, keep }),
      },
      newTab: () => call("createTab", scope),
      tab: id => ({ playwright: locator(id), goto: url => typedAction(id, "goto", [], { url }), screenshot: () => typedAction(id, "screenshot", []) }),
      close() {},
      };
    },
    async subprocess(_executable, args) { return JSON.stringify({ result: await call(args[args.indexOf("--method") + 1], JSON.parse(args[args.indexOf("--params") + 1])) }); },
    async withMCPClient(_executable, _endpoint, sessionId, use) { assert.equal(sessionId, key); return use(call); },
  };
}

for (const [kind, variant] of [["js", 1], ["js", 2], ["js", 3], ["cli", 1], ["mcp", 3]]) {
  test(`${kind} v${variant} completes the public lifecycle without borrowed browser setup or cleanup`, async () => {
    const browser = publicBrowser({ variant });
    const detail = await checkResearchWorkflow({ kind, variant, key: "test", fixtureURL: "http://127.0.0.1:8000", endpoint: "fixture-pipe", executable: "fixture-cli",
      connectOpenBrowserUse: kind === "js" ? browser.connect : () => assert.fail("A wire caller must never connect a JS SDK helper"),
      subprocess: kind === "cli" ? browser.subprocess : () => assert.fail("Unexpected CLI transport"),
      withMCPClient: kind === "mcp" ? browser.withMCPClient : () => assert.fail("Unexpected MCP transport"),
    });
    assert.equal(detail.report.selection, "a"); assert.equal(detail.observations.length, 3);
    assert.equal(browser.submitCount, 1); assert.equal(detail.createdTabIds.length, 5);
    assert.deepEqual([...browser.tabs.keys()], detail.keptTabIds);
    assert.equal(detail.closedTabIds.length, 4); assert.ok(detail.trace.every(item => item.passed));
    assert.equal(browser.calls.at(-1).method, "finalizeTabs");
    assert.equal(browser.calls.filter(item => item.method === "createTab").length, 5);
    assert.ok(detail.trace.every(item => item.transport === (kind === "js" ? "JS SDK" : kind.toUpperCase())));
  });
}

test("an uncertain submit is not replayed and cleanup uses the same CLI entrypoint", async () => {
  const browser = publicBrowser({ failAction: "click" });
  await assert.rejects(() => checkResearchWorkflow({ kind: "cli", variant: 1, key: "test", fixtureURL: "http://127.0.0.1:8000", executable: "fixture-cli", endpoint: "fixture-pipe", subprocess: browser.subprocess,
    connectOpenBrowserUse: () => assert.fail("Unexpected SDK fallback") }), error => {
    assert.match(error.message, /Injected click/); assert.equal(error.researchWorkflow.closedTabIds.length, 5); return true;
  });
  assert.equal(browser.calls.filter(item => item.method === "browserAction" && item.params.action === "click").length, 1);
  assert.equal(browser.calls.at(-1).method, "finalizeTabs"); assert.equal(browser.tabs.size, 0);
});

test("an uncertain deliverable finalization never causes a second destructive finalize", async () => {
  const browser = publicBrowser({ failFinalize: true });
  await assert.rejects(() => checkResearchWorkflow({ kind: "mcp", variant: 1, key: "test", fixtureURL: "http://127.0.0.1:8000", executable: "fixture-cli", endpoint: "fixture-pipe", withMCPClient: browser.withMCPClient }), /finalize acknowledgement loss/);
  const endings = browser.calls.filter(item => item.method === "finalizeTabs");
  assert.equal(endings.length, 1); assert.equal(endings[0].params.keep[0].status, "deliverable");
  assert.equal(browser.submitCount, 1);
});
