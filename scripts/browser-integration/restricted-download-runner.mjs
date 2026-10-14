import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createOriginalDownloadRelay } from "./original-download-relay.mjs";
import { runOriginalDownloadCaller, runOriginalDownloadProcess } from "./original-download-callers.mjs";
import { checkRestrictedDownloadPolicy, checkRestrictedDownloadCaller, checkRestrictedDownloadBoundaries } from "./restricted-download-fixture.mjs";

const message = error => (error?.stack ?? String(error)) + (error instanceof AggregateError ?
  `\nUnderlying failures:\n${error.errors.map(message).join("\n")}` : "");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

// Keep the original five public callers and their real process/ready receipts.
// This adapter neither starts a second input nor supplies a path to the product.
async function prepareCallers({ runDir, directory, executable, endpoint, pythonBinary, pythonSnapshot, goBinary, until, detail }) {
  const python = path.join(runDir, "python-original-download-checks.py");
  const go = path.join(runDir, process.platform === "win32" ? "go-original-download-checks.exe" : "go-original-download-checks");
  const gates = path.join(runDir, "restricted-download-gates");
  await fs.mkdir(gates);
  await fs.copyFile(path.join(directory, "python-original-download-checks.py"), python, fsConstants.COPYFILE_EXCL);
  await fs.copyFile(goBinary, go, fsConstants.COPYFILE_EXCL);
  detail.callerIdentity = { pythonSHA256: digest(await fs.readFile(python)), goSHA256: digest(await fs.readFile(go)) };
  return kind => kind === "js" ? undefined : async ({ scope, afterReady, ...input }) => {
    const params = { socketPath: endpoint, sessionId: scope.session_id, turnId: scope.turn_id, controlEpoch: scope.control_epoch, ...input };
    const evidence = { kind, input: params };
    let failure;
    try {
      if (kind === "cli" || kind === "mcp") {
        evidence.result = await runOriginalDownloadCaller({ ...params, downloadKind: input.kind, kind, executable, afterReady });
      } else {
        evidence.process = {};
        const readyPath = path.join(gates, `${input.key}.ready.json`), releasePath = path.join(gates, `${input.key}.release`);
        params.readyGate = { readyPath, releasePath, token: randomUUID() };
        const child = runOriginalDownloadProcess({ command: kind === "python" ? pythonBinary : go,
          args: kind === "python" ? [python] : [], input: JSON.stringify(params), timeoutMs: 45000, detail: evidence.process,
          env: { ...process.env, PYTHONPATH: path.dirname(pythonSnapshot), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" } });
        let ready, observing = true;
        try {
          await Promise.race([
            until(async () => { if (!observing) return true; ready = JSON.parse(await fs.readFile(readyPath, "utf8")); return true; }, "restricted download typed ready receipt", 15000),
            child.then(() => { throw new Error("Typed caller exited before its ready release"); })
          ]).finally(() => { observing = false; });
          assert.equal(ready.token, params.readyGate.token);
          evidence.ready = ready;
          await Promise.race([afterReady(ready), child.then(() => { throw new Error("Typed caller exited during its ready barrier"); })]);
          const temporary = releasePath + ".pending";
          await fs.writeFile(temporary, params.readyGate.token, { flag: "wx" });
          await fs.rename(temporary, releasePath);
          evidence.releasePublishedAt = Date.now();
          evidence.result = JSON.parse(await child);
        } catch (error) {
          try { await child; } catch (childError) { evidence.childError = message(childError); }
          throw error;
        }
      }
      assert.equal(evidence.result.caller, kind);
    } catch (error) {
      failure = error; evidence.error = message(error);
      evidence.partial = error.originalDownloadCallerDetail ?? error.originalDownloadDetail;
    }
    try { await fs.writeFile(path.join(runDir, `restricted-download-caller-${kind}-${input.key}.json`), JSON.stringify(evidence, null, 2), { flag: "wx" }); }
    catch (error) { evidence.persistenceError = message(error); failure ??= error; }
    if (failure) { failure.restrictedDownloadCallerEvidence = evidence; throw failure; }
    return evidence.result;
  };
}

export async function runRestrictedPageDownloads({ connectBrowser, getWorker, withSettings, fixture, fixtureURL, until,
  runDir, directory, executable, endpoint, pythonBinary, pythonSnapshot, goBinary, bindingIdentity, getBrowserLog }) {
  const detail = { boundary: "Original allowed-document Blob downloads through production binding; HTTP/POST provenance remains unproven",
    identity: bindingIdentity, callers: [], cleanup: [] };
  let relay, failure;
  const save = (name, value) => fs.writeFile(path.join(runDir, name), JSON.stringify(value, null, 2));
  try {
    const callerFor = await prepareCallers({ runDir, directory, executable, endpoint, pythonBinary, pythonSnapshot, goBinary, until, detail });
    detail.settings = await withSettings(async popup => {
      // The existing settings workflow restarts its worker. Bind only after it
      // restores the original policy and passes us its still-live popup.
      relay = await createOriginalDownloadRelay({ targetURL: bindingIdentity.browserVersion.webSocketDebuggerUrl });
      const controller = await connectBrowser("restricted-download-binding");
      try {
        detail.beforeBinding = await controller.client.getInfo();
        assert.equal(detail.beforeBinding.metadata.pageDownloads.available, false);
        detail.bindingProcess = {};
        detail.binding = JSON.parse(await runOriginalDownloadProcess({ command: executable,
          args: ["bind-browser", "--socket", endpoint, "--cdp-url", relay.url, "--exclusive", "--timeout", "20s"],
          detail: detail.bindingProcess, timeoutMs: 25000 }));
        assert.equal(detail.bindingProcess.closeObserved, true);
        assert.equal(detail.bindingProcess.exitCode, 0);
        assert.equal(detail.binding.result.bound, true);
        detail.afterBinding = await controller.client.getInfo();
        assert.equal(detail.afterBinding.metadata.pageDownloads.available, true);
        assert.equal(detail.afterBinding.metadata.pageDownloads.generation, detail.binding.result.generation);
        detail.bindingProof = await getWorker().evaluate("globalThis.__obuNativeDownloadBinding");
        assert.equal(detail.bindingProof.extensionId, bindingIdentity.extensionId);
        for (const key of ["extensionId", "extensionInstanceId", "workerBootId", "portId"])
          assert.equal(detail.bindingProof[key], detail.binding.result[key]);
      } finally { controller.close(); }
      detail.policy = await checkRestrictedDownloadPolicy({ popup, fixtureURL, until,
        saveDetail: value => save("restricted-download-policy.json", value),
        runAllowed: async () => {
          for (const kind of ["js", "cli", "mcp", "python", "go"]) {
            const owner = await connectBrowser(`restricted-download-${kind}`);
            const record = { kind, detail: {} }; detail.callers.push(record);
            let callerFailure;
            try {
              record.result = await checkRestrictedDownloadCaller({ kind, browser: owner, getWorker, fixture, fixtureURL,
                downloadRoot: path.join(runDir, "downloads"), relay, until, caller: callerFor(kind), detail: record.detail });
            } catch (error) {
              callerFailure = error; record.error = message(error);
              if (error.restrictedDownloadCallerEvidence) record.failedCallerEvidence = error.restrictedDownloadCallerEvidence;
            }
            finally {
              try { record.finalize = await owner.client.finalizeTabs([]); }
              catch (error) { record.cleanupError = message(error); callerFailure ??= error; }
              try {
                const variants = record.detail.variants ?? [];
                const tabIds = [...new Set(variants.map(value => value.tabId))];
                const targetIds = [...new Set(variants.flatMap(value => [value.before, value.after].flatMap(snapshot => [
                  ...(snapshot?.targets ?? []).filter(target => target.tabId === value.tabId).map(target => target.id),
                  ...(snapshot?.oopifs ?? []).filter(target => target.tabId === value.tabId).map(target => target.targetId)
                ])).filter(value => typeof value === "string" && value))];
                record.cleanupEvidence = { tabIds, targetIds };
                await until(async () => {
                  const remaining = await getWorker().evaluate(`(async()=>({tabs:(await chrome.tabs.query({})).filter(value=>${JSON.stringify(tabIds)}.includes(value.id)),targets:(await chrome.debugger.getTargets()).filter(value=>${JSON.stringify(tabIds)}.includes(value.tabId)||${JSON.stringify(targetIds)}.includes(value.id))}))()`);
                  record.cleanupEvidence.remaining = remaining;
                  return remaining.tabs.length === 0 && remaining.targets.length === 0;
                }, "original restricted download owner tabs and child targets released", 3000);
              } catch (error) { record.cleanupEvidenceError = message(error); callerFailure ??= error; }
              owner.close();
              try { await save(`restricted-download-${kind}.json`, record); }
              catch (error) { record.evidenceError = message(error); callerFailure ??= error; }
            }
            if (callerFailure) throw callerFailure;
          }
        },
        runBoundaries: async controls => {
          const value = await checkRestrictedDownloadBoundaries({ connectBrowser, getWorker, fixture, fixtureURL,
            downloadRoot: path.join(runDir, "downloads"), relay, controls, until,
            saveDetail: result => save("restricted-download-boundaries.json", result) });
          let boundaryFailure;
          try {
            const blocked = value.cases.find(item => item.name === "shared-opaque-no-native-download");
            assert.ok(blocked, "The shared opaque case must preserve the browser's own rejection");
            const original = blocked.after.documents.find(item => item.result.button);
            assert.ok(original?.result.state.blobURL);
            // The final chromium.log is written during teardown. Preserve the
            // original stderr prefix available now; never read a future file.
            const log = getBrowserLog();
            assert.equal(typeof log, "string");
            const artifact = "restricted-download-chromium-prefix.log";
            await fs.writeFile(path.join(runDir, artifact), log, { flag: "wx" });
            const lines = log.split(/\r?\n/).filter(line =>
              line.includes(`Not allowed to load local resource: ${original.result.state.blobURL}`) &&
              line.includes(`source: ${original.result.href} (`));
            assert.equal(lines.length, 1, "Original Chromium console must reject this exact source and Blob; timeout alone is insufficient");
            value.browserSourceRejection = { artifact, sha256: digest(log), bytes: Buffer.byteLength(log), sourceURL: original.result.href,
              blobURL: original.result.state.blobURL, documentId: original.documentId, lines };
          } catch (error) { value.browserSourceRejectionError = message(error); boundaryFailure = error; }
          try { await save("restricted-download-boundaries.json", value); }
          catch (error) { boundaryFailure = boundaryFailure ? new AggregateError([boundaryFailure, error], "Browser rejection and evidence persistence failed") : error; }
          if (boundaryFailure) throw boundaryFailure;
          return value;
        }
      });
    });
  } catch (error) { failure = error; detail.error = message(error); }
  finally {
    if (relay) {
      try { await relay.close(); detail.cleanup.push({ resource: "original Browser relay", closed: true }); }
      catch (error) { detail.cleanup.push({ resource: "original Browser relay", error: message(error) }); failure ??= error; }
      detail.relay = relay.snapshot();
    }
    detail.server = fixture.allStats();
    try { await save("restricted-download-proof.json", detail); }
    catch (error) { failure = failure ? new AggregateError([failure, error], "Download proof and evidence persistence failed") : error; }
  }
  if (failure) throw failure;
  return { evidence: "restricted-download-proof.json", callers: detail.callers.length };
}
