import assert from "node:assert/strict";
import test from "node:test";
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
