// Shared U/X task pages only. Browser tools solve the tasks; this process never
// drives input or exposes its private evidence ledger through HTTP.
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createDirectLocatorUploadFixtures, prepareDirectLocatorUploadFiles, directUploadRoute } from "./direct-locator-upload-fixture.mjs";
import { diagnosticsFixture } from "./diagnostics-fixture.mjs";
import { listenFixture } from "./fixture-listener.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const parityTransferDiagnosticsInstructions = Object.freeze({
  U: "在任务页的文件输入中一次选择提供的全部文件，等待本次上传收据，然后清空同一个文件输入并确认没有选中文件。只上传一次；清空不应再提交。使用正式浏览器文件接口，不用页面脚本合成输入事件或代发提交。报告收据和清空结果；如工具不支持清空，保留原结果并明确说明。",
  X: "使用正式浏览器诊断或网络观察能力；如需开启观察，请在触发前完成。在主页面和内嵌页面中各点击一次“Emit diagnostics”，不要点击“Emit fresh diagnostics”。从实际浏览器诊断报告两处的 console、异常，以及成功请求、重定向链和失败请求，注明页面来源、原始文本、URL、状态或失败原因。不要通过页面脚本制造诊断、读取测试源码或私有账本代替原诊断；能力不支持时如实记录。"
});

export async function startParityTransferDiagnosticsServer({ output } = {}) {
  if (typeof output !== "string" || !output.trim()) throw Error("A fresh output directory is required");
  const destination = path.resolve(output);
  await fs.mkdir(destination); // Existing paths deliberately fail; never overwrite an earlier attempt.
  const files = await prepareDirectLocatorUploadFiles(destination), upload = createDirectLocatorUploadFixtures();
  // The existing fixture's key grammar uses a client prefix; it is not a claim
  // about which side of the comparison will operate this fresh task instance.
  const key = `direct-js-parity-${randomUUID()}`, servers = [], sockets = new Set(), requests = [];
  let port, stopping, overflow = false, dropped = 0;
  const handle = (request, response) => {
    let url;
    try {
      url = new URL(request.url, `http://${request.headers.host}`);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || Number(url.port) !== port) throw Error("Invalid fixture host");
    } catch { response.writeHead(400); response.end("Invalid fixture URL"); return; }
    if (requests.length >= 4096 || url.href.length > 8192) { overflow = true; dropped++; response.writeHead(503); response.end("Evidence limit reached"); return; }
    const hit = { sequence: requests.length + 1, method: request.method, url: url.href, at: Date.now() };
    requests.push(hit);
    request.once("aborted", () => { hit.aborted = true; });
    request.once("error", error => { hit.requestError = String(error).slice(0, 1024); });
    response.once("error", error => { hit.responseError = String(error).slice(0, 1024); });
    response.once("finish", () => { hit.status = response.statusCode; hit.finishedAt = Date.now(); });
    response.once("close", () => { hit.closedAt = Date.now(); hit.closedBeforeFinish = !response.writableFinished; });
    response.setHeader("Cache-Control", "no-store");
    if (url.pathname.startsWith(directUploadRoute)) {
      if (url.searchParams.get("key") !== key || url.searchParams.get("variant") !== "root" || url.searchParams.has("directory")) {
        response.writeHead(400); response.end("Not this upload task"); return;
      }
      if (upload.handle(request, response, url)) return;
    }
    if (request.method === "GET") {
      // These are the original diagnostics fixture's run.mjs routes, including
      // an actual socket failure rather than a fabricated HTTP error response.
      if (url.pathname === "/diagnostics/fail") { hit.socketDestroyed = true; request.socket.destroy(); return; }
      if (url.pathname === "/diagnostics/redirect") { response.writeHead(302, { Location: "/diagnostics/data" + url.search }); response.end(); return; }
      if (url.pathname === "/diagnostics/data") { response.setHeader("Content-Type", "application/json"); response.end('{"ok":true}'); return; }
      if (["/diagnostics", "/diagnostics/frame"].includes(url.pathname)) {
        const body = Buffer.from(diagnosticsFixture(url.pathname.endsWith("/frame"), port)); hit.responseSHA256 = hash(body);
        response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(body); return;
      }
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); response.end("Task route not found");
  };
  const closeListeners = async () => {
    await Promise.all(servers.map(server => new Promise((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    })));
    await new Promise(resolve => setImmediate(resolve));
  };
  try {
    for (const host of ["127.0.0.1", "::1"]) {
      const server = createServer(handle); servers.push(server);
      server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
      if (port === undefined) port = await listenFixture(server);
      else await new Promise((resolve, reject) => {
        const failed = error => { server.off("listening", ready); reject(error); };
        const ready = () => { server.off("error", failed); resolve(); };
        server.once("error", failed); server.once("listening", ready); server.listen({ host, port, ipv6Only: true });
      });
    }
    const baseURL = `http://127.0.0.1:${port}`, sources = {};
    for (const name of ["parity-transfer-diagnostics-server.mjs", "direct-locator-upload-fixture.mjs", "diagnostics-fixture.mjs", "fixture-listener.mjs"])
      sources[name] = hash(await fs.readFile(path.join(directory, name)));
    const ready = { phase: "ready", pid: process.pid, node: process.version, startedAt: new Date().toISOString(), output: destination, sources,
      tasks: {
        U: { url: `${baseURL}${directUploadRoute}page?key=${key}&variant=root`, instructions: parityTransferDiagnosticsInstructions.U, files: files.map(file => file.path) },
        X: { url: `${baseURL}/diagnostics`, instructions: parityTransferDiagnosticsInstructions.X }
      },
      boundary: "Task pages and inputs only; private ledger is written after stop. closed.json proves server closure, not the outer process close event." };
    await fs.writeFile(path.join(destination, "ready.json"), JSON.stringify(ready, null, 2) + "\n", { flag: "wx" });
    return { ready,
      close(reason = "explicit") {
        if (!stopping) stopping = (async () => {
          await closeListeners();
          const evidence = { uploads: upload.allStats(), requests, overflow, dropped, inputFiles: files };
          const bytes = Buffer.from(JSON.stringify(evidence, null, 2) + "\n");
          await fs.writeFile(path.join(destination, "server-evidence.json"), bytes, { flag: "wx" });
          const closed = { phase: "stopped", reason, at: new Date().toISOString(), pid: process.pid, output: destination,
            serverClosed: servers.every(server => !server.listening), openConnections: sockets.size, overflow, dropped,
            evidenceSHA256: hash(bytes), requestCount: requests.length, uploadCount: evidence.uploads.reduce((count, item) => count + item.posts.length, 0) };
          await fs.writeFile(path.join(destination, "closed.json"), JSON.stringify(closed, null, 2) + "\n", { flag: "wx" });
          if (!closed.serverClosed || closed.openConnections || overflow) throw Error("Fixture did not close with complete evidence");
          return closed;
        })();
        return stopping;
      }
    };
  } catch (error) { await closeListeners(); throw error; }
}

async function main(args) {
  if (args.length !== 2 || args[0] !== "--output") throw Error("Usage: parity-transfer-diagnostics-server.mjs --output NEW_DIRECTORY");
  const server = await startParityTransferDiagnosticsServer({ output: args[1] });
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
