// One public task selected from the original paired server. No browser actions.
import assert from "node:assert/strict";
import path from "node:path";
import { researchWorkflowTask, checkResearchReceipt } from "./research-workflow-fixture.mjs";
import { managedResearchBudgetMs, managedResearchCleanupBudgetMs, managedResearchStartupBudgetMs, verifyClosedManagedResearchRecording } from "./managed-research-support.mjs";

const keys = (value, expected, label) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), label);
};
const time = value => assert.ok(Number.isSafeInteger(value) && value > 0, "Original integer UTC milliseconds required");
const sha = value => assert.match(value, /^[0-9a-f]{64}$/);

export function parseManagedPairedResearchArguments(args) {
  assert.equal(args.length, 4, "Usage: managed-paired-research-check.mjs --ready <absolute ready.json> --round <1|2>");
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    assert.ok(["--ready", "--round"].includes(args[index]) && !values.has(args[index]), "Unknown or repeated paired argument");
    values.set(args[index], args[index + 1]);
  }
  assert.ok(typeof values.get("--ready") === "string" && path.isAbsolute(values.get("--ready")), "Original absolute ready path required");
  assert.ok(["1", "2"].includes(values.get("--round")), "Select the original round 1 or 2");
  return { readyFile: path.resolve(values.get("--ready")), round: Number(values.get("--round")) };
}

export function selectPairedResearchTask(ready, { round, side = "obu" }) {
  assert.ok([1, 2].includes(round) && ["obu", "codex"].includes(side));
  keys(ready, ["url", "output", "startedAt", "node", "pid", "fixtureSha256", "serverSha256", "tasks"], "Original paired server ready schema required");
  const origin = new URL(ready.url);
  assert.equal(origin.protocol, "http:"); assert.equal(origin.hostname, "127.0.0.1");
  assert.ok(Number(origin.port) >= 1 && Number(origin.port) <= 65535);
  assert.equal(ready.url, `${origin.origin}/`); assert.ok(path.isAbsolute(ready.output));
  assert.equal(new Date(ready.startedAt).toISOString(), ready.startedAt);
  assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 0); assert.match(ready.node, /^v\d+\.\d+\.\d+$/);
  sha(ready.fixtureSha256); sha(ready.serverSha256);
  assert.ok(Array.isArray(ready.tasks)); assert.equal(ready.tasks.length, 4);
  const combinations = new Set(), urls = new Set();
  for (const task of ready.tasks) {
    keys(task, ["id", "round", "side", "pairId", "url", "instructions"], "Only the original public paired fields are accepted");
    assert.equal(task.id, "R"); assert.ok([1, 2].includes(task.round)); assert.ok(["obu", "codex"].includes(task.side));
    assert.equal(task.pairId, `p15-research-r${task.round}`); assert.equal(task.instructions, researchWorkflowTask());
    const url = new URL(task.url), key = url.pathname.slice("/research-task/".length);
    assert.equal(url.origin, origin.origin); assert.equal(url.search, "?variant=3"); assert.equal(url.hash, "");
    assert.equal(url.pathname, `/research-task/${key}`);
    assert.match(key, new RegExp(`^p15-r${task.round}-${task.side}-[0-9a-f]{32}$`));
    assert.equal(task.url, `${origin.origin}/research-task/${key}?variant=3`);
    const combination = `${task.round}/${task.side}`;
    assert.equal(combinations.has(combination), false, "Repeated paired slot"); combinations.add(combination);
    assert.equal(urls.has(task.url), false, "Paired tasks must have separate keys"); urls.add(task.url);
  }
  const task = ready.tasks.find(item => item.round === round && item.side === side);
  return { round, side, slot: round === 1 ? (side === "obu" ? 1 : 2) : (side === "codex" ? 3 : 4), pairId: task.pairId,
    origin: origin.origin, instructions: task.instructions,
    task: { attempt: 1, taskId: new URL(task.url).pathname.slice("/research-task/".length), url: task.url, budgetMs: managedResearchBudgetMs } };
}

export function managedPairedResearchLaunchCard({ sdkPath, recordingModule, socketPath, artifactDir, selection }) {
  for (const file of [sdkPath, recordingModule, artifactDir]) assert.ok(typeof file === "string" && path.isAbsolute(file));
  assert.ok(typeof socketPath === "string" && socketPath.startsWith("\\\\.\\pipe\\"));
  assert.equal(selection.side, "obu");
  const { task } = selection, url = new URL(task.url);
  assert.equal(task.attempt, 1); assert.equal(task.budgetMs, managedResearchBudgetMs);
  assert.equal(url.origin, selection.origin); assert.equal(url.pathname, `/research-task/${task.taskId}`); assert.equal(url.search, "?variant=3");
  assert.match(task.taskId, new RegExp(`^p15-r${selection.round}-obu-[0-9a-f]{32}$`));
  return { version: 1, sdkPath, recordingModule, socketPath, artifactDir, instructions: selection.instructions,
    tasks: [{ attempt: 1, taskId: task.taskId, url: task.url, budgetMs: managedResearchBudgetMs, recordingDir: path.join(artifactDir, "recording-1") }],
    startupObservationBudgetMs: managedResearchStartupBudgetMs, cleanupBudgetMs: managedResearchCleanupBudgetMs,
    protocol: "One original task only. Use createRecordedAgentSDK({sdkPath,directory: tasks[0].recordingDir}) from recordingModule, then connect through the supplied named pipe with sessionId equal to taskId. Only connectOpenBrowserUse and beginTurn are preparation calls. Before the first other public API call, atomically write start-1.json {attempt:1,taskId,startedAt:Date.now()}. All protocol times must be positive safe-integer UTC milliseconds; never use filesystem timestamps. Read the public task and current sources through the formal SDK, solve independently and save once. Do not read fixture/server/ready files, other attempts, private scoring or audit outputs. Do not use host CDP, direct HTTP, browser-internal state or evaluate mutations to perform business. After reading the original saved report, finalizeTabs with only that tab as deliverable; then explicitly browser.close(), await recording.closeLog(), and atomically write attempt-1.json {attempt:1,taskId,success,reportTabId,summary,startedAt,completedAt:Date.now()}. On failure preserve the first error, partial results and pending-call status without replay; reportTabId may be null. Record preparation failure immediately with its actual start/end even if no start marker exists. Await ack-1.json, then end; there is no next task. Business is limited to 900000ms from the first non-preparation call; cleanup is limited to 60000ms from the last business settlement. No business API is allowed after finalizeTabs. closeLog does not wait for or cancel pending calls. Protocol files are milestones, not proof of solver process liveness." };
}

export function verifyPairedResearchViewerTabs({ initialTabs, resultEntry, currentTabs }) {
  assert.ok(initialTabs.every(row => row.kind === "browser"));
  assert.ok(resultEntry?.kind === "result" && resultEntry.watchable === true && typeof resultEntry.deliveryId === "string" && resultEntry.deliveryId.length > 0);
  const expected = [...initialTabs, resultEntry];
  for (const rows of [expected, currentTabs]) {
    assert.ok(rows.every(row => Number.isSafeInteger(row.id)));
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length, "Duplicate viewer tab identity");
  }
  const ordered = rows => [...rows].sort((a, b) => a.id - b.id);
  assert.deepEqual(ordered(currentTabs), ordered(expected), "Exactly the original browser pages and this original report must remain");
  return { originalTabIds: initialTabs.map(row => row.id), reportTabId: resultEntry.id, total: expected.length };
}

// Check time from original recorded calls, not from the solver's summary.
// Six-source reading and lawful evaluator use still require the independent
// semantic trace audit; counting a served source is not proof of reading it.
export function verifyPairedResearchTiming(text, { task, terminal, enabledAt, receivedAt, socketPath }) {
  const closed = verifyClosedManagedResearchRecording(text);
  const rows = text.trimEnd().split("\n").map(line => JSON.parse(line));
  const calls = rows.filter(row => row.phase === "start"), settlements = new Map(rows.filter(row => row.phase === "return" || row.phase === "throw").map(row => [row.callId, row]));
  for (const value of [enabledAt, receivedAt, terminal.startedAt, terminal.completedAt, closed.close.at.wallMs]) time(value);
  let previous = enabledAt;
  for (const row of rows) {
    const stamp = row.phase === "start" ? row.start : row.phase === "close" ? row.at : row.end;
    time(stamp.wallMs); assert.match(stamp.monotonicNs, /^\d+$/);
    assert.ok(stamp.wallMs >= previous && stamp.wallMs <= receivedAt, "Original public trace time is out of order"); previous = stamp.wallMs;
  }
  const connections = calls.filter(row => row.operation === "connectOpenBrowserUse"); assert.equal(connections.length, 1);
  const connection = connections[0].args?.properties?.[0]?.properties;
  assert.equal(connection?.socketPath, socketPath); assert.equal(connection?.sessionId, task.taskId);
  assert.equal(settlements.get(connections[0].callId)?.phase, "return");
  const preparations = new Set(["connectOpenBrowserUse", "beginTurn"]);
  const first = calls.find(row => !preparations.has(row.operation)); assert.ok(first, "No business call was recorded");
  assert.ok(terminal.startedAt >= enabledAt && terminal.startedAt <= first.start.wallMs, "First business call preceded its start marker");
  assert.ok(calls.some(row => JSON.stringify(row.args).includes(task.url)), "Original task URL was not passed to the public SDK");
  const finalizations = calls.filter(row => row.operation === "finalizeTabs"); assert.equal(finalizations.length, 1);
  const finalize = finalizations[0]; assert.equal(finalize.receiver.kind, "OpenBrowserUseClient");
  assert.equal(settlements.get(finalize.callId)?.phase, "return", "Original finalization did not succeed");
  const kept = finalize.args?.properties?.[0]?.properties;
  assert.equal(kept?.length, 1); assert.equal(kept?.[0]?.properties?.tabId, terminal.reportTabId); assert.equal(kept?.[0]?.properties?.status, "deliverable");
  const before = calls.slice(calls.indexOf(first), calls.indexOf(finalize)); assert.ok(before.length > 0);
  const lastBusinessAt = Math.max(...before.map(row => settlements.get(row.callId).end.wallMs));
  assert.ok(lastBusinessAt <= finalize.start.wallMs, "Business was still pending during finalization");
  const after = calls.slice(calls.indexOf(finalize) + 1); assert.equal(after.length, 1, "Only SDK connection close may follow finalization");
  assert.equal(after[0].operation, "close"); assert.equal(after[0].receiver.kind, "OpenBrowserUseBrowser");
  assert.equal(settlements.get(after[0].callId)?.phase, "return");
  assert.ok(after[0].start.wallMs >= settlements.get(finalize.callId).end.wallMs);
  assert.ok(closed.close.at.wallMs <= terminal.completedAt && terminal.completedAt <= receivedAt);
  const businessMs = lastBusinessAt - first.start.wallMs, cleanupMs = terminal.completedAt - lastBusinessAt;
  assert.ok(businessMs >= 0 && businessMs <= managedResearchBudgetMs, "Original business budget exceeded");
  assert.ok(cleanupMs >= 0 && cleanupMs <= managedResearchCleanupBudgetMs, "Original cleanup budget exceeded");
  return { firstBusinessCallId: first.callId, firstBusinessAt: first.start.wallMs, lastBusinessAt, businessMs, cleanupMs,
    finalizationCallId: finalize.callId, closedAt: closed.close.at.wallMs, calls: closed.calls, semanticReadingAudit: "pending" };
}

// Called by the final audit only, after the external server has actually ended.
// This checks the known task's complete request ledger; the independent server
// HTTP ledger is also required to exclude requests outside the fixture routes.
export function verifyPairedResearchBusiness({ selection, receipt, ledger, businessStartedAt, businessCompletedAt }) {
  time(businessStartedAt); time(businessCompletedAt); assert.ok(businessCompletedAt >= businessStartedAt);
  assert.equal(ledger?.key, selection.task.taskId); assert.equal(ledger.variant, 3);
  const result = checkResearchReceipt(receipt, ledger), posts = ledger.requests.filter(row => row.method === "POST");
  assert.equal(posts.length, 1, "Every known-task POST, including unsuccessful or unfinished requests, must be accounted for");
  assert.equal(posts[0].route, "submit"); assert.equal(posts[0].url, `${selection.origin}/research-task/${selection.task.taskId}/submit`);
  for (const row of ledger.requests) {
    time(row.at); assert.ok(row.at >= businessStartedAt, "Task was requested before the actual first business call");
    assert.ok(["GET", "POST"].includes(row.method), "Unexpected business HTTP method");
  }
  assert.ok(ledger.posts[0].at <= businessCompletedAt && posts[0].at <= businessCompletedAt);
  assert.ok(ledger.requests.some(row => row.method === "GET" && row.route === "report" && row.at <= businessCompletedAt));
  return { ...result, taskKey: ledger.key, knownTaskPOSTs: 1 };
}

export function verifyPairedResearchMaterials(ready, records) {
  selectPairedResearchTask(ready, { round: 1 });
  assert.equal(records.length, 4); assert.equal(new Set(records.map(row => row.key)).size, 4);
  const selected = ready.tasks.map(task => selectPairedResearchTask(ready, task));
  const rows = selected.map(item => { const row = records.find(record => record.key === item.task.taskId); assert.ok(row); assert.equal(row.variant, 3); assert.equal(row.overflow, false); return row; });
  for (const round of [1, 2]) {
    const pair = rows.filter((_row, index) => selected[index].round === round);
    assert.equal(pair[0].nonce, pair[1].nonce); assert.notEqual(pair[0].key, pair[1].key);
    for (const vendor of ["a", "b", "c"]) for (const kind of ["quote", "terms"]) assert.deepEqual(pair[0].documents[vendor][kind], pair[1].documents[vendor][kind], "Same-round current facts and revisions differ");
  }
  assert.notEqual(rows.find((_row, i) => selected[i].round === 1).nonce, rows.find((_row, i) => selected[i].round === 2).nonce);
  return { rounds: 2, attempts: 4, sameRoundFacts: true, separateTaskKeys: true, newSecondRoundMaterial: true };
}
