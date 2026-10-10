import assert from "node:assert/strict";
import test from "node:test";
import { createAutomationControl } from "./popup-control.js";

const state = (name, revision = 1, extra = {}) => ({ state: name, revision, inputBlocked: name !== "running", cleanupComplete: name === "paused" || name === "running", ...extra });
function fixture() {
  const requests = [], views = [];
  const control = createAutomationControl({
    sendMessage: message => new Promise((resolve, reject) => requests.push({ message, resolve, reject })),
    render: view => views.push(view)
  });
  const resolve = (index, status, extra = {}) => requests[index].resolve({ ok: true, status, ...extra });
  return { control, requests, views, resolve, view: () => views.at(-1) };
}

test("pause blocks duplicate input and resume carries the displayed revision", async () => {
  const f = fixture();
  const initial = f.control.refresh(); f.resolve(0, state("running", 4)); await initial;
  const pause = f.control.activate();
  assert.equal(f.view().label, "Pausing"); assert.equal(f.view().disabled, true);
  await f.control.activate(); await f.control.refresh(); assert.equal(f.requests.length, 2);
  f.resolve(1, state("paused", 5)); await pause;
  assert.equal(f.view().buttonText, "Resume control");
  const resume = f.control.activate();
  assert.deepEqual(f.requests[2].message, { type: "RESUME_AUTOMATION", expectedRevision: 5 });
  assert.equal(f.view().label, "Paused"); assert.equal(f.view().buttonText, "Resuming…");
  f.resolve(2, state("running", 6)); await resume;
  assert.equal(f.view().label, "Running"); assert.match(f.view().hint, /ask your agent to continue/);
});

test("a status poll started before pause cannot replace busy or acknowledged state", async () => {
  const f = fixture();
  const initial = f.control.refresh(); f.resolve(0, state("running")); await initial;
  const stale = f.control.refresh();
  const pause = f.control.activate();
  f.resolve(1, state("running")); await stale;
  assert.equal(f.view().label, "Pausing");
  f.resolve(2, state("paused", 2)); await pause;
  assert.equal(f.view().label, "Paused");
});

test("out-of-order polls and older revisions do not restore Running", async () => {
  const f = fixture();
  const first = f.control.refresh(), second = f.control.refresh();
  f.resolve(1, state("paused", 3)); await second;
  f.resolve(0, state("running", 2)); await first;
  assert.equal(f.view().label, "Paused");
  const older = f.control.refresh(); f.resolve(2, state("running", 2)); await older;
  assert.equal(f.view().label, "Paused");
});

test("cleanup failure stays blocked and offers pause retry rather than resume", async () => {
  const f = fixture();
  const initial = f.control.refresh(); f.resolve(0, state("running")); await initial;
  const pause = f.control.activate();
  f.resolve(1, state("error", 2, { error: "Could not release debugger" }), { ok: false, error: "Could not release debugger" }); await pause;
  assert.equal(f.view().label, "Failed"); assert.equal(f.view().buttonText, "Retry pause");
  assert.match(f.view().message, /remain blocked/);
  const retry = f.control.activate(); assert.equal(f.requests[2].message.type, "PAUSE_AUTOMATION");
  f.resolve(2, state("paused", 2)); await retry;
  assert.equal(f.view().label, "Paused");
});

test("a lost resume reply is Unavailable until an explicit status query succeeds", async () => {
  const f = fixture();
  const initial = f.control.refresh(); f.resolve(0, state("paused", 2)); await initial;
  const resume = f.control.activate(); f.requests[1].reject(new Error("Worker disconnected")); await resume;
  assert.equal(f.view().label, "Unavailable"); assert.equal(f.view().action, "refresh");
  assert.doesNotMatch(f.view().message, /are blocked|remain blocked/);
  const refresh = f.control.activate(); assert.equal(f.requests[2].message.type, "GET_AUTOMATION_CONTROL_STATUS");
  f.resolve(2, state("running", 3)); await refresh;
  assert.equal(f.view().label, "Running");
});

test("invalid status never enables resume or claims blocked input", async () => {
  const f = fixture();
  const initial = f.control.refresh(); f.resolve(0, state("running", 1, { inputBlocked: true })); await initial;
  assert.equal(f.view().label, "Unavailable"); assert.equal(f.view().action, "refresh");
  const refresh = f.control.refresh(); f.resolve(1, state("paused", 2, { cleanupComplete: false })); await refresh;
  assert.equal(f.view().buttonText, "Retry pause"); assert.equal(f.view().action, "pause");
});

test("a rejected stale resume shows the current revision without automatic replay", async () => {
  const f = fixture();
  const initial = f.control.refresh(); f.resolve(0, state("paused", 2)); await initial;
  const resume = f.control.activate();
  f.resolve(1, state("paused", 4), { ok: false, error: "OBU_CONTROL_REVISION_CONFLICT" }); await resume;
  assert.equal(f.requests.length, 2); assert.match(f.view().error, /REVISION_CONFLICT/);
  const retry = f.control.activate(); assert.equal(f.requests[2].message.expectedRevision, 4);
  f.resolve(2, state("running", 5)); await retry;
});
