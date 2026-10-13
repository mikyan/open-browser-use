import { randomBytes } from "node:crypto";
import { installSiteAccessSaveFault } from "./site-access-save-fault.mjs";

export function createSiteAccessSubmissions() {
  const requests = [];
  return {
    stats: () => structuredClone(requests),
    handle(request, response) {
      if (new URL(request.url, "http://localhost").pathname !== "/site-access-submit") return false;
      if (request.method !== "POST") { response.writeHead(405); response.end(); return true; }
      let body = "", oversize = false;
      request.on("data", chunk => { if (body.length + chunk.length > 4096) oversize = true; else body += chunk; });
      request.on("end", () => {
        if (oversize || requests.length >= 16) { response.writeHead(413); response.end(); return; }
        try { requests.push({ body, bytes: Buffer.byteLength(body), value: JSON.parse(body) }); }
        catch { response.writeHead(400); response.end(); return; }
        response.setHeader("Content-Type", "application/json"); response.end('{"ok":true}');
      });
      return true;
    }
  };
}

export async function checkSiteAccessSaveRetry({ browser, allowed, popup, getWorker, blockedOrigin,
  readPolicy, resume, capture, assert, until, submissions, detail }) {
  const key = "OPEN_BROWSER_USE_SITE_ACCESS_POLICY", testKey = `__OBU_TEST_SITE_QUOTA_${randomBytes(8).toString("hex")}`;
  const before = await readPolicy(), saved = { version: before.version, revision: before.revision, mode: before.mode, origins: before.origins };
  const nonce = randomBytes(8).toString("hex");
  const view = () => popup.evaluate(`({label:document.querySelector('#site-access-status').textContent,
    revision:Number(document.querySelector('#site-access-status').dataset.revision),mode:document.querySelector('#site-access-mode').value,
    origins:document.querySelector('#site-access-origins').value,retryDisabled:document.querySelector('#site-access-retry').disabled,
    error:document.querySelector('#site-access-error').textContent})`);
  let installed = false, pending, failure;
  const outcome = {};
  try {
    detail.before = before;
    detail.install = await getWorker().evaluate(`(${installSiteAccessSaveFault.toString()})(chrome,globalThis,${JSON.stringify({ revision: before.revision + 1, testKey })})`);
    installed = true;
    await allowed.domSnapshot();
    const oldEpoch = browser.client.controlEpoch;
    pending = allowed.locator("#site-retry-never").click({ timeoutMs: 30000 }).then(
      () => { outcome.succeeded = true; }, error => { outcome.error = error.message; });
    detail.pendingAdmitted = await until(() => getWorker().evaluate(`Boolean(__integrationBackend.browserEngine?.queues?.has(${allowed.id}))`), "original pending locator admitted");
    assert.deepEqual(outcome, {}, "locator finished before the policy pause");
    await popup.evaluate("document.querySelector('#site-access-reload').click()");
    await until(async () => (await view()).label === "Saved", "saved policy before quota failure");
    await popup.evaluate(`(()=>{const mode=document.querySelector('#site-access-mode'),origins=document.querySelector('#site-access-origins');
      mode.value='block';mode.dispatchEvent(new Event('change',{bubbles:true}));origins.value=${JSON.stringify(blockedOrigin)};
      origins.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#site-access-apply').click()})()`);
    await until(async () => (await readPolicy()).retryable === true, "settled native policy failure");
    await pending;
    assert.match(outcome.error, /paused|ended|cancel|stale/i);
    detail.cancelled = outcome; detail.failed = await readPolicy();
    assert.equal(detail.failed.ready, false); assert.equal(detail.failed.revision, before.revision + 1);
    assert.equal(detail.failed.mode, "block"); assert.deepEqual(detail.failed.origins, [blockedOrigin]);
    detail.durableAfterFailure = await getWorker().evaluate(`chrome.storage.local.get(${JSON.stringify([key, testKey])})`);
    assert.deepEqual(detail.durableAfterFailure, { [key]: saved }, "failed write changed durable policy or added quota padding");
    detail.nativeFailure = await getWorker().evaluate("__siteAccessSaveFault.snapshot()");
    assert.equal(detail.nativeFailure.attempts, 1); assert.equal(detail.nativeFailure.pending, 0);
    assert.deepEqual(detail.nativeFailure.rows.map(row => row.kind), ["call", "rejected"]);
    assert.match(detail.nativeFailure.rows[1].error, /quota/i);
    await assert.rejects(allowed.getByLabel("Allowed field").fill("must stay blocked"), /OBU_AUTOMATION_PAUSED/);
    detail.resumeWhileFailed = await popup.evaluate(`(async()=>{const state=await chrome.runtime.sendMessage({type:'GET_AUTOMATION_CONTROL_STATUS'});
      return chrome.runtime.sendMessage({type:'RESUME_AUTOMATION',expectedRevision:state.status.revision})})()`);
    assert.equal(detail.resumeWhileFailed.ok, false); assert.match(detail.resumeWhileFailed.error, /OBU_SITE_ACCESS_UNAVAILABLE/);
    assert.equal(submissions.stats().length, 0);
    await popup.evaluate("document.querySelector('#site-access-reload').click()");
    await until(async () => { const value = await view(); return value.label === "Not saved" && !value.retryDisabled; }, "review failed candidate");
    await until(() => popup.evaluate("document.querySelector('#automation-status-label').textContent==='Paused'"), "failed save displays actual paused state");
    detail.review = await view();
    assert.equal(detail.review.mode, "block"); assert.equal(detail.review.origins, blockedOrigin);
    await capture("site-access-save-failed-review", popup);
    await getWorker().evaluate("__siteAccessSaveFault.disable()");
    await popup.evaluate("document.querySelector('#site-access-retry').click()");
    await until(async () => { const value = await view(); return value.label === "Saved" && value.revision === before.revision + 2; }, "explicit policy retry", 15000);
    detail.confirmed = await readPolicy();
    assert.deepEqual(detail.confirmed, { version: 1, revision: before.revision + 2, mode: "block", origins: [blockedOrigin], ready: true });
    detail.durableAfterRetry = await getWorker().evaluate(`chrome.storage.local.get(${JSON.stringify([key, testKey])})`);
    const { ready, ...confirmedSaved } = detail.confirmed;
    assert.deepEqual(detail.durableAfterRetry, { [key]: confirmedSaved });
    detail.pausedAfterRetry = await popup.evaluate("chrome.runtime.sendMessage({type:'GET_AUTOMATION_CONTROL_STATUS'})");
    assert.equal(detail.pausedAfterRetry.status.state, "paused"); assert.equal(detail.pausedAfterRetry.status.inputBlocked, true);
    assert.equal(detail.pausedAfterRetry.status.cleanupComplete, true);
    await capture("site-access-save-retried-paused", popup);
    detail.staleRetry = await popup.evaluate(`chrome.runtime.sendMessage({type:'RETRY_SITE_ACCESS_POLICY',expectedRevision:${before.revision + 1}})`);
    assert.equal(detail.staleRetry.ok, false);
    assert.equal((await getWorker().evaluate("__siteAccessSaveFault.snapshot()")).attempts, 2, "stale retry wrote again");
    assert.equal(submissions.stats().length, 0, "save retried browser work");
    await resume();
    await assert.rejects(allowed.domSnapshot(), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED/);
    assert.equal(browser.client.controlEpoch, oldEpoch);
    await browser.client.beginTurn();
    const text = `explicit retry ${nonce} 中文`;
    await allowed.getByLabel("Allowed field").fill(text);
    await allowed.getByRole("button", { name: "Submit allowed value", exact: true }).click();
    await until(() => submissions.stats().length === 1, "one original business POST");
    detail.submission = submissions.stats();
    assert.equal(detail.submission.length, 1);
    assert.deepEqual(detail.submission[0].value, { value: text, trusted: true });
    await until(async () => (await allowed.locator("#submission-status").textContent()) === "saved", "original page submission confirmation");
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors = [];
    if (installed) try { detail.nativeFinal = await getWorker().evaluate("__siteAccessSaveFault.stop()"); }
    catch (error) { cleanupErrors.push(error); }
    if (pending) try { await pending; } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) {
      detail.cleanupErrors = cleanupErrors.map(error => error.stack ?? String(error));
      if (failure) detail.primaryError = failure.stack ?? String(failure);
      throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "Website policy retry verification/cleanup failed");
    }
  }
  if (failure) throw failure;
  assert.equal(detail.nativeFinal.attempts, 2); assert.equal(detail.nativeFinal.pending, 0);
  assert.deepEqual(detail.nativeFinal.rows.map(row => row.kind), ["call", "rejected", "call", "fulfilled"]);
  assert.equal(detail.nativeFinal.rows[0].injected, true); assert.equal(detail.nativeFinal.rows[2].injected, false);
  assert.equal(detail.nativeFinal.restored, true); assert.equal(detail.nativeFinal.apiRemoved, true);
  assert.equal(detail.nativeFinal.overflow, false); assert.deepEqual(detail.nativeFinal.errors, []);
}
