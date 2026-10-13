import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { updatePageSubscription } from "./browser-page-subscriptions.js";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test("queued changes use the live client listener count and the original Page receiver", async () => {
  const page = new EventEmitter(), gate = deferred(), calls = [], listener = () => {};
  page._channel = { updateSubscription(params) { assert.equal(this, page._channel); calls.push(params); return calls.length === 1 ? gate.promise : Promise.resolve(); } };
  page.on("requestfinished", listener);
  const first = updatePageSubscription(page, "requestfinished"); await tick();
  page.off("requestfinished", listener);
  const removal = updatePageSubscription(page, "requestfinished");
  page.on("requestfinished", listener);
  const replacement = updatePageSubscription(page, "requestfinished");
  await tick(); assert.equal(calls.length, 1); gate.resolve();
  await Promise.all([first, removal, replacement]);
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ({ event: "requestFinished", enabled: true })));
});

test("an actual rejection propagates unchanged while an explicit later command can restore the live filter", async () => {
  const page = new EventEmitter(), failure = new Error("native filter rejected"), calls = [];
  page._channel = { updateSubscription(params) { calls.push(params); return calls.length === 1 ? Promise.reject(failure) : Promise.resolve(); } };
  const first = updatePageSubscription(page, "response"), rejected = assert.rejects(first, error => error === failure);
  page.on("response", () => {}); const second = updatePageSubscription(page, "response");
  await rejected; await second; assert.equal(calls.length, 2); assert.equal(calls[1].enabled, true);
});

test("separate original Pages have independent queues and only a confirmed closed Page skips a command", async () => {
  const old = new EventEmitter(), next = new EventEmitter(), gate = deferred(); let calls = 0, closed = false;
  old.isClosed = () => closed; old._channel = { updateSubscription: () => gate.promise };
  next._channel = { updateSubscription: async () => { calls++; } };
  const held = updatePageSubscription(old, "console"); await tick();
  await updatePageSubscription(next, "console"); assert.equal(calls, 1);
  const cleanup = updatePageSubscription(old, "console"); closed = true; gate.resolve(); await held; await cleanup;
  assert.throws(() => updatePageSubscription(next, "pageerror"), /Unsupported/);
});
