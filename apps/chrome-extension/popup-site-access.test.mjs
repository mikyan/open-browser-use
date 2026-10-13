import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createSiteAccessControl } from "./popup-site-access.js";

const policy = (revision = 1, mode = "all", origins = []) => ({ version: 1, revision, mode, origins, ready: true });
function fixture() {
  const requests = [], views = [], applied = [], settled = [];
  const control = createSiteAccessControl({
    sendMessage: message => new Promise((resolve, reject) => requests.push({ message, resolve, reject })),
    render: view => views.push(view), onApplied: () => applied.push(true),
    onSettled: () => settled.push({ pending: views.at(-1).pending, label: views.at(-1).label })
  });
  const respond = (index, value, extra = {}) => requests[index].resolve({ ok: true, policy: value, ...extra });
  return { control, requests, views, applied, settled, respond, view: () => views.at(-1) };
}
async function load(f, value = policy()) {
  const refresh = f.control.refresh(); f.respond(0, value); await refresh;
}
const edit = (f, originsText = "https://example.com", mode = "allow") => f.control.edit({ mode, originsText });
const failedPolicy = (revision = 2, mode = "allow", origins = ["https://example.com"]) => ({
  ...policy(revision, mode, origins), ready: false, retryable: true, error: "Website settings could not be saved"
});

test("initial state cannot save, and loading the default does not write it", async () => {
  const f = fixture();
  assert.equal(f.view().label, "Checking"); assert.equal(f.view().editingDisabled, true);
  await f.control.apply(); assert.equal(f.requests.length, 0);
  await load(f);
  assert.equal(f.view().mode, "all"); assert.equal(f.view().applyDisabled, true);
  assert.deepEqual(f.requests.map(item => item.message.type), ["GET_SITE_ACCESS_POLICY"]);
});

test("apply captures the displayed revision, trims lines and waits for confirmed pause", async () => {
  const f = fixture(); await load(f, policy(4));
  edit(f, " https://EXAMPLE.com/ \n\n http://localhost:3000 \n");
  const save = f.control.apply();
  assert.deepEqual(f.requests[1].message, { type: "SET_SITE_ACCESS_POLICY", expectedRevision: 4,
    policy: { mode: "allow", origins: ["https://EXAMPLE.com/", "http://localhost:3000"] } });
  assert.equal(f.view().label, "Saving"); assert.equal(f.view().editingDisabled, true);
  assert.doesNotMatch(f.view().message, /Settings saved/);
  await f.control.apply(); await f.control.refresh(); await f.control.reload(); edit(f, "https://late.example");
  assert.equal(f.requests.length, 2);
  f.respond(1, policy(5, "allow", ["https://example.com", "http://localhost:3000"])); await save;
  assert.equal(f.view().originsText, "https://example.com\nhttp://localhost:3000");
  assert.equal(f.view().dirty, false); assert.match(f.view().message, /saved and agents paused/);
  assert.equal(f.applied.length, 1);
  assert.deepEqual(f.requests.map(item => item.message.type), ["GET_SITE_ACCESS_POLICY", "SET_SITE_ACCESS_POLICY"]);
});

test("polls preserve an edited draft and the revision against which it was edited", async () => {
  const f = fixture(); await load(f, policy(3)); edit(f, " https://draft.example/ ");
  const same = f.control.refresh(); f.respond(1, policy(3)); await same;
  assert.equal(f.view().originsText, " https://draft.example/ "); assert.equal(f.view().applyDisabled, false);
  const changed = f.control.refresh(); f.respond(2, policy(4, "block", ["https://other.example"])); await changed;
  assert.equal(f.view().mode, "allow"); assert.equal(f.view().originsText, " https://draft.example/ ");
  assert.equal(f.view().conflict, true); assert.equal(f.view().applyDisabled, true);
  await f.control.apply(); assert.equal(f.requests.length, 3);
  const reload = f.control.reload(); f.respond(3, policy(4, "block", ["https://other.example"])); await reload;
  assert.equal(f.view().mode, "block"); assert.equal(f.view().originsText, "https://other.example");
  assert.equal(f.view().dirty, false); assert.equal(f.view().conflict, false);
});

test("out-of-order polls and a pre-save poll cannot overwrite confirmed settings", async () => {
  const f = fixture(); await load(f);
  const older = f.control.refresh(), newer = f.control.refresh();
  f.respond(2, policy(3, "block", ["https://blocked.example"])); await newer;
  f.respond(1, policy(2)); await older;
  assert.equal(f.view().revision, 3);
  const stale = f.control.refresh(); edit(f, "https://allowed.example");
  const save = f.control.apply();
  f.respond(3, policy(3)); await stale;
  assert.equal(f.view().label, "Saving"); assert.equal(f.view().originsText, "https://allowed.example");
  f.respond(4, policy(4, "allow", ["https://allowed.example"])); await save;
  const regressed = f.control.refresh(); f.respond(5, policy(1)); await regressed;
  assert.equal(f.view().revision, 4); assert.equal(f.view().mode, "allow");
});

test("a lost save reply preserves draft, verifies status and never automatically resubmits", async () => {
  const f = fixture(); await load(f, policy(4)); edit(f);
  const save = f.control.apply(); f.requests[1].reject(new Error("Worker disconnected")); await save;
  assert.equal(f.view().label, "Unavailable"); assert.equal(f.view().applyDisabled, true);
  assert.equal(f.view().originsText, "https://example.com"); assert.equal(f.applied.length, 0);
  assert.doesNotMatch(f.view().message, /agents paused/);
  await f.control.apply(); assert.equal(f.requests.length, 2);
  const verify = f.control.refresh(); f.respond(2, policy(5, "allow", ["https://example.com"])); await verify;
  assert.equal(f.view().conflict, true); assert.equal(f.view().dirty, true);
  assert.equal(f.requests.filter(item => item.message.type === "SET_SITE_ACCESS_POLICY").length, 1);
  assert.equal(f.applied.length, 0); assert.equal(f.view().error, "");
});

test("CAS failure keeps the draft and requires explicit reload of the changed policy", async () => {
  const f = fixture(); await load(f, policy(1)); edit(f);
  const save = f.control.apply();
  f.respond(1, policy(2, "block", ["https://other.example"]), { ok: false, error: "OBU_SITE_ACCESS_REVISION_CONFLICT" }); await save;
  assert.equal(f.view().label, "Changed"); assert.equal(f.view().originsText, "https://example.com");
  assert.match(f.view().error, /REVISION_CONFLICT/); assert.equal(f.applied.length, 0);
  await f.control.apply(); assert.equal(f.requests.length, 2);
  const reload = f.control.reload(); f.respond(2, policy(2, "block", ["https://other.example"])); await reload;
  edit(f, "https://new.example"); const retry = f.control.apply();
  assert.equal(f.requests[3].message.expectedRevision, 2);
  f.respond(3, policy(3, "allow", ["https://new.example"])); await retry;
});

test("backend validation errors keep editable raw input without pretending it was saved", async () => {
  const f = fixture(); await load(f); edit(f, "https://example.com/private");
  const save = f.control.apply();
  f.respond(1, policy(), { ok: false, error: "Origin must not contain a path" }); await save;
  assert.equal(f.view().editingDisabled, false); assert.equal(f.view().dirty, true);
  assert.equal(f.view().originsText, "https://example.com/private"); assert.match(f.view().error, /path/);
  assert.equal(f.applied.length, 0);
  edit(f); assert.equal(f.view().error, ""); assert.equal(f.view().applyDisabled, false);
});

test("limits are checked before sending and an empty allow list is explicit", async () => {
  const f = fixture(); await load(f); edit(f, Array.from({ length: 101 }, (_, i) => `https://site${i}.example`).join("\n"));
  await f.control.apply(); assert.equal(f.requests.length, 1); assert.match(f.view().error, /100 origins/);
  edit(f, " \n\r\n "); const save = f.control.apply();
  assert.deepEqual(f.requests[1].message.policy, { mode: "allow", origins: [] });
  f.respond(1, policy(2, "allow")); await save;
});

test("switching to all preserves the unsaved list until save, then submits no origins", async () => {
  const f = fixture(); await load(f, policy(3, "block", ["https://blocked.example"]));
  edit(f, f.view().originsText, "all"); assert.equal(f.view().listVisible, false);
  assert.equal(f.view().originsText, "https://blocked.example");
  const save = f.control.apply(); assert.deepEqual(f.requests[1].message.policy, { mode: "all", origins: [] });
  f.respond(1, policy(4)); await save; assert.equal(f.view().originsText, "");
});

test("invalid or not-ready policies never enable a write or imply enforcement", async () => {
  const f = fixture(); const first = f.control.refresh();
  f.respond(0, { ...policy(), ready: false, error: "Storage unavailable" }); await first;
  assert.equal(f.view().label, "Unavailable"); assert.match(f.view().error, /Storage unavailable/);
  assert.equal(f.view().applyDisabled, true); assert.equal(f.view().editingDisabled, true);
  await f.control.apply(); assert.equal(f.requests.length, 1);
  const second = f.control.reload(); f.respond(1, { ...policy(), revision: -1 }); await second;
  assert.equal(f.view().applyDisabled, true); assert.equal(f.applied.length, 0);
});

test("reload invalidates earlier polls and a failed reload does not discard the draft", async () => {
  const f = fixture(); await load(f); edit(f, "https://draft.example");
  const poll = f.control.refresh(); const reload = f.control.reload();
  f.respond(1, policy(2, "block", ["https://other.example"])); await poll;
  f.requests[2].reject(new Error("Worker disconnected")); await reload;
  assert.equal(f.view().originsText, "https://draft.example"); assert.equal(f.view().dirty, true);
  assert.equal(f.view().revision, 1); assert.equal(f.view().label, "Unavailable");
});

test("reopened popup reviews the failed candidate as not saved and retries only its revision", async () => {
  const f = fixture(); await load(f, failedPolicy(7, "block", ["https://blocked.example"]));
  assert.equal(f.view().label, "Not saved"); assert.equal(f.view().mode, "block");
  assert.equal(f.view().originsText, "https://blocked.example");
  assert.equal(f.view().retryVisible, true); assert.equal(f.view().retryDisabled, false);
  assert.equal(f.view().applyDisabled, true); assert.equal(f.view().editingDisabled, true);
  assert.doesNotMatch(f.view().message, /Saved settings loaded|Settings saved/);
  assert.equal(f.requests.length, 1); assert.equal(f.applied.length, 0);
  const retry = f.control.retry();
  assert.deepEqual(f.requests[1].message, { type: "RETRY_SITE_ACCESS_POLICY", expectedRevision: 7 });
  assert.equal(f.view().retryDisabled, true); assert.equal(f.view().reloadDisabled, true);
  await f.control.retry(); await f.control.apply(); await f.control.refresh(); await f.control.reload();
  assert.equal(f.requests.length, 2);
  f.respond(1, policy(8, "block", ["https://blocked.example"])); await retry;
  assert.equal(f.view().label, "Saved"); assert.equal(f.view().retryVisible, false);
  assert.equal(f.applied.length, 1); assert.match(f.view().message, /saved and agents paused/);
  assert.ok(f.requests.every(item => item.message.type !== "RESUME_AUTOMATION"));
});

test("failed save preserves raw draft and requires explicit review before retry", async () => {
  const f = fixture(); await load(f, policy(1)); edit(f, " https://EXAMPLE.com/ ");
  const save = f.control.apply();
  f.respond(1, failedPolicy(2), { ok: false, error: "Storage rejected the write" }); await save;
  assert.equal(f.view().label, "Not saved"); assert.equal(f.view().originsText, " https://EXAMPLE.com/ ");
  assert.equal(f.view().dirty, true); assert.equal(f.view().retryDisabled, true);
  assert.match(f.view().reloadText, /Review unsaved/); assert.equal(f.applied.length, 0);
  await f.control.retry(); assert.equal(f.requests.length, 2);
  const review = f.control.reload(); f.respond(2, failedPolicy(2)); await review;
  assert.equal(f.view().originsText, "https://example.com"); assert.equal(f.view().dirty, false);
  assert.equal(f.view().retryDisabled, false); assert.equal(f.view().error, failedPolicy().error);
});

test("pending writes and startup errors never enable retry; later confirmed failure needs review", async () => {
  const f = fixture(); await load(f);
  edit(f); const save = f.control.apply(); f.requests[1].reject(new Error("Reply lost")); await save;
  const pending = f.control.refresh(); f.respond(2, { ...policy(2, "allow", ["https://example.com"]), ready: false }); await pending;
  assert.equal(f.view().label, "Unavailable"); assert.equal(f.view().retryVisible, false);
  await f.control.retry(); assert.equal(f.requests.length, 3);
  const settled = f.control.refresh(); f.respond(3, failedPolicy(2)); await settled;
  assert.equal(f.view().label, "Not saved"); assert.equal(f.view().retryDisabled, true);
  assert.equal(f.view().originsText, "https://example.com");
  const startup = fixture(); await load(startup, { ...policy(0), ready: false, error: "Read failed" });
  assert.equal(startup.view().retryVisible, false); await startup.control.retry(); assert.equal(startup.requests.length, 1);
});

test("changed failed candidates cannot silently replace a reviewed candidate on repeated polls", async () => {
  const f = fixture(); await load(f, failedPolicy(2));
  for (let i = 0; i < 2; i++) {
    const poll = f.control.refresh(); f.respond(i + 1, failedPolicy(2, "block", ["https://other.example"])); await poll;
    assert.equal(f.view().originsText, "https://example.com"); assert.equal(f.view().retryDisabled, true);
    assert.equal(f.view().conflict, true);
  }
  await f.control.retry(); assert.equal(f.requests.length, 3);
  const review = f.control.reload(); f.respond(3, failedPolicy(2, "block", ["https://other.example"])); await review;
  assert.equal(f.view().mode, "block"); assert.equal(f.view().retryDisabled, false);
});

test("stale polls cannot overwrite retry success and a lost retry reply requires a new check", async () => {
  const f = fixture(); await load(f, failedPolicy(2));
  const old = f.control.refresh(); const retry = f.control.retry();
  f.respond(2, policy(3, "allow", ["https://example.com"])); await retry;
  f.respond(1, failedPolicy(2)); await old;
  assert.equal(f.view().label, "Saved"); assert.equal(f.applied.length, 1);
  const g = fixture(); await load(g, failedPolicy(4));
  const lost = g.control.retry(); g.requests[1].reject(new Error("Worker disconnected")); await lost;
  assert.equal(g.view().label, "Unavailable"); assert.equal(g.view().retryVisible, false);
  await g.control.retry(); assert.equal(g.requests.length, 2);
  const poll = g.control.refresh(); g.respond(2, failedPolicy(4)); await poll;
  assert.equal(g.view().retryDisabled, false); assert.equal(g.applied.length, 0);
});

test("retry rejection stays not saved and a misleading successful reply cannot claim acceptance", async () => {
  const f = fixture(); await load(f, failedPolicy(2));
  const retry = f.control.retry(); f.respond(1, failedPolicy(3), { ok: false, error: "Write failed again" }); await retry;
  assert.equal(f.view().label, "Not saved"); assert.equal(f.view().retryDisabled, true);
  assert.equal(f.applied.length, 0); assert.match(f.view().error, /Write failed again/);
  await f.control.retry(); assert.equal(f.requests.length, 2);
  const review = f.control.reload(); f.respond(2, failedPolicy(3)); await review;
  const second = f.control.retry(); f.respond(3, failedPolicy(4)); await second;
  assert.notEqual(f.view().label, "Saved"); assert.equal(f.applied.length, 0);
});

test("retry success must confirm the exact candidate at its next revision", async () => {
  for (const value of [policy(2, "allow", ["https://example.com"]), policy(3), policy(4, "allow", ["https://example.com"])]) {
    const f = fixture(); await load(f, failedPolicy(2));
    const retry = f.control.retry(); f.respond(1, value); await retry;
    assert.equal(f.view().label, "Unavailable"); assert.equal(f.applied.length, 0);
    assert.equal(f.view().originsText, "https://example.com");
  }
});

test("confirmed recovery clears stale save errors without discarding a draft or validation error", async () => {
  const f = fixture(); await load(f); edit(f, " https://EXAMPLE.com/ ");
  const save = f.control.apply(); f.requests[1].reject(new Error("Worker disconnected")); await save;
  const failed = f.control.refresh(); f.respond(2, failedPolicy(2)); await failed;
  assert.equal(f.view().error, failedPolicy().error);
  const recovered = f.control.refresh(); f.respond(3, policy(3, "allow", ["https://example.com"])); await recovered;
  assert.equal(f.view().error, ""); assert.equal(f.view().originsText, " https://EXAMPLE.com/ ");
  assert.equal(f.view().dirty, true); assert.equal(f.view().conflict, true);
  const reopened = fixture(); await load(reopened, failedPolicy(2));
  const poll = reopened.control.refresh(); reopened.respond(1, policy(3, "allow", ["https://example.com"])); await poll;
  assert.equal(reopened.view().label, "Saved"); assert.equal(reopened.view().error, ""); assert.equal(reopened.applied.length, 0);
  const invalid = fixture(); await load(invalid); edit(invalid, "https://example.com/private");
  const rejected = invalid.control.apply(); invalid.respond(1, policy(), { ok: false, error: "Origin must not contain a path" }); await rejected;
  const same = invalid.control.refresh(); invalid.respond(2, policy()); await same;
  assert.match(invalid.view().error, /path/); assert.equal(invalid.view().dirty, true);
});

test("malformed retryable status cannot enable retry", async () => {
  for (const value of [
    { ...failedPolicy(), retryable: "true" }, { ...failedPolicy(), ready: undefined },
    { ...failedPolicy(), origins: [""] }, { ...failedPolicy(), revision: -1 }
  ]) {
    const f = fixture(); await load(f, value);
    assert.equal(f.view().retryVisible, false); assert.equal(f.view().applyDisabled, true);
    await f.control.retry(); assert.equal(f.requests.length, 1);
  }
});

test("every submitted apply or retry refreshes control after success, rejection or lost reply", async () => {
  for (const method of ["apply", "retry"]) {
    for (const outcome of ["success", "rejected", "lost"]) {
      const f = fixture(); await load(f, method === "retry" ? failedPolicy(1) : policy(1));
      if (method === "apply") edit(f);
      const attempt = f.control[method]();
      assert.equal(f.settled.length, 0, `${method}/${outcome} must remain pending until its reply`);
      if (outcome === "lost") f.requests[1].reject(new Error("Worker disconnected"));
      else if (outcome === "rejected") f.respond(1, failedPolicy(2), { ok: false, error: "Write failed" });
      else f.respond(1, policy(2, "allow", ["https://example.com"]));
      await attempt;
      assert.equal(f.settled.length, 1, `${method}/${outcome} must refresh automation status exactly once`);
      assert.equal(f.settled[0].pending, null);
      assert.equal(f.applied.length, outcome === "success" ? 1 : 0);
      assert.equal(f.requests.length, 2);
    }
  }
});

test("read failures, blocked actions and local validation do not report a settled save attempt", async () => {
  const f = fixture(); await load(f, { ...policy(0), ready: false, error: "Storage read failed" });
  await f.control.apply(); await f.control.retry();
  assert.equal(f.requests.length, 1); assert.equal(f.settled.length, 0);
  const g = fixture(); await load(g); await g.control.apply(); await g.control.retry();
  edit(g, Array.from({ length: 101 }, (_, i) => `https://site${i}.example`).join("\n"));
  await g.control.apply();
  assert.equal(g.requests.length, 1); assert.equal(g.settled.length, 0); assert.equal(g.applied.length, 0);
});

const unreadPolicy = (state = "read-error", id = "read-attempt-1") => ({
  ...policy(0), ready: false, error: state === "invalid" ? "Stored settings are invalid" : "Saved settings could not be read",
  recovery: { state, ...(id === undefined ? {} : { id }) }
});

test("unknown and invalid saved settings never display the initial allow-all value", async () => {
  const f = fixture();
  assert.equal(f.view().mode, ""); assert.equal(f.view().listVisible, false);
  await load(f, unreadPolicy("invalid"));
  assert.equal(f.view().mode, ""); assert.equal(f.view().revision, null);
  assert.equal(f.view().label, "Unavailable"); assert.equal(f.view().editingDisabled, true);
  assert.equal(f.view().applyDisabled, true); assert.equal(f.view().retryVisible, false);
  assert.equal(f.view().recoverVisible, true); assert.equal(f.view().recoverDisabled, false);
  assert.match(f.view().message, /invalid/i); assert.doesNotMatch(f.view().message, /Saved settings loaded|default applies/);
  await f.control.apply(); await f.control.retry();
  assert.equal(f.requests.length, 1);
});

test("a pending native read or unavailable startup gate cannot be recovered by the popup", async () => {
  for (const value of [
    { ...unreadPolicy(), recovery: { state: "pending" } },
    { ...unreadPolicy(), recovery: { state: "read-error" } },
    { ...unreadPolicy("invalid"), recovery: { state: "invalid" } }
  ]) {
    const f = fixture(); await load(f, value);
    assert.equal(f.view().recoverDisabled, true); assert.equal(f.view().mode, "");
    assert.equal(f.view().editingDisabled, true); assert.equal(f.view().applyDisabled, true);
    await f.control.recover(); assert.equal(f.requests.length, 1);
    const poll = f.control.refresh(); f.respond(1, value); await poll;
    assert.deepEqual(f.requests.map(item => item.message.type), ["GET_SITE_ACCESS_POLICY", "GET_SITE_ACCESS_POLICY"]);
    assert.equal(f.settled.length, 0);
  }
});

test("explicit read recovery uses only the original id and confirms loaded settings without saving or resuming", async () => {
  const f = fixture(); await load(f, unreadPolicy());
  const recover = f.control.recover();
  assert.deepEqual(f.requests[1].message, { type: "RECOVER_SITE_ACCESS_POLICY", expectedRecoveryId: "read-attempt-1" });
  assert.equal(f.view().pending, "recover"); assert.equal(f.view().recoverDisabled, true);
  assert.equal(f.view().reloadDisabled, true); assert.equal(f.view().editingDisabled, true);
  assert.match(f.view().message, /Reading saved settings/);
  await f.control.recover(); await f.control.refresh(); await f.control.reload(); await f.control.apply(); await f.control.retry();
  edit(f); assert.equal(f.requests.length, 2);
  f.respond(1, { ...policy(8, "allow", ["https://only.example"]), stored: true }); await recover;
  assert.equal(f.view().mode, "allow"); assert.equal(f.view().revision, 8);
  assert.equal(f.view().originsText, "https://only.example"); assert.equal(f.view().recoverVisible, false);
  assert.match(f.view().message, /reloaded.*remain paused/); assert.doesNotMatch(f.view().message, /Settings saved and/);
  assert.equal(f.applied.length, 0); assert.deepEqual(f.settled, [{ pending: null, label: "Saved" }]);
  assert.deepEqual(f.requests.map(item => item.message.type), ["GET_SITE_ACCESS_POLICY", "RECOVER_SITE_ACCESS_POLICY"]);
});

test("confirmed missing storage is Default, not Saved, including recovery", async () => {
  for (const recovery of [false, true]) {
    const f = fixture(), absent = { ...policy(0), stored: false };
    await load(f, recovery ? unreadPolicy() : absent);
    if (recovery) { const attempt = f.control.recover(); f.respond(1, absent); await attempt; }
    assert.equal(f.view().label, "Default"); assert.equal(f.view().mode, "all");
    assert.match(f.view().message, /No saved settings/); assert.match(f.view().message, /default/i);
    assert.equal(/remain paused/.test(f.view().message), recovery);
    assert.equal(f.applied.length, 0); assert.equal(f.view().editingDisabled, false);
    assert.equal(f.requests.some(item => /SET_SITE|RETRY_SITE|RESUME/.test(item.message.type)), false);
  }
});

test("repeated actual read rejection offers only the new failure id and never falls back to allow-all", async () => {
  const f = fixture(); await load(f, unreadPolicy());
  const attempt = f.control.recover();
  f.respond(1, unreadPolicy("invalid", "read-attempt-2"), { ok: false, error: "Stored settings are invalid" }); await attempt;
  assert.equal(f.view().label, "Unavailable"); assert.equal(f.view().mode, "");
  assert.equal(f.view().recoverDisabled, false); assert.equal(f.applied.length, 0);
  assert.equal(f.requests.length, 2); assert.equal(f.settled.length, 1);
  const again = f.control.recover();
  assert.deepEqual(f.requests[2].message, { type: "RECOVER_SITE_ACCESS_POLICY", expectedRecoveryId: "read-attempt-2" });
  f.respond(2, policy(5, "block", ["https://blocked.example"])); await again;
  assert.equal(f.view().mode, "block"); assert.equal(f.applied.length, 0);
});

test("a lost recovery reply requires a new status check and never reuses its unconfirmed id", async () => {
  const f = fixture(); await load(f, unreadPolicy());
  const attempt = f.control.recover(); f.requests[1].reject(new Error("Worker disconnected")); await attempt;
  assert.equal(f.view().label, "Unavailable"); assert.equal(f.view().recoverDisabled, true);
  assert.doesNotMatch(f.view().message, /remain paused/);
  await f.control.recover(); assert.equal(f.requests.length, 2); assert.equal(f.settled.length, 1);
  const verify = f.control.refresh(); f.respond(2, unreadPolicy("read-error", "read-attempt-2")); await verify;
  assert.equal(f.view().recoverDisabled, false);
  const again = f.control.recover(); assert.equal(f.requests[3].message.expectedRecoveryId, "read-attempt-2");
  f.respond(3, policy(3)); await again;
  assert.equal(f.applied.length, 0);
});

test("older polls cannot resurrect a recovery id after success or replace the latest failure", async () => {
  const f = fixture(); await load(f, unreadPolicy());
  const old = f.control.refresh(), newer = f.control.refresh();
  f.respond(2, unreadPolicy("invalid", "latest")); await newer;
  f.respond(1, unreadPolicy("read-error", "old")); await old;
  const stale = f.control.refresh(), recover = f.control.recover();
  assert.equal(f.requests[4].message.expectedRecoveryId, "latest");
  f.respond(4, policy(4)); await recover;
  f.respond(3, unreadPolicy("read-error", "stale")); await stale;
  assert.equal(f.view().label, "Saved"); assert.equal(f.view().recoverVisible, false);
  await f.control.recover(); assert.equal(f.requests.length, 5);
});

test("malformed recovery states cannot enable recovery, editing or a save", async () => {
  for (const value of [
    { ...unreadPolicy(), ready: true }, { ...unreadPolicy(), retryable: true },
    { ...unreadPolicy(), recovery: { state: "pending", id: "not-settled" } },
    { ...unreadPolicy(), recovery: { state: "read-error", id: "" } },
    { ...unreadPolicy(), recovery: { state: "read-error", id: 4 } },
    { ...unreadPolicy(), recovery: { state: "read-error", id: "x".repeat(129) } },
    { ...unreadPolicy(), recovery: { state: "unknown", id: "untrusted" } },
    { ...policy(), stored: "false" }, { ...policy(9, "allow", ["https://example.com"]), stored: false }
  ]) {
    const f = fixture(); await load(f, value);
    assert.equal(f.view().label, "Unavailable"); assert.equal(f.view().recoverDisabled, true);
    assert.equal(f.view().editingDisabled, true); assert.equal(f.view().applyDisabled, true);
    await f.control.recover(); await f.control.apply(); assert.equal(f.requests.length, 1);
  }
});

test("an unconfirmed successful recovery reply is not a save or another automatic read", async () => {
  for (const value of [unreadPolicy("pending", undefined), failedPolicy(2), { ...policy(), recovery: { state: "read-error", id: "wrong" } }]) {
    const f = fixture(); await load(f, unreadPolicy());
    const attempt = f.control.recover(); f.respond(1, value); await attempt;
    assert.equal(f.view().label, "Unavailable"); assert.equal(f.view().recoverDisabled, true);
    assert.equal(f.applied.length, 0); assert.equal(f.settled.length, 1);
    await f.control.recover(); assert.equal(f.requests.length, 2);
  }
});

test("unknown policy preserves a draft internally and only explicit reload discards it", async () => {
  const f = fixture(); await load(f, policy(3)); edit(f, " https://draft.example/ ");
  const poll = f.control.refresh(); f.respond(1, unreadPolicy()); await poll;
  assert.equal(f.view().mode, ""); assert.equal(f.view().listVisible, false);
  assert.equal(f.view().editingDisabled, true); assert.equal(f.view().dirty, true);
  const recover = f.control.recover(); f.respond(2, policy(4, "block", ["https://saved.example"])); await recover;
  assert.equal(f.view().mode, "allow"); assert.equal(f.view().originsText, " https://draft.example/ ");
  assert.equal(f.view().dirty, true); assert.equal(f.view().conflict, true);
  const reload = f.control.reload(); f.respond(3, policy(4, "block", ["https://saved.example"])); await reload;
  assert.equal(f.view().mode, "block"); assert.equal(f.view().dirty, false);
});

test("the popup binds read recovery to its dedicated button and refreshes automation only after settlement", async () => {
  const html = readFileSync(new URL("./popup.html", import.meta.url), "utf8");
  assert.match(html, /<option value="" disabled selected>Saved settings not loaded<\/option>/);
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, {
    value: "", textContent: "", dataset: {}, disabled: false, hidden: false, listeners: {},
    addEventListener(type, callback) { this.listeners[type] = callback; }
  }]));
  const requests = []; let refreshes = 0;
  const context = {
    document: { getElementById: id => { assert.ok(elements.has(id), `Missing popup element ${id}`); return elements.get(id); } },
    chromeApi: { runtime: { sendMessage: message => new Promise((resolve, reject) => requests.push({ message, resolve, reject })) } },
    automationControl: { refresh: () => { refreshes++; } }, createSiteAccessControl
  };
  const source = readFileSync(new URL("./popup.js", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("const siteAccessMode ="), source.indexOf("\nrenderExtensionVersion();"));
  assert.ok(block.length > 1000);
  vm.runInNewContext(`${block}\nglobalThis.control = siteAccessControl;`, context);
  const initial = context.control.refresh(); requests[0].resolve({ ok: true, policy: unreadPolicy() }); await initial;
  const button = elements.get("site-access-recover");
  assert.equal(button.hidden, false); assert.equal(button.disabled, false);
  assert.equal(elements.get("site-access-mode").value, "");
  button.listeners.click();
  assert.equal(requests[1].message.type, "RECOVER_SITE_ACCESS_POLICY");
  assert.equal(requests[1].message.expectedRecoveryId, "read-attempt-1");
  assert.equal(button.disabled, true); assert.equal(refreshes, 0);
  requests[1].resolve({ ok: true, policy: { ...policy(8, "allow", ["https://only.example"]), stored: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(button.hidden, true); assert.equal(elements.get("site-access-mode").value, "allow");
  assert.equal(elements.get("site-access-status").textContent, "Saved");
  assert.equal(refreshes, 1); assert.equal(requests.length, 2);
});

test("explicit recovery accepts a new worker's lower saved revision or confirmed absence", async () => {
  for (const recovered of [policy(3, "block", ["https://repaired.example"]), { ...policy(0), stored: false }]) {
    const f = fixture(); await load(f, policy(4, "allow", ["https://old.example"]));
    const failed = f.control.refresh(); f.respond(1, unreadPolicy("read-error", "new-worker-read")); await failed;
    const old = f.control.refresh(), recover = f.control.recover();
    f.respond(3, recovered); await recover;
    assert.equal(f.view().revision, recovered.revision);
    assert.equal(f.view().mode, recovered.mode);
    assert.equal(f.view().label, recovered.stored === false ? "Default" : "Saved");
    assert.equal(f.view().error, ""); assert.equal(f.applied.length, 0);
    f.respond(2, policy(9, "allow", ["https://stale.example"])); await old;
    assert.equal(f.view().revision, recovered.revision, "the old poll must not replace the explicit read authority");
    if (recovered.revision > 0) {
      const regressed = f.control.refresh(); f.respond(4, policy(2)); await regressed;
      assert.equal(f.view().revision, recovered.revision, "ordinary GET replies still cannot lower the new authority");
    }
  }
});

test("cross-worker recovery retains a dirty draft and requires review before saving against a lower revision", async () => {
  const f = fixture(); await load(f, policy(8)); edit(f, " https://draft.example/ ");
  const failed = f.control.refresh(); f.respond(1, unreadPolicy("invalid", "repaired-worker")); await failed;
  const recover = f.control.recover(); f.respond(2, policy(2, "block", ["https://saved.example"])); await recover;
  assert.equal(f.view().revision, 2); assert.equal(f.view().mode, "allow");
  assert.equal(f.view().originsText, " https://draft.example/ "); assert.equal(f.view().dirty, true);
  assert.equal(f.view().conflict, true); assert.equal(f.view().applyDisabled, true);
  await f.control.apply(); assert.equal(f.requests.length, 3);
  const review = f.control.reload(); f.respond(3, policy(2, "block", ["https://saved.example"])); await review;
  assert.equal(f.view().dirty, false); assert.equal(f.view().mode, "block"); assert.equal(f.view().conflict, false);
  assert.equal(f.applied.length, 0);
});

test("after a lost explicit recovery reply a fresh status check can confirm its new read authority", async () => {
  for (const method of ["refresh", "reload"]) {
    const f = fixture(); await load(f, policy(9, "allow", ["https://old.example"]));
    const failed = f.control.refresh(); f.respond(1, unreadPolicy("read-error", "new-worker")); await failed;
    const old = f.control.refresh(), recover = f.control.recover();
    f.requests[3].reject(new Error("Recovery reply lost")); await recover;
    const verified = f.control[method](); f.respond(4, policy(3, "block", ["https://recovered.example"])); await verified;
    assert.equal(f.view().revision, 3); assert.equal(f.view().mode, "block");
    assert.equal(f.view().label, "Saved"); assert.equal(f.view().error, "");
    assert.equal(f.view().recoverVisible, false); assert.equal(f.applied.length, 0);
    assert.doesNotMatch(f.view().message, /remain paused/, "a lost reply must not claim the transition's cleanup acknowledgment");
    f.respond(2, policy(10, "allow", ["https://stale.example"])); await old;
    assert.equal(f.view().revision, 3, "pre-recovery polls are still fenced");
    const lower = f.control.refresh(); f.respond(5, policy(2)); await lower;
    assert.equal(f.view().revision, 3, "the recovered authority exception is consumed once");
    assert.equal(f.requests.filter(item => item.message.type === "RECOVER_SITE_ACCESS_POLICY").length, 1);
  }
});

test("same-revision recovered settings require explicit review before applying an old dirty draft", async () => {
  const f = fixture(); await load(f, policy(9, "allow", ["https://old.example"]));
  edit(f, " https://draft.example/ ");
  const failed = f.control.refresh(); f.respond(1, unreadPolicy("invalid", "repaired-worker")); await failed;
  const recover = f.control.recover(); f.respond(2, policy(9, "block", ["https://new.example"])); await recover;
  assert.equal(f.view().revision, 9); assert.equal(f.view().originsText, " https://draft.example/ ");
  assert.equal(f.view().dirty, true); assert.equal(f.view().conflict, true);
  assert.equal(f.view().applyDisabled, true);
  await f.control.apply(); assert.equal(f.requests.length, 3, "direct controller calls must also enforce review");
  const review = f.control.reload(); f.respond(3, policy(9, "block", ["https://new.example"])); await review;
  assert.equal(f.view().mode, "block"); assert.equal(f.view().dirty, false); assert.equal(f.view().conflict, false);
  edit(f, "https://after-review.example"); const save = f.control.apply();
  assert.equal(f.requests[4].message.expectedRevision, 9);
  f.respond(4, policy(10, "allow", ["https://after-review.example"])); await save;
});
