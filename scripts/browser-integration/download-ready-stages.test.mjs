import assert from "node:assert/strict";
import test from "node:test";
import { checkDownloadReady, downloadVariants } from "./download-waits-fixture.mjs";

// These finite peers test caller sequencing and evidence retention only. Their
// values are deliberately synthetic; they make no claim about browser effects.
function readyPeers({ failures = {} } = {}) {
  const events = [], tabs = new Map(), scope = { session_id: "stage-session", turn_id: "original-turn", control_epoch: 7 };
  let created = 0;
  const record = (variant, operation, args) => {
    events.push({ variant, operation, ...(args === undefined ? {} : { args }) });
    const error = failures[`${variant}:${operation}`];
    if (error) throw error;
  };
  const client = () => ({ sessionId: scope.session_id, turnId: scope.turn_id, controlEpoch: scope.control_epoch });
  const target = (variant, frame) => ({
    getByRole(role, options) {
      assert.equal(options.exact, true);
      const add = role === "button" && options.name === "Add download frame";
      assert.ok(add || (role === "link" && options.name === "Download fixture"));
      if (add) { assert.equal(variant, "dynamic-oopif"); assert.equal(frame, false); }
      else assert.equal(frame, variant !== "root", "Download must target the original variant's frame");
      return { async click(args) { record(variant, add ? "add-frame" : "click", args); } };
    },
    locator(selector) {
      assert.equal(selector, "#evidence");
      return { async textContent() { record(variant, "page"); return JSON.stringify({ clicks: [{ trusted: true, sequence: 1 }] }); } };
    },
    frameLocator(selector) {
      assert.equal(frame, false); assert.notEqual(variant, "root"); assert.equal(selector, "#download-frame");
      record(variant, "frame-locator", selector); return target(variant, true);
    }
  });
  const owner = {
    client: { ...client(), async getInfo() { record(null, "info"); return { metadata: { downloadWaitVersion: 1 } }; } },
    async newTab() {
      assert.ok(created < downloadVariants.length, "Unexpected additional tab or retry");
      const variant = downloadVariants[created++], id = 40 + created;
      record(variant, "new-tab", id); tabs.set(id, variant);
      const download = {
        downloadId: `synthetic-${variant}`,
        async path(options) { record(variant, "path", options); throw new Error("OBU_DOWNLOAD_PATH_UNAVAILABLE"); }
      };
      const wait = {
        waiterId: `wait-${variant}`, remainingMs: 9999,
        async result() { record(variant, "collect"); return download; },
        async cancel() { record(variant, "cancel"); }
      };
      return {
        id,
        async expectDownload(options) { record(variant, "arm", options); return wait; },
        async evaluate(expression) {
          assert.equal(variant, "dynamic-oopif"); assert.equal(expression, "downloadEvidence.frameAdds");
          record(variant, "frame-adds"); return [{ trusted: true }];
        }
      };
    },
    cdp: { async navigate(tabId, url) {
      const variant = tabs.get(tabId); assert.ok(variant); record(variant, "navigate", { tabId, url });
    } }
  };
  const trigger = {
    client: client(),
    tab(id) { const variant = tabs.get(id); assert.ok(variant); record(variant, "trigger-tab", id); return target(variant, false); }
  };
  const diagnostic = {
    async start({ owner: actual, item }) {
      assert.equal(actual, owner); assert.deepEqual(item.scope, scope);
      assert.equal(item.waiterId, undefined); assert.equal(item.stages, undefined);
      record(item.variant, "diagnostic-start", item);
    },
    async failure({ owner: actual, item }) {
      assert.equal(actual, owner); assert.deepEqual(item.scope, scope);
      record(item.variant, "diagnostic-failure", structuredClone(item));
    },
    async finish({ item }) { record(item.variant, "diagnostic-finish", structuredClone(item)); }
  };
  return { owner, trigger, diagnostic, scope, events,
    run(withDiagnostic = false) {
      return checkDownloadReady({ owner, trigger, fixtureURL: "http://fixture.invalid/", prefix: "stages", ...(withDiagnostic ? { diagnostic } : {}) });
    }
  };
}

function operations(peers, variant) { return peers.events.filter(event => event.variant === variant).map(event => event.operation); }
function successfulOperations(variant) {
  return ["new-tab", "navigate", "trigger-tab", ...(variant === "root" ? [] : ["frame-locator"]), "arm",
    ...(variant === "dynamic-oopif" ? ["add-frame"] : []), "click", "collect", "path", "page",
    ...(variant === "dynamic-oopif" ? ["frame-adds"] : []), "cancel"];
}
function stageSequence(variant) { return ["arm", ...(variant === "dynamic-oopif" ? ["add-frame"] : []), "click", "collect", "verify", "cancel"]; }
function checkCompleted(stage) {
  assert.ok(Number.isFinite(stage.startedAt)); assert.ok(Number.isFinite(stage.completedAt)); assert.ok(stage.completedAt >= stage.startedAt);
  assert.equal(stage.failedAt, undefined); assert.equal(stage.error, undefined);
}
async function rejectedDetail(peers, expected, diagnostic = true) {
  await assert.rejects(peers.run(diagnostic), error => error === expected, "The original error object must survive diagnostic and cleanup failures");
  const detail = expected.downloadDetail;
  assert.equal(detail.caller, "js"); assert.equal(detail.independentConnections, true); assert.equal(detail.variants.length, 1);
  assert.deepEqual(detail.variants[0].scope, peers.scope);
  assert.equal(detail.variants[0].variant, "root"); assert.equal(detail.variants[0].key, "stages-root");
  return detail.variants[0];
}

test("default download ready preserves all three single-action variants and original budgets without diagnostic stages", async () => {
  const peers = readyPeers(), detail = await peers.run();
  assert.notEqual(peers.owner.client, peers.trigger.client);
  assert.deepEqual(detail.variants.map(item => item.variant), downloadVariants);
  assert.equal(peers.events.filter(event => event.operation === "info").length, 1);
  assert.ok(peers.events.every(event => !event.operation.startsWith("diagnostic-")));
  for (const [index, item] of detail.variants.entries()) {
    assert.deepEqual(operations(peers, item.variant), successfulOperations(item.variant));
    assert.deepEqual(item.scope, peers.scope); assert.equal(item.tabId, 41 + index); assert.equal(item.stages, undefined);
    assert.equal(item.diagnosticFailureError, undefined); assert.equal(item.diagnosticFinishError, undefined);
    assert.equal(item.waiterId, `wait-${item.variant}`); assert.deepEqual(item.result, { downloadId: `synthetic-${item.variant}` });
    assert.ok(item.readyAt <= item.triggerSubmittedAt && item.triggerSubmittedAt <= item.collectedAt);
    const events = peers.events.filter(event => event.variant === item.variant);
    assert.deepEqual(events.find(event => event.operation === "arm").args, { timeoutMs: 10000 });
    assert.deepEqual(events.find(event => event.operation === "click").args, { timeoutMs: 5000 });
    assert.deepEqual(events.find(event => event.operation === "path").args, { timeoutMs: 1000 });
    assert.equal(events.find(event => event.operation === "navigate").args.url,
      `http://fixture.invalid/download-waits/page?key=stages-${item.variant}&variant=${item.variant}`);
    if (item.variant === "dynamic-oopif") assert.equal(events.find(event => event.operation === "add-frame").args, undefined);
  }
});

test("diagnostic setup precedes arm and finish follows cancel for each unchanged variant", async () => {
  const peers = readyPeers(), detail = await peers.run(true);
  for (const item of detail.variants) {
    const expected = successfulOperations(item.variant); expected.splice(expected.indexOf("arm"), 0, "diagnostic-start"); expected.push("diagnostic-finish");
    assert.deepEqual(operations(peers, item.variant), expected);
    assert.deepEqual(peers.events.find(event => event.variant === item.variant && event.operation === "arm").args, { timeoutMs: 10000 });
    assert.deepEqual(peers.events.find(event => event.variant === item.variant && event.operation === "click").args, { timeoutMs: 5000 });
    assert.deepEqual(item.stages.map(stage => stage.name), stageSequence(item.variant));
    for (const stage of item.stages) checkCompleted(stage);
    for (let index = 1; index < item.stages.length; index++) assert.ok(item.stages[index].startedAt >= item.stages[index - 1].completedAt);
    assert.equal(peers.events.find(event => event.variant === item.variant && event.operation === "diagnostic-start").args, item);
  }
});

for (const failurePhase of ["click", "collect"]) test(`download diagnostic distinguishes ${failurePhase} failure without replaying preceding work`, async () => {
  const business = new Error(failurePhase === "collect" ? "OBU_DOWNLOAD_WAIT_TIMEOUT: original deadline elapsed" : "original click failed");
  const peers = readyPeers({ failures: { [`root:${failurePhase}`]: business } }), item = await rejectedDetail(peers, business);
  const expected = ["new-tab", "navigate", "trigger-tab", "diagnostic-start", "arm", "click",
    ...(failurePhase === "collect" ? ["collect"] : []), "diagnostic-failure", "cancel", "diagnostic-finish"];
  assert.deepEqual(operations(peers, "root"), expected);
  assert.deepEqual(item.stages.map(stage => stage.name), ["arm", "click", ...(failurePhase === "collect" ? ["collect"] : []), "cancel"]);
  checkCompleted(item.stages[0]); checkCompleted(item.stages.at(-1));
  if (failurePhase === "collect") checkCompleted(item.stages[1]);
  const failed = item.stages.find(stage => stage.name === failurePhase);
  assert.equal(failed.completedAt, undefined); assert.ok(failed.failedAt >= failed.startedAt); assert.equal(failed.error, String(business));
  assert.equal(item.result, undefined); assert.equal(item.collectedAt, undefined);
  const captured = peers.events.find(event => event.operation === "diagnostic-failure").args;
  assert.deepEqual(captured.stages.map(stage => stage.name), item.stages.slice(0, -1).map(stage => stage.name));
});

test("business and cancellation errors are both retained and finish cannot replace the original business exception", async () => {
  const business = new Error("original collect deadline"), cancellation = new Error("cleanup transport failed");
  const peers = readyPeers({ failures: { "root:collect": business, "root:cancel": cancellation } });
  const item = await rejectedDetail(peers, business);
  assert.equal(item.cancelError, String(cancellation));
  assert.equal(item.stages.at(-1).name, "cancel"); assert.equal(item.stages.at(-1).error, String(cancellation));
  assert.equal(item.stages.at(-1).completedAt, undefined);
  assert.deepEqual(operations(peers, "root").slice(-3), ["diagnostic-failure", "cancel", "diagnostic-finish"]);
  assert.equal(peers.events.filter(event => event.operation === "diagnostic-failure").length, 1);
});

test("arm failure retains its original scope and phase without cancelling an undefined handle", async () => {
  const business = new Error("arm original deadline");
  const peers = readyPeers({ failures: { "root:arm": business } }), item = await rejectedDetail(peers, business);
  assert.deepEqual(operations(peers, "root"), ["new-tab", "navigate", "trigger-tab", "diagnostic-start", "arm", "diagnostic-failure", "diagnostic-finish"]);
  assert.deepEqual(item.stages.map(stage => stage.name), ["arm"]);
  assert.equal(item.stages[0].error, String(business)); assert.equal(item.stages[0].completedAt, undefined);
  assert.equal(item.waiterId, undefined); assert.equal(item.readyAt, undefined); assert.equal(item.triggerSubmittedAt, undefined);
});

test("failure and finish diagnostic errors remain separate fields and do not swallow business or cancel errors", async () => {
  const business = new Error("collect original timeout"), cancellation = new Error("cancel failed"), observation = new Error("failure snapshot failed"), finish = new Error("trace restore failed");
  const peers = readyPeers({ failures: { "root:collect": business, "root:cancel": cancellation, "root:diagnostic-failure": observation, "root:diagnostic-finish": finish } });
  const item = await rejectedDetail(peers, business);
  assert.equal(item.cancelError, String(cancellation)); assert.equal(item.diagnosticFailureError, String(observation)); assert.equal(item.diagnosticFinishError, String(finish));
  assert.deepEqual(operations(peers, "root").slice(-3), ["diagnostic-failure", "cancel", "diagnostic-finish"]);
  for (const name of ["click", "collect", "cancel", "diagnostic-failure", "diagnostic-finish"]) assert.equal(operations(peers, "root").filter(value => value === name).length, 1);
});

test("failed diagnostic start still reaches once-only failure and finish without arm or cancellation", async () => {
  const setup = new Error("trace setup rejected");
  const peers = readyPeers({ failures: { "root:diagnostic-start": setup } }), item = await rejectedDetail(peers, setup);
  assert.deepEqual(operations(peers, "root"), ["new-tab", "navigate", "trigger-tab", "diagnostic-start", "diagnostic-failure", "diagnostic-finish"]);
  assert.equal(item.stages, undefined); assert.equal(item.waiterId, undefined);
});

test("cancel-only failure is reported after successful work and diagnostic finish still executes", async () => {
  const cancellation = new Error("cancel original failure");
  const peers = readyPeers({ failures: { "root:cancel": cancellation } }), item = await rejectedDetail(peers, cancellation);
  assert.deepEqual(item.result, { downloadId: "synthetic-root" }); assert.equal(item.cancelError, String(cancellation));
  assert.equal(peers.events.some(event => event.operation === "diagnostic-failure"), false, "A late cleanup error must not be described as a pre-cancel business observation");
  assert.deepEqual(operations(peers, "root").slice(-2), ["cancel", "diagnostic-finish"]);
  for (const stage of item.stages.slice(0, -1)) checkCompleted(stage);
});

test("default caller also preserves the business exception when cancellation fails, without diagnostic fields", async () => {
  const business = new Error("collect without diagnostics failed"), cancellation = new Error("cancel without diagnostics failed");
  const peers = readyPeers({ failures: { "root:collect": business, "root:cancel": cancellation } }), item = await rejectedDetail(peers, business, false);
  assert.equal(item.stages, undefined); assert.equal(item.cancelError, String(cancellation));
  assert.equal(item.diagnosticFailureError, undefined); assert.equal(item.diagnosticFinishError, undefined);
  assert.deepEqual(operations(peers, "root"), ["new-tab", "navigate", "trigger-tab", "arm", "click", "collect", "cancel"]);
});
