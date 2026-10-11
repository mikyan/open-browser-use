// Shared synthetic task server for manual, public-browser comparisons. It does
// not drive either browser and has no credentials, external requests or payments.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFormWorkflowFixture } from "./form-workflow-fixture.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(directory, "../..");
const root = path.join(repo, ".tmp/browser-integration");
await fs.mkdir(root, { recursive: true });
const output = await fs.mkdtemp(path.join(root, "form-comparison-"));
let writes = Promise.resolve(), failure, port;
const fixture = createFormWorkflowFixture({ onChange() {
  const snapshot = JSON.stringify(fixture.allStats(), null, 2);
  writes = writes.then(() => fs.writeFile(path.join(output, "server-evidence.json"), snapshot + "\n"))
    .catch(error => { failure = error; process.stderr.write(String(error) + "\n"); });
} });
const server = createServer((request, response) => {
  if (fixture.handle(request, response, port)) return;
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Synthetic workflow route not found");
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
port = server.address().port;
const ready = {
  url: `http://127.0.0.1:${port}/`, output, startedAt: new Date().toISOString(),
  fixtureSha256: createHash("sha256").update(await fs.readFile(path.join(directory, "form-workflow-fixture.mjs"))).digest("hex"),
  serverSha256: createHash("sha256").update(await fs.readFile(fileURLToPath(import.meta.url))).digest("hex"),
  node: process.version, pid: process.pid,
};
await fs.writeFile(path.join(output, "ready.json"), JSON.stringify(ready, null, 2) + "\n");
process.stdout.write(JSON.stringify(ready) + "\n");
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const closed = new Promise(resolve => server.close(resolve));
  server.closeAllConnections();
  await closed; await writes;
  await fs.writeFile(path.join(output, "server-evidence.json"), JSON.stringify(fixture.allStats(), null, 2) + "\n");
  await fs.writeFile(path.join(output, "closed.json"), JSON.stringify({ at: new Date().toISOString(), failure: failure ? String(failure) : null }) + "\n");
  process.stdin.pause();
  process.exitCode = failure ? 1 : 0;
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { if (chunk.trim() === "stop") void stop(); });
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
