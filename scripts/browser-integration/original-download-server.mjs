import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createOriginalDownloadFixtures } from "./original-download-fixture.mjs";

const admin = "/__original-download/";
const json = (response, status, value) => {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
};

// A standalone loopback-only evidence server. Management routes are harness
// controls; product download ownership must not use them or their private data.
export async function startOriginalDownloadFixtureServer({ port = 0, output } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error("Invalid fixture port");
  const directory = output ? path.resolve(output) : null;
  if (directory) {
    await fs.mkdir(directory); // Deliberately fails for an existing directory.
    await fs.writeFile(path.join(directory, "cases.jsonl"), "", { flag: "wx" });
  }
  const fixture = createOriginalDownloadFixtures(), servers = [];
  let baseURL, closing, caseWrites = Promise.resolve();
  const createCase = async options => {
    const item = fixture.createCase(options);
    if (directory) {
      caseWrites = caseWrites.then(() => fs.appendFile(path.join(directory, "cases.jsonl"), JSON.stringify(item) + "\n"));
      await caseWrites;
    }
    return item;
  };
  const handle = (request, response) => {
    const url = new URL(request.url, baseURL);
    if (!url.pathname.startsWith(admin)) {
      if (!fixture.handle(request, response, baseURL)) json(response, 404, { error: "UNKNOWN_ROUTE" });
      return;
    }
    if (request.method === "GET" && url.pathname === admin + "stats") {
      try { json(response, 200, url.searchParams.has("key") ? fixture.stats(url.searchParams.get("key")) : fixture.allStats()); }
      catch (error) { json(response, 404, { error: String(error) }); }
      return;
    }
    if (request.method !== "POST" || url.pathname !== admin + "cases") { json(response, 405, { error: "INVALID_MANAGEMENT_REQUEST" }); return; }
    const chunks = []; let size = 0;
    request.on("data", chunk => { size += chunk.length; if (size <= 65536) chunks.push(chunk); });
    request.on("error", () => {});
    request.on("end", async () => {
      if (size > 65536) { json(response, 413, { error: "CASE_REQUEST_TOO_LARGE" }); return; }
      try {
        if (closing) throw Error("Fixture server closing");
        const item = await createCase(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        json(response, 201, item);
      } catch (error) { json(response, 400, { error: String(error) }); }
    });
  };
  const closeServers = async () => {
    await Promise.all(servers.map(server => new Promise((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    })));
  };
  try {
    for (const host of ["127.0.0.1", "::1"]) {
      const server = createServer(handle); servers.push(server);
      await new Promise((resolve, reject) => {
        const failed = error => { server.off("listening", ready); reject(error); };
        const ready = () => { server.off("error", failed); resolve(); };
        server.once("error", failed); server.once("listening", ready);
        server.listen({ host, port, ipv6Only: host === "::1" });
      });
      port = server.address().port; baseURL = `http://127.0.0.1:${port}/`;
    }
    const cases = [];
    for (const owner of ["iab-post", "iab-blob", "edge-post", "edge-blob"]) cases.push(await createCase({ owner, kind: owner.endsWith("post") ? "post" : "blob" }));
    const ready = { phase: "ready", baseURL, output: directory, cases };
    if (directory) await fs.writeFile(path.join(directory, "ready.json"), JSON.stringify(ready, null, 2) + "\n", { flag: "wx" });
    return { baseURL, fixture, createCase, ready,
      close() {
        if (!closing) closing = (async () => {
          await closeServers(); await caseWrites;
          const stats = fixture.allStats();
          if (directory) await fs.writeFile(path.join(directory, "stats.json"), JSON.stringify(stats, null, 2) + "\n", { flag: "wx" });
          return stats;
        })();
        return closing;
      }
    };
  } catch (error) { await closeServers(); throw error; }
}

async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!["--port", "--output"].includes(name) || value === undefined) throw Error("Usage: original-download-server.mjs [--port N] [--output NEW_DIRECTORY]");
    options[name.slice(2)] = name === "--port" ? Number(value) : value;
  }
  const server = await startOriginalDownloadFixtureServer(options);
  process.stdout.write(JSON.stringify(server.ready) + "\n");
  const lines = createInterface({ input: process.stdin }); let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true; lines.close();
    try {
      const stats = await server.close();
      process.stdout.write(JSON.stringify({ phase: "stopped", cases: stats.cases.length, requests: stats.requests.length, output: server.ready.output }) + "\n");
    } catch (error) { process.stderr.write(String(error?.stack ?? error) + "\n"); process.exitCode = 1; }
    process.stdin.destroy();
  };
  lines.on("line", line => { if (line.trim() === "stop") void stop(); });
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(String(error?.stack ?? error) + "\n"); process.exitCode = 1; });
}
