import test from "node:test";
import assert from "node:assert/strict";
import { assertCreatedPageRevoked } from "./created-page-unowned.mjs";

const sample = () => ({
  item: { childId: 42, childURL: "http://127.0.0.1/created-page/child", createdTab: { windowId: 7 } },
  snapshot: { tab: { id: 42, windowId: 7, groupId: -1, pinned: false, url: "http://127.0.0.1/created-page/child" }, entry: null, owner: null, stored: [], targets: [] },
  tabs: [{ id: 21 }],
});

test("revocation permits a retained child and unrelated attached user tab", () => {
  const value = sample(); value.snapshot.targets.push({ tabId: 999, attached: true });
  assertCreatedPageRevoked(value);
});

test("a preserved native child cannot hide residual membership or debugger authority", () => {
  for (const change of [
    value => { value.snapshot.entry = { phase: "quarantined" }; },
    value => { value.snapshot.owner = { phase: "committed" }; },
    value => { value.snapshot.stored.push({ tabId: 42, phase: "committed" }); },
    value => { value.snapshot.targets.push({ tabId: 42, attached: true }); },
    value => { value.tabs.push({ id: 42 }); },
  ]) {
    const value = sample(); change(value); assert.throws(() => assertCreatedPageRevoked(value));
  }
});

test("revocation rejects substituted, moved, grouped, pinned or navigated children", () => {
  for (const [key, next] of Object.entries({ id: 43, windowId: 8, groupId: 2, pinned: true, url: "http://127.0.0.1/unrelated" })) {
    const value = sample(); value.snapshot.tab[key] = next; assert.throws(() => assertCreatedPageRevoked(value));
  }
});
