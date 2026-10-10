import assert from "node:assert/strict";
import test from "node:test";
import { createSiteAccessControl } from "./popup-site-access.js";

const policy = (revision = 1, mode = "all", origins = []) => ({ version: 1, revision, mode, origins, ready: true });
function fixture() {
  const requests = [], views = [], applied = [];
  const control = createSiteAccessControl({
    sendMessage: message => new Promise((resolve, reject) => requests.push({ message, resolve, reject })),
    render: view => views.push(view), onApplied: () => applied.push(true)
  });
  const respond = (index, value, extra = {}) => requests[index].resolve({ ok: true, policy: value, ...extra });
  return { control, requests, views, applied, respond, view: () => views.at(-1) };
}
async function load(f, value = policy()) {
  const refresh = f.control.refresh(); f.respond(0, value); await refresh;
}
const edit = (f, originsText = "https://example.com", mode = "allow") => f.control.edit({ mode, originsText });

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
