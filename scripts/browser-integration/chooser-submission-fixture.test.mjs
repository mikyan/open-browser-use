import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { createChooserWaitFixtures } from "./chooser-waits-fixture.mjs";
import { checkChooserSubmission, checkChooserSubmissionDocument, checkChooserSubmissionOutcomes } from "./chooser-submission-fixture.mjs";

const bytes = [Buffer.from("fixture 中文🙂\0\n"), Buffer.from([0, 1, 127, 128, 254, 255])];
const files = bytes.map((value, index) => ({ path: `/unit/file-${index}`, name: `file-${index}`, size: value.length, sha256: createHash("sha256").update(value).digest("hex") }));
const rejected = message => ({ status: "rejected", error: { message } });
const outcomes = (a, b) => [{ connection: "owner", ...a }, { connection: "trigger", ...b }];

test("submission outcomes require one success and only consumed/unowned rejections, then two rejections", () => {
  for (const message of ["OBU_FILE_CHOOSER_CONSUMED: already submitted", "Unknown or unowned file chooser id"]) {
    checkChooserSubmissionOutcomes(outcomes({ status: "fulfilled" }, rejected(message)));
    checkChooserSubmissionOutcomes(outcomes(rejected(message), { status: "fulfilled" }));
    checkChooserSubmissionOutcomes(outcomes(rejected(message), rejected(message)), { repeated: true });
  }
  for (const pair of [outcomes({ status: "fulfilled" }, { status: "fulfilled" }), outcomes(rejected("Unknown or unowned file chooser id"), rejected("Unknown or unowned file chooser id")),
    outcomes({ status: "fulfilled" }, rejected("OBU_STALE_CONTROL_EPOCH")), outcomes({ status: "fulfilled" }, rejected("native timeout")), outcomes({ status: "fulfilled" }, { status: "pending" })])
    assert.throws(() => checkChooserSubmissionOutcomes(pair));
  assert.throws(() => checkChooserSubmissionOutcomes(outcomes({ status: "fulfilled" }, rejected("Unknown or unowned file chooser id")), { repeated: true }));
});

function document(sequence, { before = false } = {}) {
  const count = sequence - Number(before);
  return { href: "http://localhost:1234/chooser-waits/frame?key=unit&variant=oopif", chooserEvidence: {
    documentToken: "original-document", clicks: Array.from({ length: sequence }, () => ({ trusted: true })),
    changes: [...(count >= 1 ? [{ trusted: true, count: files.length }] : []), ...(count === 2 ? [{ trusted: false, count: 0 }] : [])], frameAdds: []
  }, input: { tag: "INPUT", type: "file", id: "upload", files: count === 1 ? files.map(({ name, size }) => ({ name, size })) : [] } };
}

test("document witness rejects duplicate changes, clicks, file residue and replaced documents", () => {
  for (const sequence of [1, 2]) for (const before of [true, false]) {
    const value = document(sequence, { before });
    checkChooserSubmissionDocument(value, { expectedURL: value.href, sequence, selectedFiles: files, documentToken: "original-document", before });
  }
  for (const mutate of [
    value => value.chooserEvidence.changes.push({ trusted: false, count: 0 }),
    value => value.chooserEvidence.clicks.push({ trusted: true }),
    value => { value.chooserEvidence.changes[0].trusted = false; },
    value => { value.chooserEvidence.documentToken = "replacement"; },
    value => { value.input.files = [files[0]]; },
    value => { value.href += "-different"; }
  ]) {
    const value = document(2), expectedURL = value.href; mutate(value);
    assert.throws(() => checkChooserSubmissionDocument(value, { expectedURL, sequence: 2, selectedFiles: files, documentToken: "original-document" }));
  }
});

function post(url, value) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: "POST", agent: false, headers: { "content-type": "application/json" } }, response => {
      const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.once("error", reject); response.once("aborted", () => reject(new Error("Unit upload aborted")));
      response.once("end", () => { clearTimeout(timer); try { assert.equal(response.statusCode, 200); resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); } });
    });
    const timer = setTimeout(() => request.destroy(new Error("Unit upload deadline")), 2000);
    request.once("error", error => { clearTimeout(timer); reject(error); }); request.end(JSON.stringify(value));
  });
}

// These are orchestration and actual HTTP byte tests, not browser acceptance.
// The two controlled clients cannot settle a new ID until both calls start.
async function harness(run, options = {}) {
  const fixture = createChooserWaitFixtures(), states = new Map(), choosers = new Map(), log = [];
  const httpServer = http.createServer((request, response) => {
    if (!fixture.handle(request, response, httpServer.address().port)) { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { httpServer.once("error", reject); httpServer.listen(0, "127.0.0.1", resolve); });
  const fixtureURL = `http://127.0.0.1:${httpServer.address().port}/`, scope = { sessionId: "unit-chooser", turnId: "original-turn", controlEpoch: 7 };
  let nextTab = 100, nextChooser = 1;
  function snapshot(state) {
    return structuredClone({ href: state.href, chooserEvidence: state.evidence, input: { tag: "INPUT", type: "file", id: "upload", files: state.selected.map(({ name, size }) => ({ name, size })) } });
  }
  async function upload(state, paths) {
    const selected = paths.map(filename => files.find(file => file.path === filename));
    assert.ok(selected.every(Boolean)); state.selected = selected;
    state.evidence.changes.push({ trusted: selected.length > 0, count: selected.length });
    if (options.changedDocument) state.evidence.documentToken = "changed-document";
    const value = { key: state.key, variant: state.variant, sequence: state.evidence.changes.length,
      href: state.href, ...structuredClone(state.evidence), files: selected.map(file => {
        const data = options.wrongBytes ? Buffer.alloc(file.size, 1) : bytes[files.indexOf(file)];
        return { name: file.name, size: data.length, base64: data.toString("base64") };
      }) };
    await post(`${fixtureURL}chooser-waits/upload?key=${state.key}&variant=${state.variant}`, value);
  }
  function client(connection) {
    return { ...scope,
      getInfo: async () => ({ metadata: { fileChooserWaitVersion: 1 } }),
      async request(method, params, transport) {
        assert.equal(method, "executeCdp"); assert.equal(params.method, "Runtime.evaluate");
        assert.deepEqual({ session_id: params.session_id, turn_id: params.turn_id, control_epoch: params.control_epoch }, { session_id: scope.sessionId, turn_id: scope.turnId, control_epoch: scope.controlEpoch });
        assert.equal(params.timeoutMs, 5000); assert.equal(transport.timeoutMs, 5000);
        assert.equal(params.commandParams.awaitPromise, false); assert.equal(params.commandParams.returnByValue, true);
        const state = states.get(params.target.tabId);
        assert.deepEqual(params.target, state.variant === "root" ? { tabId: state.tabId } : { tabId: state.tabId, sessionId: `child-${state.tabId}` });
        log.push({ kind: "read", tabId: state.tabId });
        return { result: { value: snapshot(state) } };
      },
      setFileChooserFiles(id, paths) {
        const chooser = choosers.get(id); assert.ok(chooser);
        log.push({ kind: "submit", id, connection, paths: [...paths] });
        if (chooser.consumed) {
          if (options.repeatChanges) chooser.state.evidence.changes.push({ trusted: false, count: 0 });
          return Promise.reject(new Error("Unknown or unowned file chooser id"));
        }
        return new Promise((resolve, reject) => {
          chooser.pending.push({ connection, paths, resolve, reject });
          if (chooser.pending.length !== 2) return;
          chooser.consumed = true;
          const winningConnection = chooser.sequence === 1 ? "owner" : "trigger";
          const winner = chooser.pending.find(item => item.connection === winningConnection);
          void upload(chooser.state, winner.paths).then(() => {
            log.push({ kind: "settled", id });
            for (const item of chooser.pending) {
              if (item === winner || options.doubleSuccess) item.resolve({});
              else item.reject(new Error(options.wrongRejection ? "OBU_STALE_CONTROL_EPOCH" : "OBU_FILE_CHOOSER_CONSUMED: already submitted"));
            }
          }, error => { for (const item of chooser.pending) item.reject(error); });
        });
      }
    };
  }
  const owner = { client: client("owner"),
    async newTab() {
      const tabId = nextTab++, state = { tabId, selected: [], evidence: { documentToken: `document-${tabId}`, clicks: [], changes: [], frameAdds: [] } }; states.set(tabId, state);
      return { id: tabId,
        async expectFileChooser({ timeoutMs }) {
          assert.equal(timeoutMs, 10000);
          const id = `chooser-${nextChooser++}`, chooser = { state, sequence: state.evidence.clicks.length + 1, pending: [] }; choosers.set(id, chooser);
          return { waiterId: `wait-${id}`, remainingMs: 9900,
            result: async () => ({ fileChooserId: id, isMultiple: state.variant !== "root" }),
            async cancel() { log.push({ kind: "cancel", id }); if (options.cancelError) throw options.cancelError; }
          };
        },
        async evaluate(expression) { assert.equal(expression, "chooserEvidence.frameAdds"); return structuredClone(state.rootAdds); }
      };
    },
    cdp: { async navigate(tabId, url) {
      const state = states.get(tabId), parsed = new URL(url); state.key = parsed.searchParams.get("key"); state.variant = parsed.searchParams.get("variant");
      if (state.variant !== "root") { parsed.hostname = "localhost"; parsed.pathname = "/chooser-waits/frame"; }
      state.href = parsed.href; state.rootAdds = []; log.push({ kind: "navigate", tabId });
    } }
  };
  const trigger = { client: client("trigger"), tab(tabId) {
    const state = states.get(tabId), locator = {
      frameLocator(selector) { assert.equal(selector, "#upload-frame"); return this; },
      getByLabel(label, { exact }) { assert.equal(label, "Upload fixture"); assert.equal(exact, true); return this; },
      async click({ timeoutMs }) { assert.equal(timeoutMs, 5000); log.push({ kind: "click", tabId }); if (options.clickError) throw options.clickError; state.evidence.clicks.push({ trusted: true }); },
      getByRole(role, { name, exact }) { assert.equal(role, "button"); assert.equal(name, "Add upload frame"); assert.equal(exact, true); return { async click() { state.rootAdds.push({ trusted: true }); log.push({ kind: "add-frame", tabId }); } }; }
    }; return locator;
  } };
  const worker = { async evaluate(expression) {
    const [, tabText] = expression.match(/getAllFrames\(\{tabId:(\d+)\}\)/) ?? []; assert.ok(tabText, "Only the existing read-only frame evidence is permitted");
    const tabId = Number(tabText), state = states.get(tabId), result = { frames: [{ frameId: 0, processId: 1 }], targets: [], attachedTargets: [] };
    if (state.variant !== "root") {
      result.frames.push({ parentFrameId: 0, processId: options.sameProcess ? 1 : 2, url: state.href });
      result.targets.push({ id: `target-${tabId}`, attached: true, url: state.href });
      result.attachedTargets.push({ tabId, source: { tabId }, type: "iframe", targetId: `target-${tabId}`, sessionId: `child-${tabId}` });
      if (options.ambiguousChild) result.attachedTargets.push({ ...result.attachedTargets[0], sessionId: "other-session" });
    }
    return result;
  } };
  if (options.wrongScope) trigger.client.controlEpoch++;
  try {
    await run({ owner, trigger, fixtureURL, server: fixture, files, worker, until: async callback => { const result = await callback(); assert.ok(result); return result; } }, { log, states, choosers, fixture });
  } finally { httpServer.closeAllConnections(); await new Promise(resolve => httpServer.close(resolve)); }
}

test("three layouts submit upload and clear concurrently on two clients; reject both repeats with original bytes and event counts", () => harness(async (args, evidence) => {
  const result = await checkChooserSubmission(args);
  assert.deepEqual(result.variants.map(item => item.variant), ["root", "oopif", "dynamic-oopif"]);
  assert.ok(result.variants.every(item => item.passed));
  assert.equal(evidence.log.filter(item => item.kind === "click").length, 6);
  assert.equal(evidence.log.filter(item => item.kind === "add-frame").length, 1);
  assert.equal(evidence.log.filter(item => item.kind === "submit").length, 24);
  assert.equal(evidence.log.filter(item => item.kind === "cancel").length, 6);
  for (const [id] of evidence.choosers) {
    const log = evidence.log.filter(item => item.id === id);
    assert.deepEqual(log.slice(0, 3).map(item => item.kind), ["submit", "submit", "settled"], "An awaiting-first-client implementation must not pass");
    assert.deepEqual(log.filter(item => item.kind === "submit").map(item => item.connection), ["owner", "trigger", "owner", "trigger"]);
  }
  assert.deepEqual(result.variants.map(item => item.server.posts.length), [2, 2, 2]);
  assert.deepEqual(result.variants.map(item => item.waits.map(round => round.submissions.find(value => value.status === "fulfilled").connection)), [["owner", "trigger"], ["owner", "trigger"], ["owner", "trigger"]]);
}));

for (const [name, option, message] of [
  ["two successful consumers", "doubleSuccess", /Exactly one/],
  ["a scope rejection instead of consumption", "wrongRejection", /Only an already/],
  ["side effects from rejected repeats", "repeatChanges", /another change/],
  ["uploaded bytes differing from actual fixture bytes", "wrongBytes", /Expected values/],
  ["document replacement during native submission", "changedDocument", /original document/],
  ["ambiguous native child identity", "ambiguousChild", /one exact observed/],
  ["same-process frame masquerading as OOPIF", "sameProcess", /out-of-process/],
  ["connections whose control epochs differ", "wrongScope", /Expected values/]
]) test(`submission orchestration rejects ${name} and retains partial evidence`, () => harness(async args => {
  await assert.rejects(checkChooserSubmission(args), error => {
    assert.match(error.message, message); assert.ok(error.chooserDetail?.variants.length);
    assert.ok(error.chooserDetail.variants.at(-1).serverAtEnd); return true;
  });
}, { [option]: true }));

test("original operation error survives waiter cancellation failure with both errors retained", () => {
  const original = new Error("original click failure"), cleanup = new Error("cancel failure");
  return harness(async (args, { log }) => {
    await assert.rejects(checkChooserSubmission(args), error => {
      assert.equal(error, original);
      const round = error.chooserDetail.variants[0].waits[0];
      assert.equal(round.error.message, original.message); assert.equal(round.cancelError.message, cleanup.message);
      return true;
    });
    assert.equal(log.filter(item => item.kind === "click").length, 1);
    assert.equal(log.filter(item => item.kind === "submit").length, 0);
  }, { clickError: original, cancelError: cleanup });
});

test("pointer opt-in preserves the complete successful submission call sequence and collects no failure DOM", async () => {
  const runs = [];
  for (const pointerEvidence of [false, true]) await harness(async (args, { log }) => {
    const result = await checkChooserSubmission({ ...args, pointerEvidence });
    assert.ok(result.variants.every(item => item.passed && !item.failureObservation));
    runs.push(structuredClone(log));
  });
  assert.deepEqual(runs[1], runs[0]);
});

test("pointer opt-in reaches only the existing once-only failure observation before cancellation", () => {
  const original = new Error("original click timeout"), order = [];
  return harness(async (args, { log }) => {
    args.worker = { evaluate: async expression => { order.push(expression); throw new Error("metadata unavailable"); } };
    await assert.rejects(checkChooserSubmission({ ...args, pointerEvidence: true }), error => {
      assert.equal(error, original);
      const observation = error.chooserDetail.variants[0].failureObservation;
      assert.equal(observation.pointerEvidenceExpected, true); assert.equal(observation.complete, false);
      assert.equal(observation.pointerObservationRequested, false); return true;
    });
    assert.equal(order.length, 1); assert.match(order[0], /chrome.tabs.get/);
    assert.equal(log.filter(item => item.kind === "click").length, 1);
    assert.equal(log.filter(item => item.kind === "cancel").length, 1);
  }, { clickError: original });
});
