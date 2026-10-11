import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { nativeOwnershipEnabled, ownershipReadRequest, checkOwnershipRejection, checkOwnershipTabs, checkOwnershipHTTP } from "./native-ownership-workflow.mjs";
import { checkTrustedNativeTaskReceipt, nativeBrowserInstallationPassed } from "./native-browser-installation.mjs";

const scope = { session_id: "owner-unique", turn_id: "new-turn", control_epoch: 7 };
test("ownership mode is explicit and adds a mandatory result without relaxing default or diagnostic acceptance", () => {
  for (const value of [undefined, "", "0"]) assert.equal(nativeOwnershipEnabled(value), false);
  assert.equal(nativeOwnershipEnabled("1"), true);
  for (const value of ["yes", "true", "2", 1]) assert.throws(() => nativeOwnershipEnabled(value));
  const report = { identity: { passed: true }, discovery: { passed: true }, task: { passed: true }, focus: { passed: true }, finalInventory: { passed: true }, eof: { result: { exitCode: 0, exactHandle: true } }, browserExit: { result: { exitCode: 0, exactHandle: true } }, launcherExit: { code: 0, signal: null }, cleanup: { browserProcessesGone: true, nativeProcessesGone: true, endpointUnreachable: true, descriptorsClean: true, fixedRegistrationUnchanged: true, registration: { removed: true }, errors: [] } };
  assert.equal(nativeBrowserInstallationPassed(report), true);
  assert.equal(nativeBrowserInstallationPassed({ ...report, ownershipRequested: true }), false);
  assert.equal(nativeBrowserInstallationPassed({ ...report, ownershipRequested: true, ownership: { passed: false } }), false);
  const extended = { ...report, ownershipRequested: true, ownership: { passed: true } };
  assert.equal(nativeBrowserInstallationPassed(extended), true);
  assert.equal(nativeBrowserInstallationPassed({ ...extended, task: { passed: false } }), false);
  assert.equal(nativeBrowserInstallationPassed({ ...extended, focus: { passed: false } }), false);
  assert.equal(nativeBrowserInstallationPassed({ ...extended, mode: "native-api-diagnostic" }), false);
});

test("foreign claim rejection binds exact tab and complete foreign scope and excludes unrelated errors", () => {
  const context = { kind: "foreign", scope, tabId: 123, ownerSessionId: "other-owner" };
  const record = { outcome: "rejected", request: { method: "claimUserTab", params: { ...scope, tabId: 123 } }, error: { message: "Tab 123 is already part of browser session other-owner" } };
  assert.equal(checkOwnershipRejection(record, context), record);
  checkOwnershipRejection({ ...record, error: { message: "OBU_AUXILIARY_CLAIM_CONFLICT: tab already has an auxiliary owner or pending claim" } }, context);
  for (const message of ["Timed out", "OBU_AUTOMATION_PAUSED", "OBU_AUXILIARY_CLAIM_CANCELLED", "OBU_AUXILIARY_CLAIM_EXPIRED", "Tab 124 is already part of browser session other-owner", "Tab 123 is already part of browser session somebody-else", "OBU_STALE_CONTROL_EPOCH: bootstrap a new turn explicitly; do not replay the request"]) assert.throws(() => checkOwnershipRejection({ ...record, error: { message } }, context));
  for (const params of [{ ...record.request.params, tabId: 124 }, { ...record.request.params, control_epoch: 6 }, { ...record.request.params, session_id: "other-owner" }]) assert.throws(() => checkOwnershipRejection({ ...record, request: { ...record.request, params } }, context));
  assert.throws(() => checkOwnershipRejection({ ...record, outcome: "fulfilled" }, context));
});

test("fresh delivered-tab denial must be unowned, not merely an expired old turn", () => {
  const context = { kind: "unowned", scope, tabId: 123 };
  const record = { outcome: "rejected", request: ownershipReadRequest(scope, 123), error: { message: "Tab 123 is not part of browser session owner-unique" } };
  checkOwnershipRejection(record, context);
  const expired = { ...record, error: { message: "OBU_STALE_CONTROL_EPOCH: bootstrap a new turn explicitly; do not replay the request" } };
  assert.throws(() => checkOwnershipRejection(expired, context));
  checkOwnershipRejection(expired, { ...context, kind: "ended" });
  assert.throws(() => checkOwnershipRejection(record, { ...context, kind: "ended" }));
  for (const params of [{ ...record.request.params, action: "click" }, { ...record.request.params, args: { expression: "document.title='changed'" } }, { ...record.request.params, control_epoch: 6 }]) assert.throws(() => checkOwnershipRejection({ ...record, request: { ...record.request, params } }, context));
});

test("native disposition proves actual omitted-page closure and kept-tab inactivity/detachment, preserving non-task tabs", () => {
  const sentinel = { id: 1, url: "http://fixture/sentinel", active: true, windowId: 9, groupId: -1, pinned: false };
  const created = [2, 3, 4].map(id => ({ id, url: `http://fixture/task?nonce=${id}`, windowId: 9 }));
  const kept = { ...created[2], active: false, groupId: 10, pinned: false };
  const context = { baseline: { tabs: [sentinel] }, created, alive: [4], detached: [2, 3, 4] };
  const snapshot = { tabs: [sentinel, kept], debuggerTargets: [{ tabId: 4, attached: false }] };
  checkOwnershipTabs(snapshot, context);
  for (const tabs of [[sentinel, kept, { ...created[0], active: false }], [sentinel], [sentinel, { ...kept, active: true }], [sentinel, { ...kept, url: "http://fixture/wrong" }], [sentinel, { ...kept, windowId: 10 }], [{ ...sentinel, pinned: true }, kept], [{ ...sentinel, url: "http://fixture/moved" }, kept], [sentinel, kept, kept]]) assert.throws(() => checkOwnershipTabs({ ...snapshot, tabs }, context));
  assert.throws(() => checkOwnershipTabs({ ...snapshot, debuggerTargets: [{ tabId: 4, attached: true }] }, context));
  assert.throws(() => checkOwnershipTabs({ ...snapshot, debuggerTargets: [{ tabId: 2, attached: true }] }, context));
});

function httpEvidence() {
  const pages = ["a", "b", "c"].map(name => ({ nonce: name.repeat(24), url: `http://fixture/task?nonce=${name.repeat(24)}` }));
  const expected = [pages[0], pages[1], pages[0], pages[2]].map((page, i) => {
    const note = `note-${i}`, receipt = { nonce: page.nonce, note, trusted: true, inputOverflow: false, inputEvents: [{ type: "input", trusted: true, value: note }] };
    return { nonce: page.nonce, note, receipt };
  });
  const initialPosts = [{ url: "/submit", body: '{"nonce":"standard"}' }], initialRequests = [{ method: "GET", url: "/task?nonce=standard", nonce: "standard" }];
  const posts = [...initialPosts, ...expected.map(value => { const body = JSON.stringify(value.receipt); return { url: "/submit", body, sha256: createHash("sha256").update(body).digest("hex") }; })];
  const requests = { overflow: false, dropped: 0, requests: [...initialRequests, ...pages.map(page => ({ method: "GET", nonce: page.nonce, url: new URL(page.url).pathname + new URL(page.url).search }))] };
  return { posts, requests, initialPosts, initialRequests, expected, pages, checkReceipt: checkTrustedNativeTaskReceipt };
}
test("HTTP evidence retains two distinct A submissions and proves all original trusted POSTs in sequence", () => {
  const evidence = httpEvidence(), result = checkOwnershipHTTP(evidence);
  assert.equal(result.postCount, 4); assert.equal(result.totalPostCount, 5); assert.equal(result.getCount, 3); assert.equal(result.totalGetCount, 4);
  for (const mutate of [value => value.posts.splice(3, 1), value => [value.posts[1], value.posts[3]] = [value.posts[3], value.posts[1]], value => value.posts.push(value.posts[4]), value => value.posts[0] = { ...value.posts[0], body: "changed" }, value => value.requests.requests.pop(), value => value.requests.requests[1].method = "POST", value => value.requests.requests.push(value.requests.requests[1]), value => value.requests.overflow = true, value => value.posts[2].sha256 = "wrong"]) {
    const altered = httpEvidence(); mutate(altered); assert.throws(() => checkOwnershipHTTP(altered));
  }
  const untrusted = httpEvidence(); untrusted.expected[3].receipt.inputEvents[0].trusted = false;
  untrusted.posts[4].body = JSON.stringify(untrusted.expected[3].receipt); untrusted.posts[4].sha256 = createHash("sha256").update(untrusted.posts[4].body).digest("hex");
  assert.throws(() => checkOwnershipHTTP(untrusted));
  const duplicateInitial = httpEvidence(); duplicateInitial.initialRequests.push(duplicateInitial.initialRequests[0]); duplicateInitial.requests.requests.splice(1, 0, duplicateInitial.initialRequests[0]);
  assert.throws(() => checkOwnershipHTTP(duplicateInitial));
});
