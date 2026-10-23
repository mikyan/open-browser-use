// Public controlled-form tasks only. This process never controls a browser.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { buildManagedAgentFormApp, createManagedAgentFormFixture } from "./managed-agent-form-fixture.mjs";
import { createResearchRequestLedger } from "./research-request-ledger.mjs";
import { listenFixture } from "./fixture-listener.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourceNames = ["managed-agent-form-fixture.mjs", "managed-agent-form-app.jsx", "managed-agent-form-server.mjs", "research-request-ledger.mjs", "fixture-listener.mjs"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceNames.map(async name => [name, hash(await fs.readFile(path.join(directory, name)))])));

export async function startManagedAgentFormServer({ output } = {}) {
  assert.ok(typeof output === "string" && path.isAbsolute(output), "A fresh absolute output directory is required");
  const destination = path.resolve(output);
  await fs.mkdir(destination); // Existing evidence is never overwritten.
  const servers = [], sockets = new Set(), failures = [];
  const fail = error => { const message = String(error?.stack ?? error); if (!failures.includes(message)) failures.push(message); };
  let port, stopping;
  const write = async (file, bytes) => {
    await fs.writeFile(path.join(destination, file), bytes, { flag: "wx" });
    return { file, bytes: bytes.length, sha256: hash(bytes) };
  };
  const closeListeners = async ({ force = false } = {}) => {
    const closing = Promise.all(servers.map(server => new Promise((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close(error => error ? reject(error) : resolve());
    })));
    let deadline;
    if (force) for (const server of servers) server.closeAllConnections();
    else deadline = setTimeout(() => {
      fail(Error("Form server connections did not close within 5 seconds"));
      for (const server of servers) server.closeAllConnections();
    }, 5000);
    try { await closing; } finally { clearTimeout(deadline); }
    await new Promise(resolve => setImmediate(resolve));
  };
  try {
    const sources = await sourceHashes(), app = await buildManagedAgentFormApp();
    assert.ok(typeof app.code === "string" && app.code.length > 0 && app.metadata && typeof app.metadata === "object", "Original app build required");
    const appBytes = Buffer.from(app.code), appIdentity = { sha256: hash(appBytes), bytes: appBytes.length };
    assert.equal(app.metadata.sha256, appIdentity.sha256); assert.equal(app.metadata.bytes, appIdentity.bytes);
    assert.deepEqual(await sourceHashes(), sources, "Form source changed while building");
    const appBuild = await write("app-build.json", jsonBytes(app.metadata));
    await write("app.bundle.js", appBytes);
    const definitions = [[1, 1, "obu"], [2, 1, "codex"], [3, 2, "codex"], [4, 2, "obu"]]
      .map(([slot, round, side]) => ({ slot, round, side, taskId: `maf-r${round}-${side}-${randomUUID().replaceAll("-", "")}` }));
    const fixture = createManagedAgentFormFixture({ tasks: definitions, appJavaScript: app.code }), ledger = createResearchRequestLedger();
    const handle = (request, response) => {
      ledger.observe(request, response); // Includes invalid hosts, private paths and every 404.
      const closeFinishedIdleConnections = () => {
        if (stopping && request.complete && response.writableFinished)
          for (const server of servers) server.closeIdleConnections();
      };
      request.once("end", closeFinishedIdleConnections); response.once("finish", closeFinishedIdleConnections);
      response.setHeader("Cache-Control", "no-store");
      try {
        const url = new URL(request.url, `http://${request.headers.host}`);
        if (!request.url.startsWith("/") || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || Number(url.port) !== port || url.username || url.password) {
          request.resume(); response.writeHead(400); response.end("Invalid form task host"); return;
        }
        if (fixture.handle(request, response, port)) return;
        request.resume(); response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); response.end("Form task route not found");
      } catch (error) {
        fail(error); request.resume();
        if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Form task handling failed");
      }
    };
    for (const host of ["127.0.0.1", "::1"]) {
      const server = createServer(handle); servers.push(server);
      server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
      if (port === undefined) port = await listenFixture(server);
      else await new Promise((resolve, reject) => {
        const cleanup = () => { server.off("error", failed); server.off("listening", listening); };
        const failed = error => { cleanup(); reject(error); };
        const listening = () => { cleanup(); resolve(); };
        server.once("error", failed); server.once("listening", listening);
        server.listen({ host, port, ipv6Only: true, exclusive: true });
      });
    }
    const ready = { version: 1, kind: "managed-agent-form", pid: process.pid, node: process.version,
      startedAt: new Date().toISOString(), output: destination, origin: `http://127.0.0.1:${port}`, sources,
      app: appIdentity, tasks: fixture.publicTasks(port) };
    assert.deepEqual(ready.tasks.map(({ slot, round, side, taskId }) => ({ slot, round, side, taskId })), definitions);
    const readyFile = await write("ready.json", jsonBytes(ready));
    return { ready,
      close(reason = "explicit") {
        if (!stopping) stopping = (async () => {
          await closeListeners();
          const snapshot = await ledger.seal();
          if (!snapshot.complete) fail(Error(snapshot.failures.join("; ")));
          let serverEvidence = null, requestLedger = null;
          // Independent writes retain the global ledger even if fixture serialization fails.
          try { serverEvidence = await write("server-evidence.json", jsonBytes(fixture.allStats())); }
          catch (error) { fail(error); }
          try {
            requestLedger = { ...await write("request-ledger.json", jsonBytes(snapshot)), complete: snapshot.complete,
              received: snapshot.received, overflow: snapshot.overflow, pending: snapshot.pending,
              responseFinished: snapshot.requests.filter(row => row.responseFinishedAt).length,
              responseAborted: snapshot.requests.filter(row => row.responseAbortedAt).length,
              requestAborted: snapshot.requests.filter(row => row.requestAbortedAt).length };
          } catch (error) { fail(error); }
          const serverClosed = servers.every(server => !server.listening);
          if (!serverClosed || sockets.size) fail(Error("Original form listeners or connections remain open"));
          const closed = { version: 1, kind: ready.kind, phase: "stopped", reason, at: new Date().toISOString(),
            pid: process.pid, output: destination, serverClosed, openConnections: sockets.size,
            complete: failures.length === 0, failures: [...failures], ready: readyFile, appBuild, serverEvidence, requestLedger };
          await write("closed.json", jsonBytes(closed));
          if (!closed.complete) throw Error("Form server did not close with complete evidence: " + failures.join("; "));
          return closed;
        })();
        return stopping;
      }
    };
  } catch (error) {
    await closeListeners({ force: true });
    throw error;
  }
}

async function main(args) {
  if (args.length !== 2 || args[0] !== "--output") throw Error("Usage: managed-agent-form-server.mjs --output NEW_ABSOLUTE_DIRECTORY");
  const server = await startManagedAgentFormServer({ output: args[1] });
  process.stdout.write(JSON.stringify(server.ready) + "\n");
  const lines = createInterface({ input: process.stdin }); let stopping = false;
  const stop = async reason => {
    if (stopping) return; stopping = true; lines.close();
    try { process.stdout.write(JSON.stringify(await server.close(reason)) + "\n"); }
    catch (error) { process.stderr.write(String(error?.stack ?? error) + "\n"); process.exitCode = 1; }
    process.stdin.destroy();
  };
  lines.on("line", line => { if (line.trim() === "stop") void stop("stdin-stop"); });
  lines.on("close", () => { if (!stopping) void stop("stdin-eof"); });
  process.once("SIGINT", () => void stop("SIGINT")); process.once("SIGTERM", () => void stop("SIGTERM"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(error => { process.stderr.write(String(error?.stack ?? error) + "\n"); process.exitCode = 1; });
