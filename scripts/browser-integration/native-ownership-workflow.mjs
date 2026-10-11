// Optional public-SDK ownership acceptance; importing never starts a browser.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

const readExpression = "({url:location.href,nonce:document.querySelector('#nonce')?.textContent})";
const scopeOf = client => ({ session_id: client.sessionId, turn_id: client.turnId, control_epoch: client.controlEpoch });
const byId = values => [...values].sort((a, b) => a.id - b.id);
const errorDetail = error => ({ message: error.message ?? String(error), ...(error.code === undefined ? {} : { code: error.code }) });

export function nativeOwnershipEnabled(value) {
  assert.ok(value === undefined || value === "" || value === "0" || value === "1", "OBU_TEST_NATIVE_OWNERSHIP must be 0 or 1");
  return value === "1";
}

export function ownershipReadRequest(scope, tabId) {
  return { method: "browserAction", params: { ...scope, tabId, action: "evaluate", args: { expression: readExpression }, timeoutMs: 2000 } };
}

// A timeout, paused browser, invalid request, or stale epoch is not evidence of
// foreign ownership rejection. The request itself must name the exact scope/tab.
export function checkOwnershipRejection(record, { kind, scope, tabId, ownerSessionId }) {
  assert.equal(record.outcome, "rejected");
  const expected = kind === "foreign" ? { method: "claimUserTab", params: { ...scope, tabId } } : ownershipReadRequest(scope, tabId);
  assert.deepEqual(record.request, expected);
  assert.ok(typeof scope.session_id === "string" && scope.session_id.length > 0);
  assert.ok(typeof scope.turn_id === "string" && scope.turn_id.length > 0);
  assert.ok(Number.isSafeInteger(scope.control_epoch) && scope.control_epoch > 0);
  assert.ok(Number.isSafeInteger(tabId));
  const message = record.error?.message;
  if (kind === "foreign") {
    assert.notEqual(scope.session_id, ownerSessionId);
    assert.ok(message === `Tab ${tabId} is already part of browser session ${ownerSessionId}` || message === "OBU_AUXILIARY_CLAIM_CONFLICT: tab already has an auxiliary owner or pending claim", `Unexpected foreign claim rejection: ${message}`);
  } else if (kind === "ended") {
    assert.ok(message === "OBU_STALE_CONTROL_EPOCH: bootstrap a new turn explicitly; do not replay the request" || message === "OBU_TURN_ENDED: this browser turn has ended", `Unexpected ended-turn rejection: ${message}`);
  } else {
    assert.equal(kind, "unowned");
    assert.equal(message, `Tab ${tabId} is not part of browser session ${scope.session_id}`);
  }
  return record;
}

export function checkOwnershipTabs(snapshot, { baseline, created, alive, detached = [] }) {
  assert.ok(Array.isArray(snapshot.tabs) && Array.isArray(snapshot.debuggerTargets));
  assert.equal(new Set(snapshot.tabs.map(tab => tab.id)).size, snapshot.tabs.length);
  const createdIds = created.map(tab => tab.id);
  assert.equal(new Set(createdIds).size, createdIds.length);
  assert.equal(new Set(alive).size, alive.length);
  assert.ok(alive.every(id => createdIds.includes(id)));
  assert.deepEqual(byId(snapshot.tabs.filter(tab => !createdIds.includes(tab.id))), byId(baseline.tabs), "Non-task tabs changed");
  assert.deepEqual(snapshot.tabs.filter(tab => createdIds.includes(tab.id)).map(tab => tab.id).sort((a, b) => a - b), [...alive].sort((a, b) => a - b));
  for (const id of alive) {
    const tab = snapshot.tabs.find(value => value.id === id), expected = created.find(value => value.id === id);
    assert.equal(tab.active, false); assert.equal(tab.url, expected.url);
    if (expected.windowId !== undefined) assert.equal(tab.windowId, expected.windowId);
  }
  for (const id of detached) assert.equal(snapshot.debuggerTargets.some(target => target.tabId === id && target.attached === true), false, `Tab ${id} retained a debugger attachment`);
  return snapshot;
}

export function checkOwnershipHTTP({ posts, requests, initialPosts, initialRequests, expected, pages, checkReceipt }) {
  assert.equal(requests.overflow, false); assert.equal(requests.dropped, 0);
  assert.equal(initialPosts.length, 1); assert.equal(initialRequests.length, 1);
  assert.equal(initialRequests[0].method, "GET"); assert.equal(initialRequests[0].nonce, JSON.parse(initialPosts[0].body).nonce);
  assert.deepEqual(posts.slice(0, initialPosts.length), initialPosts, "Earlier POST evidence changed");
  assert.deepEqual(requests.requests.slice(0, initialRequests.length), initialRequests, "Earlier GET evidence changed");
  const additions = posts.slice(initialPosts.length), gets = requests.requests.slice(initialRequests.length);
  assert.equal(additions.length, 4); assert.equal(expected.length, 4); assert.equal(pages.length, 3);
  assert.equal(gets.length, 3); assert.equal(new Set(pages.map(page => page.nonce)).size, 3);
  for (const [index, page] of pages.entries()) {
    assert.equal(gets[index].method, "GET"); assert.equal(gets[index].nonce, page.nonce);
    assert.equal(gets[index].url, new URL(page.url).pathname + new URL(page.url).search);
  }
  for (const [index, value] of expected.entries()) {
    assert.equal(additions[index].url, "/submit");
    assert.equal(additions[index].sha256, createHash("sha256").update(additions[index].body).digest("hex"));
    const receipt = JSON.parse(additions[index].body);
    checkReceipt(receipt, { nonce: value.nonce, note: value.note });
    assert.deepEqual(receipt, value.receipt, `Original POST ${index} differs from public DOM receipt`);
  }
  assert.equal(expected[0].nonce, pages[0].nonce); assert.equal(expected[1].nonce, pages[1].nonce);
  assert.equal(expected[2].nonce, pages[0].nonce); assert.notEqual(expected[2].note, expected[0].note);
  assert.equal(expected[3].nonce, pages[2].nonce);
  return { getCount: gets.length, postCount: additions.length, totalGetCount: requests.requests.length, totalPostCount: posts.length, gets: structuredClone(gets), posts: structuredClone(additions) };
}

// All mutations use the public SDK. readNative is a separate observer's native
// tabs/targets read. Bounded waits only observe real removal/detachment; no SDK
// operation is retried, including a finalize with an uncertain acknowledgement.
export async function runNativeOwnershipWorkflow({ detail, connect, fixtureURL, posts, requests, readNative, until, focus, checkpoint, checkReceipt }) {
  Object.assign(detail, { enabled: true, passed: false, startedAt: Date.now(), steps: [], pages: [], submissions: [], rejections: [], snapshots: [], finalizeAttempts: [], cleanup: {}, boundary: "Public JS SDK, two independent sessions, native observer tabs/targets and original HTTP requests. No private ownership maps, activation, action retry or focus allowance." });
  const initialPosts = structuredClone(posts), initialRequests = structuredClone(requests.requests), clients = [];
  let owner, foreign;
  async function step(label, browser, run, params = {}, summarize = value => value) {
    const record = { label, requestedAt: Date.now(), scope: browser ? scopeOf(browser.client) : null, params: structuredClone(params) }; detail.steps.push(record);
    try { const value = await run(); record.completedAt = Date.now(); record.result = summarize(value); record.scopeAfter = browser ? scopeOf(browser.client) : null; await checkpoint(); return value; }
    catch (error) { record.failedAt = Date.now(); record.error = errorDetail(error); await checkpoint(); throw error; }
  }
  async function snapshot(label, alive, detached = [], wait = false) {
    const record = { label, requestedAt: Date.now() }; detail.snapshots.push(record);
    const read = async () => { record.value = await readNative(); record.observedAt = Date.now(); return record.value; };
    const createdIds = detail.pages.map(page => page.id);
    if (wait) await until(async () => {
      const value = await read();
      return createdIds.every(id => value.tabs.some(tab => tab.id === id) === alive.includes(id)) && detached.every(id => !value.debuggerTargets.some(target => target.tabId === id && target.attached)) && value;
    }, `ownership ${label} actual tab disposition`, 15000);
    else await read();
    await checkpoint();
    checkOwnershipTabs(record.value, { baseline: detail.baseline, created: detail.pages, alive, detached });
    await focus(`ownership-${label}`); return record.value;
  }
  async function denied(browser, label, kind, page, scope) {
    const request = kind === "foreign" ? { method: "claimUserTab", params: { ...scope, tabId: page.id } } : ownershipReadRequest(scope, page.id);
    const record = { label, kind, requestedAt: Date.now(), request: structuredClone(request) }; detail.rejections.push(record);
    try { record.result = await browser.client.request(request.method, request.params, { timeoutMs: 3000 }); record.outcome = "fulfilled"; }
    catch (error) { record.outcome = "rejected"; record.error = errorDetail(error); }
    record.completedAt = Date.now(); await checkpoint();
    checkOwnershipRejection(record, { kind, scope, tabId: page.id, ownerSessionId: owner.client.sessionId });
  }
  async function begin(label) {
    await step(label, owner, () => owner.client.beginTurn());
    const scope = scopeOf(owner.client); assert.ok(Number.isSafeInteger(scope.control_epoch) && scope.control_epoch > 0); return scope;
  }
  async function create(label) {
    const page = { label, nonce: randomBytes(12).toString("hex") }; page.url = `${fixtureURL}/task?nonce=${page.nonce}`;
    detail.pages.push(page);
    const tab = await step(`${label} newTab`, owner, () => owner.newTab(), {}, value => ({ id: value.id })); page.id = tab.id;
    assert.ok(Number.isSafeInteger(page.id)); await checkpoint();
    await step(`${label} goto`, owner, () => tab.goto(page.url), { tabId: page.id, url: page.url });
    assert.equal(await step(`${label} read nonce`, owner, () => tab.locator("#nonce").innerText(), { tabId: page.id }), page.nonce);
    return { page, tab };
  }
  async function submit(label, page, tab) {
    const note = `ownership-${label}-${page.nonce}`, entry = { label, tabId: page.id, nonce: page.nonce, note, scope: scopeOf(owner.client) }; detail.submissions.push(entry);
    await step(`${label} fill`, owner, () => tab.getByLabel("Delivery note").fill(note), { tabId: page.id, note });
    await step(`${label} click`, owner, () => tab.getByRole("button", { name: "Submit note", exact: true }).click(), { tabId: page.id });
    // A's resumed submission shares its nonce; wait for the new exact note,
    // never accept the previous receipt merely because its nonce still matches.
    await step(`${label} receipt visible`, owner, () => tab.locator("#receipt").filter({ hasText: note }).waitFor({ state: "visible" }), { tabId: page.id, note });
    entry.receipt = JSON.parse(await step(`${label} read receipt`, owner, () => tab.locator("#receipt").innerText(), { tabId: page.id }));
    checkReceipt(entry.receipt, { nonce: page.nonce, note }); await checkpoint();
  }
  async function finalize(label, page, status) {
    const keep = [{ tabId: page.id, status }], attempt = { label, scope: scopeOf(owner.client), keep, requestedAt: Date.now() }; detail.finalizeAttempts.push(attempt); await checkpoint();
    attempt.result = await step(label, owner, () => owner.client.finalizeTabs(keep), { keep }); attempt.completedAt = Date.now(); await checkpoint();
  }
  try {
    assert.equal(initialPosts.length, 1, "Standard task must have its one original POST before ownership starts");
    assert.equal(initialRequests.length, 1, "Standard task must have its one original GET before ownership starts");
    assert.equal(initialRequests[0].method, "GET");
    assert.equal(initialRequests[0].nonce, JSON.parse(initialPosts[0].body).nonce);
    detail.baseline = await readNative(); await checkpoint(); await focus("ownership-before");
    owner = await connect("owner"); clients.push(owner); foreign = await connect("foreign"); clients.push(foreign);
    assert.notEqual(owner.client.sessionId, foreign.client.sessionId);
    const firstScope = await begin("owner beginTurn"); detail.firstScope = firstScope;
    await step("foreign beginTurn", foreign, () => foreign.client.beginTurn()); detail.foreignScope = scopeOf(foreign.client);
    const a = await create("A"); await submit("A-initial", a.page, a.tab);
    const b = await create("B"); await submit("B-initial", b.page, b.tab);
    detail.initialOwned = await step("owner getTabs A+B", owner, () => owner.getTabs());
    assert.deepEqual(detail.initialOwned.map(tab => tab.id).sort((x, y) => x - y), [a.page.id, b.page.id].sort((x, y) => x - y));
    const opened = await snapshot("two-pages", [a.page.id, b.page.id]);
    for (const page of detail.pages) page.windowId = opened.tabs.find(tab => tab.id === page.id).windowId;
    await denied(foreign, "foreign A", "foreign", a.page, detail.foreignScope);
    await denied(foreign, "foreign B", "foreign", b.page, detail.foreignScope);
    await finalize("handoff A", a.page, "handoff");
    await snapshot("handoff", [a.page.id], [a.page.id, b.page.id], true);
    await denied(owner, "old scope after handoff", "ended", a.page, firstScope);
    await denied(foreign, "foreign handoff A", "foreign", a.page, detail.foreignScope);
    const secondScope = await begin("owner explicit resumed beginTurn"); detail.resumedScope = secondScope;
    assert.equal(secondScope.session_id, firstScope.session_id); assert.notEqual(secondScope.turn_id, firstScope.turn_id); assert.ok(secondScope.control_epoch > firstScope.control_epoch);
    await step("owner explicit claim A", owner, () => owner.client.claimUserTab(a.page.id), { tabId: a.page.id });
    detail.resumedReceipt = JSON.parse(await step("read retained A receipt", owner, () => a.tab.locator("#receipt").innerText(), { tabId: a.page.id }));
    assert.deepEqual(detail.resumedReceipt, detail.submissions[0].receipt);
    await submit("A-resumed", a.page, a.tab);
    const c = await create("C"); await submit("C-deliverable", c.page, c.tab);
    const beforeDelivery = await snapshot("before-deliverable", [a.page.id, c.page.id], [b.page.id]);
    c.page.windowId = beforeDelivery.tabs.find(tab => tab.id === c.page.id).windowId;
    await finalize("deliver C and omit agent A", c.page, "deliverable");
    await snapshot("deliverable", [c.page.id], detail.pages.map(page => page.id), true);
    await denied(owner, "old scope after deliverable", "ended", c.page, secondScope);
    const freshScope = await begin("owner explicit post-delivery beginTurn"); detail.postDeliveryScope = freshScope;
    assert.equal(freshScope.session_id, secondScope.session_id); assert.notEqual(freshScope.turn_id, secondScope.turn_id); assert.ok(freshScope.control_epoch > secondScope.control_epoch);
    detail.postDeliveryOwned = await step("fresh owner getTabs excludes C", owner, () => owner.getTabs());
    assert.deepEqual(detail.postDeliveryOwned, [], "Delivered C retained task ownership");
    await denied(owner, "fresh scope delivered C unowned", "unowned", c.page, freshScope);
    await snapshot("delivered-authority-removed", [c.page.id], detail.pages.map(page => page.id));
    detail.http = checkOwnershipHTTP({ posts, requests, initialPosts, initialRequests, expected: detail.submissions, pages: detail.pages, checkReceipt });
    assert.equal(detail.http.totalPostCount, 5); assert.equal(detail.http.totalGetCount, 4);
    detail.closedTabIds = [a.page.id, b.page.id]; detail.keptTabIds = [c.page.id]; detail.completedAt = Date.now();
    // No implicit finalization is sent on teardown. A failed/unknown finalize
    // is preserved exactly once; the runner subsequently closes its own browser.
    await checkpoint(); detail.passed = true; await checkpoint(); return detail;
  } catch (error) { detail.passed = false; detail.error = error.stack ?? String(error); await checkpoint(); throw error; }
  finally {
    detail.cleanup.closedClientSessions = []; detail.cleanup.errors = [];
    for (const browser of clients) {
      try { browser.close(); detail.cleanup.closedClientSessions.push(browser.client.sessionId); }
      catch (error) { detail.cleanup.errors.push(errorDetail(error)); }
    }
    detail.cleanup.finalizeReplayed = false;
    if (detail.cleanup.errors.length) detail.passed = false;
    try { await checkpoint(); } catch (error) { detail.passed = false; detail.cleanup.errors.push(errorDetail(error)); throw error; }
    if (detail.cleanup.errors.length && !detail.error) throw new Error("Ownership client cleanup failed");
  }
}
