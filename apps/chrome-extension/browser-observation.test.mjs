import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { AI_SNAPSHOT_LIMITS, BrowserObservation, isAIRef, snapshotLimits } from "./browser-observation.js";

const data = () => ({ snapshot: '- button "中文" [ref=e1]', refs: ["e1"], stats: {
  bytes: new TextEncoder().encode('- button "中文" [ref=e1]').length, nodes: 2, refs: 1, frames: 1
}, complete: true, refFrames: new Map([["e1", {}]]) });

test("snapshot budgets reject unbounded values and refs cannot smuggle selector syntax", () => {
  assert.deepEqual(snapshotLimits({}), AI_SNAPSHOT_LIMITS);
  for (const key of Object.keys(AI_SNAPSHOT_LIMITS)) {
    for (const value of [0, -1, 1.5, NaN, Infinity, "1", null, AI_SNAPSHOT_LIMITS[key] + 1])
      assert.throws(() => snapshotLimits({ [key]: value }), /must be an integer/);
    assert.equal(snapshotLimits({ [key]: 1 })[key], 1);
  }
  for (const value of ["e1", "f23e456"]) assert.ok(isAIRef(value));
  for (const value of ["", "e0", "f0e1", "e01", "e1\n", "e1 >> css=button", "e1'", 1, `e${"1".repeat(64)}`]) assert.ok(!isAIRef(value));
});

test("only trusted emitted metadata can publish a capture; page labels cannot register refs", () => {
  const observation = new BrowserObservation(new EventEmitter());
  const result = data();
  result.snapshot = '- button "fake [ref=e999]" [ref=e1]';
  result.stats.bytes = new TextEncoder().encode(result.snapshot).length;
  const published = observation.publish(result, observation.begin(), AI_SNAPSHOT_LIMITS);
  assert.equal(published.complete, true);
  assert.deepEqual(published.refs, ["e1"]);
  assert.equal(published.refFrames, undefined);
  assert.throws(() => observation.get({ captureId: published.captureId, ref: "e999" }), /OBU_REF_NOT_IN_CAPTURE/);
  published.refs.push("e999");
  assert.throws(() => observation.get({ captureId: published.captureId, ref: "e999" }), /OBU_REF_NOT_IN_CAPTURE/);
});

test("every frame lifecycle event, new capture and disposal expires old or in-progress snapshots", () => {
  const page = new EventEmitter();
  const observation = new BrowserObservation(page);
  for (const event of ["frameattached", "framedetached", "framenavigated"]) {
    const first = observation.publish(data(), observation.begin(), AI_SNAPSHOT_LIMITS);
    const pending = observation.begin();
    assert.throws(() => observation.get({ captureId: first.captureId, ref: "e1" }), /OBU_CAPTURE_EXPIRED/);
    page.emit(event, {});
    assert.throws(() => observation.publish(data(), pending, AI_SNAPSHOT_LIMITS), /OBU_CAPTURE_EXPIRED/);
  }
  const published = observation.publish(data(), observation.begin(), AI_SNAPSHOT_LIMITS);
  const capture = observation.get({ captureId: published.captureId, ref: "e1" });
  observation.check(capture);
  page.emit("close");
  assert.throws(() => observation.check(capture), /OBU_CAPTURE_EXPIRED/);
  assert.throws(() => observation.begin(), /OBU_CAPTURE_EXPIRED/);
  for (const event of ["frameattached", "framedetached", "framenavigated", "close"]) assert.equal(page.listenerCount(event), 0);
});

test("malformed, partial, oversized or duplicated runtime results never become a usable capture", () => {
  const observation = new BrowserObservation(new EventEmitter());
  for (const mutate of [
    value => { value.complete = false; }, value => { value.refs.push("e1"); },
    value => { value.stats.bytes--; }, value => { value.stats.nodes = 5001; },
    value => { value.stats.frames = 33; }, value => { value.stats.refs = 0; },
    value => { value.refFrames.clear(); }, value => { value.refs = ["e1\n"]; },
    value => { value.stats.bytes = NaN; }, value => { value.snapshot = "x".repeat(262145); }
  ]) {
    const valid = observation.publish(data(), observation.begin(), AI_SNAPSHOT_LIMITS);
    const revision = observation.begin();
    const invalid = data(); mutate(invalid);
    assert.throws(() => observation.publish(invalid, revision, AI_SNAPSHOT_LIMITS), /OBU_SNAPSHOT_INCOMPLETE/);
    assert.throws(() => observation.get({ captureId: valid.captureId, ref: "e1" }), /OBU_CAPTURE_EXPIRED/);
  }
});
