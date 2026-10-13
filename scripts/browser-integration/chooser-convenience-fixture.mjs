import assert from "node:assert/strict";
import path from "node:path";
import { checkChooserWireCaller } from "./chooser-waits-callers.mjs";
import { chooserScope } from "./chooser-waits-fixture.mjs";

export function checkChooserConvenienceProcesses(processes, kind) {
  assert.ok(processes.length > 0, "Original caller process evidence is required");
  if (kind === "mcp") {
    assert.equal(processes.length, 2); assert.notEqual(processes[0].pid, processes[1].pid, "Owner and trigger require distinct live MCP processes");
  }
  assert.ok(processes.some(value => value.role === "owner")); assert.ok(processes.some(value => value.role === "trigger"));
  for (const process of processes) {
    assert.ok(Number.isSafeInteger(process.pid) && process.pid > 0);
    assert.equal(process.closeObserved, true, "Success requires the original child close event");
    assert.equal(process.exitCode, 0); assert.equal(process.signal, null);
    assert.equal(process.spawnError, undefined); assert.equal(process.terminationRequestedAt, undefined);
    assert.ok(Number.isFinite(process.startedAt) && process.closedAt >= process.startedAt);
  }
}

// Only the setter changes transport surface. Ready/click/collect/cancel keep
// the original generic wire calls and their explicitly captured legal scope.
export function createChooserConvenienceCaller({ kind, role, call, tool, executable, endpoint, sessionId, subprocess, detail }) {
  assert.ok(["cli", "mcp"].includes(kind)); assert.ok(["owner", "trigger"].includes(role));
  return async (method, params) => {
    const setter = method === "setFileChooserFiles";
    if (setter) {
      assert.equal(role, "owner"); assert.ok(typeof params.fileChooserId === "string" && params.fileChooserId);
      assert.ok(Array.isArray(params.files) && params.files.every(file => typeof file === "string" && file));
    }
    if (kind === "mcp" && !setter) return call(method, params);
    const record = setter ? { kind, role, method, sourceParams: structuredClone(params), startedAt: Date.now() } : null;
    if (record) detail.convenienceCalls.push(record);
    try {
      let response;
      if (kind === "cli") {
        const argv = setter ? ["set-file-chooser-files", "--socket", endpoint, "--session-id", sessionId, "--file-chooser-id", params.fileChooserId,
          ...(params.files.length ? params.files.flatMap(file => ["--file", file]) : ["--clear"]), "--timeout", "15s"] :
          ["call", "--socket", endpoint, "--session-id", sessionId, "--method", method, "--params", JSON.stringify(params), "--timeout", "15s"];
        const command = path.resolve(executable), process = { role, method, command, argv: [...argv] }; detail.callerProcesses.push(process);
        if (record) Object.assign(record, { command, argv: [...argv], processIndex: detail.callerProcesses.length - 1 });
        const stdout = await subprocess(command, argv, { processEvidence: process });
        response = JSON.parse(stdout); if (record) record.response = response;
        assert.ok(response && typeof response === "object");
        assert.equal(response.error, undefined, JSON.stringify(response));
      } else {
        const name = "set_file_chooser_files", args = { file_chooser_id: params.fileChooserId, files: [...params.files] };
        Object.assign(record, { tool: name, arguments: structuredClone(args) });
        const result = await tool(name, args); record.response = result;
        assert.equal(result.isError, false, JSON.stringify(result)); response = result.structuredContent;
        assert.ok(response && typeof response === "object"); assert.equal(response.error, undefined, JSON.stringify(response));
      }
      assert.ok(Object.hasOwn(response, "result"), "Original wire result is missing");
      if (record) { record.completedAt = Date.now(); record.passed = true; }
      return response.result;
    } catch (error) {
      if (record) { record.failedAt = Date.now(); record.passed = false; record.error = error?.stack ?? String(error); }
      throw error;
    }
  };
}

// Called after the two original change/POST events and cancellation. This is
// a fixed, read-only projection in the exact native documentId, not another
// selection, a script-generated change event or a replayed business action.
export function readChooserConvenienceClear() {
  const input = document.querySelector("#upload"), evidence = globalThis.chooserEvidence;
  return { href: location.href, documentToken: evidence?.documentToken,
    input: input ? { id: input.id, type: input.type, connected: input.isConnected, filesLength: input.files?.length, value: input.value } : null,
    clicks: evidence?.clicks, changes: evidence?.changes };
}
export function checkChooserConvenienceClear(item, results) {
  const post = item.server.posts[1], matches = item.frames.frames.filter(frame => frame.url === post.href);
  assert.equal(matches.length, 1); const original = matches[0];
  assert.ok(typeof original.documentId === "string" && original.documentId); assert.equal(original.documentLifecycle, "active"); assert.equal(original.errorOccurred, false);
  assert.equal(results.length, 1); const actual = results[0];
  assert.equal(actual.documentId, original.documentId); assert.equal(actual.frameId, original.frameId);
  assert.equal(actual.result.href, post.href); assert.equal(actual.result.documentToken, post.documentToken);
  assert.deepEqual(actual.result.input, { id: "upload", type: "file", connected: true, filesLength: 0, value: "" });
  assert.deepEqual(actual.result.clicks, post.clicks); assert.deepEqual(actual.result.changes, post.changes);
  return { documentId: original.documentId, frameId: original.frameId, documentToken: post.documentToken, filesLength: 0, value: "" };
}

export function checkChooserConvenienceScope(initialScope, variants, currentScope) {
  assert.ok(variants.length > 0, "The original workflow must admit a tab before scope verification");
  const admitted = variants[0].scope;
  assert.ok(admitted && Number.isSafeInteger(admitted.control_epoch) && admitted.control_epoch > 0);
  for (const field of ["session_id", "turn_id"]) {
    assert.ok(typeof initialScope[field] === "string" && initialScope[field]);
    assert.equal(admitted[field], initialScope[field]);
  }
  // connectOpenBrowserUse may not bootstrap until the existing newTab call.
  // Preserve that initial state separately; never invent an epoch or make an
  // extra browser call just to warm up this acceptance helper.
  if (initialScope.control_epoch != null) assert.equal(admitted.control_epoch, initialScope.control_epoch);
  for (const item of variants) assert.deepEqual(item.scope, admitted, "Every original variant must retain the first admitted scope");
  assert.deepEqual(currentScope, admitted, "The owner must retain the original admitted scope");
  return { ...admitted };
}

export async function checkChooserConvenience({ kind, owner, executable, endpoint, fixtureURL, files, server, worker, until, subprocess, withMCPClient, detail = {} }) {
  assert.ok(["cli", "mcp"].includes(kind));
  Object.assign(detail, { caller: `${kind}-convenience`, independentConnections: true, variants: [], callerProcesses: [], convenienceCalls: [], passed: false,
    boundary: "Original waits/clicks/collect/cancel retain explicit scope. Dedicated convenience setters use their existing client session/control negotiation and the original chooser ID; no raw setter fallback. Two original change/POST events are followed only by an exact-document file-input read. Caller success requires actual process close." });
  const initialScope = detail.initialScope = chooserScope(owner), sessionId = initialScope.session_id;
  const adapt = (role, call, tool) => createChooserConvenienceCaller({ kind, role, call, tool, executable, endpoint, sessionId, subprocess, detail });
  const run = (callA, callB) => checkChooserWireCaller({ kind: detail.caller, owner, callA, callB, fixtureURL, files, server, worker, until, detail });
  try {
    if (kind === "mcp") {
      const first = { role: "owner" }, second = { role: "trigger" }; detail.callerProcesses.push(first, second);
      await withMCPClient(executable, endpoint, sessionId, (callA, toolA) =>
        withMCPClient(executable, endpoint, sessionId, (callB, toolB) => run(adapt("owner", callA, toolA), adapt("trigger", callB, toolB)), second), first);
    } else await run(adapt("owner"), adapt("trigger"));
    detail.passed = false;
    checkChooserConvenienceProcesses(detail.callerProcesses, kind);
    detail.scope = checkChooserConvenienceScope(initialScope, detail.variants, chooserScope(owner));
    assert.equal(detail.convenienceCalls.length, 6);
    for (const [index, item] of detail.variants.entries()) {
      for (const [sequence, event] of item.waits.entries()) {
        const call = detail.convenienceCalls[index * 2 + sequence];
        assert.equal(call.passed, true); assert.deepEqual(call.sourceParams, { ...item.scope, fileChooserId: event.result.fileChooserId,
          files: sequence === 0 ? (item.variant === "root" ? files.slice(0, 1) : files).map(file => file.path) : [] });
      }
      const href = item.server.posts[1].href, frames = item.frames.frames.filter(frame => frame.url === href);
      assert.equal(frames.length, 1); assert.ok(frames[0].documentId);
      item.clearedInput = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${item.tabId},documentIds:${JSON.stringify([frames[0].documentId])}},world:'MAIN',func:${readChooserConvenienceClear.toString()}})`);
      item.clearProof = checkChooserConvenienceClear(item, item.clearedInput);
      assert.equal(server.stats(item.key).posts.length, 2, "Read-only clear verification must not replay business submission");
    }
    detail.passed = true; detail.completedAt = Date.now(); return detail;
  } catch (error) { detail.passed = false; detail.error = error?.stack ?? String(error); throw error; }
}
