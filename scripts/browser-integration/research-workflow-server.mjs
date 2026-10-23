// Independent shared-task material server. This process never controls a browser.
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createResearchWorkflowFixture, researchWorkflowTask } from "./research-workflow-fixture.mjs";
import { createResearchRequestLedger } from "./research-request-ledger.mjs";

const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== "--paired-comparison"))
  throw Error("Usage: research-workflow-server.mjs [--paired-comparison]");
const pairedComparison = args.length === 1, material = new Map(), taskDefinitions = [];
if (pairedComparison) for (const round of [1, 2]) {
  const nonce = randomUUID();
  for (const side of ["obu", "codex"]) {
    const key = `p15-r${round}-${side}-${randomUUID().replaceAll("-", "")}`;
    material.set(key, nonce); taskDefinitions.push({ id: "R", round, side, pairId: `p15-research-r${round}`, key });
  }
}

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../.tmp/browser-integration");
await fs.mkdir(root, { recursive: true });
const output = await fs.mkdtemp(path.join(root, "research-comparison-"));
let writes = Promise.resolve(), failure, port;
const ledger = createResearchRequestLedger();
const recordFailure = error => { failure ??= error; process.stderr.write(String(error) + "\n"); };
const fixture = createResearchWorkflowFixture({
  ...(pairedComparison ? { nonceFactory: key => material.get(key) } : {}),
  onChange() {
    const snapshot = JSON.stringify(fixture.allStats(), null, 2);
    writes = writes.then(() => fs.writeFile(path.join(output, "server-evidence.json"), snapshot + "\n"))
      .catch(recordFailure);
  }
});
const server = createServer((request, response) => {
  ledger.observe(request, response);
  if (pairedComparison) {
    const url = new URL(request.url, `http://127.0.0.1:${port}`), match = /^\/research-task\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!match || !material.has(match[1]) || (!match[2] && url.searchParams.get("variant") !== "3")) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); response.end("Research task route not found"); return;
    }
  }
  if (fixture.handle(request, response, port)) return;
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); response.end("Research task route not found");
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
port = server.address().port;
const ready = { url: `http://127.0.0.1:${port}/`, output, startedAt: new Date().toISOString(), node: process.version, pid: process.pid,
  fixtureSha256: createHash("sha256").update(await fs.readFile(path.join(directory, "research-workflow-fixture.mjs"))).digest("hex"),
  serverSha256: createHash("sha256").update(await fs.readFile(fileURLToPath(import.meta.url))).digest("hex") };
if (pairedComparison) ready.tasks = taskDefinitions.map(({ key, ...task }) => ({ ...task,
  url: `${ready.url}research-task/${key}?variant=3`, instructions: researchWorkflowTask() }));
await fs.writeFile(path.join(output, "ready.json"), JSON.stringify(ready, null, 2) + "\n");
process.stdout.write(JSON.stringify(ready) + "\n");
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  let requestLedger = null;
  try {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const deadline = setTimeout(() => {
      recordFailure(Error("Research server connections did not close within 5 seconds")); server.closeAllConnections();
    }, 5000);
    try { await closed; } finally { clearTimeout(deadline); }
    const snapshot = await ledger.seal();
    if (!snapshot.complete) recordFailure(Error(snapshot.failures.join("; ")));
    await writes;
    // Each write is attempted independently so a failed fixture snapshot cannot
    // silently suppress the global traffic record or the failure marker.
    try { await fs.writeFile(path.join(output, "server-evidence.json"), JSON.stringify(fixture.allStats(), null, 2) + "\n"); }
    catch (error) { recordFailure(error); }
    const bytes = Buffer.from(JSON.stringify(snapshot, null, 2) + "\n");
    try {
      await fs.writeFile(path.join(output, "request-ledger.json"), bytes, { flag: "wx" });
      requestLedger = { file: "request-ledger.json", sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length, complete: snapshot.complete, received: snapshot.received, overflow: snapshot.overflow,
        pending: snapshot.pending, responseFinished: snapshot.requests.filter(row => row.responseFinishedAt).length,
        responseAborted: snapshot.requests.filter(row => row.responseAbortedAt).length,
        requestAborted: snapshot.requests.filter(row => row.requestAbortedAt).length };
    } catch (error) { recordFailure(error); }
  } catch (error) { recordFailure(error); server.closeAllConnections(); }
  try { await fs.writeFile(path.join(output, "closed.json"), JSON.stringify({ at: new Date().toISOString(),
    failure: failure ? String(failure) : null, requestLedger }) + "\n", { flag: "wx" }); }
  catch (error) { recordFailure(error); }
  process.stdin.pause(); process.exitCode = failure ? 1 : 0;
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { if (chunk.trim() === "stop") void stop(); });
process.once("SIGINT", () => void stop()); process.once("SIGTERM", () => void stop());
