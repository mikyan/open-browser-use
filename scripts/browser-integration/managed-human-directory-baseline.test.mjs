import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { createManagedHumanDirectoryBaselineFixture, classifyManagedHumanDirectoryBaseline,
  assertManagedHumanDirectoryBaselineDocument } from "./managed-human-directory-baseline.mjs";
import { managedFileChooserCompletion } from "./managed-human-file-chooser-check.mjs";

function evidence() {
  return { lease: { leaseId: "original", fileChooserVersion: 1 }, target: { id: "root", tabId: 7 }, frameId: "root", clickAt: 100,
    events: [{ sequence: 1, at: 110, method: "Page.fileChooserOpened", source: { targetId: "root", tabId: 7 }, params: { frameId: "root", backendNodeId: 9, mode: "selectMultiple" } }],
    ui: { fileInputs: [{ id: "file-picker" }], error: "Original failure", humanStatus: "Ended", publishedState: { human: null, pendingFileChooser: null } },
    commands: [{ operation: "humanInput" }], inputReplies: [{ result: {} }, { error: { code: "UNKNOWN" } }] };
}
test("directory baseline keeps an existing ordinary picker and the original input failure", () => {
  const result = classifyManagedHumanDirectoryBaseline(evidence());
  assert.equal(result.featurePassed, false); assert.equal(result.missingDirectoryChannelObserved, true);
  assert.equal(result.inputOutcome, "native-input-error"); assert.equal(result.automaticRetirementObserved, true);
  assert.equal(result.originalUIError, "Original failure");
  const value = evidence(); value.inputReplies = [{ pending: true }];
  assert.equal(classifyManagedHumanDirectoryBaseline(value).inputOutcome, "native-input-pending-at-observation");
});
test("no Opening, ambiguous or foreign native identity never proves directory rejection", () => {
  for (const mutate of [value => { value.events = []; }, value => { value.events.push(structuredClone(value.events[0])); },
    value => { value.events[0].at = 99; }, value => { value.events[0].source.tabId++; },
    value => { value.events[0].source.targetId = "foreign"; }, value => { value.events[0].source.sessionId = "child"; },
    value => { value.events[0].params.frameId = "foreign"; }, value => { value.events[0].params.mode = "selectSingle"; },
    value => { value.events[0].params.backendNodeId = 0; }]) {
    const value = evidence(); mutate(value); assert.throws(() => classifyManagedHumanDirectoryBaseline(value));
  }
});
test("a new directory channel or supplied files invalidates this old-source baseline", () => {
  for (const mutate of [value => { value.lease.fileChooserVersion = 2; }, value => { value.ui.fileInputs = []; },
    value => { value.ui.publishedState.pendingFileChooser = { directory: true }; },
    value => { value.commands.push({ operation: "humanFileBegin" }); }]) {
    const value = evidence(); mutate(value); assert.throws(() => classifyManagedHumanDirectoryBaseline(value));
  }
});
test("directory document proof requires an unchanged actual directory FileList", () => {
  const value = { directory: true, multiple: true, files: [] };
  assert.equal(assertManagedHumanDirectoryBaselineDocument(value, structuredClone(value)).originalFileListUnchanged, true);
  assert.throws(() => assertManagedHumanDirectoryBaselineDocument(value, { ...value, directory: false }));
  assert.throws(() => assertManagedHumanDirectoryBaselineDocument(value, { ...value, files: [{ name: "unexpected" }] }));
});
test("directory baseline completion is diagnostic only and cannot use private hooks", () => {
  assert.deepEqual(managedFileChooserCompletion("directory-baseline", false, true), { featurePassed: false, diagnosticCompleted: true });
  assert.deepEqual(managedFileChooserCompletion("directory-baseline", false, false), { featurePassed: false, diagnosticCompleted: false });
  assert.throws(() => managedFileChooserCompletion("directory-baseline", true, true));
});
test("original directory fixture has one native input, no assignment and rejects replay", () => {
  const fixture = createManagedHumanDirectoryBaselineFixture();
  function get(method = "GET") {
    const response = new EventEmitter(); let code, body;
    response.writeHead = value => { code = value; };
    response.end = value => { body = value; response.writableFinished = true; response.emit("finish"); };
    assert.equal(fixture.handle({ method, url: fixture.route, resume() {} }, response), true);
    return { code, body };
  }
  const initial = get(); assert.equal(initial.code, 200);
  assert.match(initial.body, /type="file" id="upload" webkitdirectory multiple/);
  assert.doesNotMatch(initial.body, /showPicker|DataTransfer|setInputFiles|\.files\s*=/);
  assert.equal(get().code, 409); assert.equal(get("POST").code, 405);
  assert.deepEqual(fixture.stats().requests.map(row => row.status), [200, 409, 405]);
});
