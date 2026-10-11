import assert from "node:assert/strict";
import {
  chooserVariants, chooserPageURL, chooserScope, chooserFrameEvidence, checkChooserReceipts
} from "./chooser-waits-fixture.mjs";

const consumed = /OBU_FILE_CHOOSER_CONSUMED\b|Unknown or unowned file chooser id/;
const errorRecord = error => ({ name: error?.name ?? "Error", message: String(error?.message ?? error), stack: error?.stack });

export function checkChooserSubmissionOutcomes(outcomes, { repeated = false } = {}) {
  assert.equal(outcomes.length, 2);
  assert.deepEqual(outcomes.map(value => value.connection), ["owner", "trigger"]);
  assert.ok(outcomes.every(value => ["fulfilled", "rejected"].includes(value.status)));
  assert.equal(outcomes.filter(value => value.status === "fulfilled").length, repeated ? 0 : 1,
    repeated ? "A consumed chooser accepted a repeated submission" : "Exactly one independent connection must consume the chooser");
  for (const value of outcomes.filter(value => value.status === "rejected"))
    assert.match(value.error?.message ?? "", consumed, "Only an already consumed/unowned chooser rejection proves single consumption");
  return outcomes;
}

// Both public calls are issued before awaiting either. There is no client-side
// winner lock, retry, injected command, or change to the original file payload.
async function submitPair(owner, trigger, fileChooserId, files, record) {
  const pending = [owner, trigger].map((browser, index) => {
    const call = { connection: index === 0 ? "owner" : "trigger", fileChooserId, files: [...files], submittedAt: Date.now() };
    record.push(call);
    try { return Promise.resolve(browser.client.setFileChooserFiles(fileChooserId, [...files])); }
    catch (error) { return Promise.reject(error); }
  });
  const results = await Promise.allSettled(pending.map((promise, index) => promise.finally(() => { record[index].completedAt = Date.now(); })));
  for (const [index, result] of results.entries()) Object.assign(record[index], result.status === "fulfilled"
    ? { status: result.status, value: result.value ?? null }
    : { status: result.status, error: errorRecord(result.reason) });
  return record;
}

function documentURL(fixtureURL, key, variant) {
  const url = new URL(chooserPageURL(fixtureURL, key, variant));
  if (variant !== "root") { url.hostname = "localhost"; url.pathname = "/chooser-waits/frame"; }
  return url.href;
}

function observedTarget(frames, tabId, expectedURL, variant) {
  if (variant === "root") return { tabId };
  const targets = frames.targets.filter(value => value.url === expectedURL && value.attached === true);
  assert.equal(targets.length, 1, "Exactly one live chooser child target must match its current URL");
  const attachments = frames.attachedTargets.filter(value => value.tabId === tabId && value.source?.tabId === tabId &&
    value.source.sessionId === undefined && value.type === "iframe" && value.targetId === targets[0].id && typeof value.sessionId === "string" && value.sessionId);
  assert.equal(attachments.length, 1, "Chooser child must have one exact observed native root attachment");
  const root = frames.frames.find(value => value.frameId === 0);
  const children = frames.frames.filter(value => value.parentFrameId === 0 && value.url === expectedURL);
  assert.equal(children.length, 1); assert.ok(root && children[0].processId !== root.processId, "Chooser must be a real out-of-process iframe");
  return { tabId, sessionId: attachments[0].sessionId };
}

async function readDocument(owner, scope, target) {
  const response = await owner.client.request("executeCdp", { ...scope, target, method: "Runtime.evaluate", commandParams: {
    expression: "(()=>{const input=document.querySelector('#upload');return{href:location.href,chooserEvidence:globalThis.chooserEvidence??null,input:input?{tag:input.tagName,type:input.type,id:input.id,files:[...input.files].map(file=>({name:file.name,size:file.size}))}:null}})()",
    returnByValue: true, awaitPromise: false
  }, timeoutMs: 5000 }, { timeoutMs: 5000 });
  assert.equal(response?.exceptionDetails, undefined, "Current chooser document observation threw");
  assert.ok(response?.result?.value, "Current chooser document observation is missing");
  return response.result.value;
}

export function checkChooserSubmissionDocument(value, { expectedURL, sequence, selectedFiles, documentToken, before = false }) {
  assert.equal(value.href, expectedURL);
  const evidence = value.chooserEvidence;
  assert.equal(typeof evidence?.documentToken, "string"); assert.ok(evidence.documentToken.length > 0);
  if (documentToken !== undefined) assert.equal(evidence.documentToken, documentToken, "Chooser submission changed its original document");
  assert.deepEqual(evidence.clicks, Array.from({ length: sequence }, () => ({ trusted: true })));
  const changeCount = sequence - Number(before);
  assert.deepEqual(evidence.changes, [
    ...(changeCount >= 1 ? [{ trusted: true, count: selectedFiles.length }] : []),
    ...(changeCount >= 2 ? [{ trusted: false, count: 0 }] : [])
  ], "A consumed/repeated chooser must not dispatch another change");
  assert.deepEqual(evidence.frameAdds, []);
  assert.deepEqual(value.input, { tag: "INPUT", type: "file", id: "upload", files: changeCount === 1
    ? selectedFiles.map(({ name, size }) => ({ name, size })) : [] });
  return value;
}

export async function checkChooserSubmission({ owner, trigger, fixtureURL, server, files, worker, until }) {
  const detail = { caller: "js", independentConnections: true, variants: [] };
  try {
    assert.notEqual(owner.client, trigger.client, "Two independent SDK connections are required");
    assert.equal((await owner.client.getInfo()).metadata.fileChooserWaitVersion, 1);
    assert.equal(owner.client.sessionId, trigger.client.sessionId); assert.equal(owner.client.turnId, trigger.client.turnId);
    for (const variant of chooserVariants) {
      const key = `js-chooser-submission-${variant}`, item = { key, variant, waits: [] }; detail.variants.push(item);
      let failure;
      try {
        const tab = await owner.newTab(); item.tabId = tab.id;
        await owner.cdp.navigate(tab.id, chooserPageURL(fixtureURL, key, variant));
        const sender = trigger.tab(tab.id), input = (variant === "root" ? sender : sender.frameLocator("#upload-frame")).getByLabel("Upload fixture", { exact: true });
        const selectedFiles = variant === "root" ? files.slice(0, 1) : files;
        const expectedURL = documentURL(fixtureURL, key, variant);
        for (const sequence of [1, 2]) {
          const round = { sequence, armStartedAt: Date.now(), submissions: [], repeats: [] }; item.waits.push(round);
          let wait, roundFailure;
          try {
            wait = await tab.expectFileChooser({ timeoutMs: 10000 });
            Object.assign(round, { waiterId: wait.waiterId, remainingMs: wait.remainingMs, readyAt: Date.now() });
            assert.ok(wait.waiterId && wait.remainingMs > 0);
            if (variant === "dynamic-oopif" && sequence === 1) {
              round.addFrameSubmittedAt = Date.now(); await sender.getByRole("button", { name: "Add upload frame", exact: true }).click(); round.addFrameCompletedAt = Date.now();
            }
            round.triggerSubmittedAt = Date.now(); await input.click({ timeoutMs: 5000 }); round.triggerCompletedAt = Date.now();
            round.collectSubmittedAt = Date.now(); round.result = await wait.result(); round.collectedAt = Date.now();
            assert.equal(round.result.isMultiple, variant !== "root"); assert.equal(typeof round.result.fileChooserId, "string"); assert.ok(round.result.fileChooserId);
            const scope = chooserScope(owner); assert.deepEqual(chooserScope(trigger), scope);
            if (item.scope) assert.deepEqual(scope, item.scope); else item.scope = scope;
            round.frames = await chooserFrameEvidence(worker, tab.id, key, variant);
            round.target = observedTarget(round.frames, tab.id, expectedURL, variant);
            if (item.target) assert.deepEqual(round.target, item.target, "Upload/clear changed native chooser target"); else item.target = round.target;
            const expected = { expectedURL, sequence, selectedFiles, documentToken: item.documentToken };
            round.before = await readDocument(owner, item.scope, item.target);
            checkChooserSubmissionDocument(round.before, { ...expected, before: true });
            item.documentToken ??= round.before.chooserEvidence.documentToken; expected.documentToken = item.documentToken;
            const paths = sequence === 1 ? selectedFiles.map(file => file.path) : [];
            await submitPair(owner, trigger, round.result.fileChooserId, paths, round.submissions);
            checkChooserSubmissionOutcomes(round.submissions);
            await until(() => {
              const record = server.stats(key); assert.ok(record.posts.length <= sequence, "A chooser dispatched duplicate POSTs");
              return record.posts.length === sequence && record.posts.at(-1).receipt;
            }, "single consumed chooser upload/clear receipt");
            round.serverAfterSubmission = server.stats(key);
            round.afterSubmission = await readDocument(owner, item.scope, item.target);
            checkChooserSubmissionDocument(round.afterSubmission, expected);
            await submitPair(owner, trigger, round.result.fileChooserId, paths, round.repeats);
            checkChooserSubmissionOutcomes(round.repeats, { repeated: true });
            round.afterRepeats = await readDocument(owner, item.scope, item.target);
            checkChooserSubmissionDocument(round.afterRepeats, expected);
            round.serverAfterRepeats = server.stats(key);
            assert.deepEqual(round.serverAfterRepeats, round.serverAfterSubmission, "Rejected repeats changed the original HTTP witness");
            assert.deepEqual(chooserScope(owner), item.scope); assert.deepEqual(chooserScope(trigger), item.scope);
          } catch (error) { roundFailure = error; round.error = errorRecord(error); throw error; }
          finally {
            if (wait) {
              round.cancelSubmittedAt = Date.now();
              try { await wait.cancel(); round.cancelCompletedAt = Date.now(); }
              catch (error) { round.cancelError = errorRecord(error); if (!roundFailure) throw error; }
            }
          }
        }
        assert.notEqual(item.waits[0].result.fileChooserId, item.waits[1].result.fileChooserId);
        item.server = checkChooserReceipts(server.stats(key), files, variant);
        assert.equal(item.server.posts[0].documentToken, item.documentToken);
        item.frames = await chooserFrameEvidence(worker, tab.id, key, variant);
        assert.deepEqual(observedTarget(item.frames, tab.id, expectedURL, variant), item.target);
        if (variant === "dynamic-oopif") { item.frameAdds = await tab.evaluate("chooserEvidence.frameAdds"); assert.deepEqual(item.frameAdds, [{ trusted: true }]); }
        item.passed = true;
      } catch (error) { failure = error; item.error = errorRecord(error); throw error; }
      finally {
        try { item.serverAtEnd = server.stats(key); if (!failure) checkChooserReceipts(item.serverAtEnd, files, variant); }
        catch (error) { item.serverReadError = errorRecord(error); if (!failure) throw error; }
      }
    }
    return detail;
  } catch (error) { error.chooserDetail = detail; throw error; }
}
