import assert from "node:assert/strict";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const expectedGuard = Object.freeze({ verified: true, mode: "chromium-headless-memory", version: "156.0.8078.4",
  revision: "f842f52ef39fd97b449eb27cff414bf05a98ddce", executableSha256: "7f08161bbeb2853ffe1780a9ded4985087f52efb9725d7d8207aabdd42f7cfb9" });
export function assertMemoryClipboardGuard(guard) {
  assert.equal(process.env.OBU_TEST_MEMORY_CLIPBOARD, "1", "Clipboard checks require explicit memory-clipboard mode");
  for (const [key, value] of Object.entries(expectedGuard)) assert.equal(guard?.[key], value, `Unverified memory clipboard: ${key}`);
}
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const checks = ["text-unicode", "three-representations", "empty-items-no-op", "invalid-and-oversize-no-mutation"];
async function proof(options, kind, sources) {
  assertMemoryClipboardGuard(options.memoryClipboardGuard);
  const identities = {};
  for (const [name, filename] of Object.entries(sources)) identities[name] = sha256(await fs.readFile(filename));
  const data = { guard: options.memoryClipboardGuard, sources: identities };
  await fs.writeFile(path.join(options.runDir, `clipboard-${kind}-proof.json`), JSON.stringify(data, null, 2), { flag: "wx" });
  return data;
}
function outputResult(stdout, artifact) {
  const result = JSON.parse(stdout);
  assert.deepEqual(result.checks, checks);
  assert.equal(result.artifact, path.basename(artifact));
  assert.match(result.pngSHA256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isInteger(result.pngBytes) && result.pngBytes > 0);
  return result;
}
export async function checkPythonClipboard(options) {
  assertMemoryClipboardGuard(options.memoryClipboardGuard);
  const script = path.join(options.runDir, "clipboard-checks.py");
  await fs.copyFile(path.join(directory, "clipboard-checks.py"), script, constants.COPYFILE_EXCL);
  await proof(options, "python", { script, png: options.pngPath });
  const artifact = path.join(options.runDir, "clipboard-python-items.json");
  const stdout = await options.subprocess(options.pythonExecutable ?? "python", [script, options.endpoint, options.fixtureURL, artifact, options.pngPath], {
    env: { ...process.env, PYTHONPATH: options.pythonSDKSnapshot, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" }, timeoutMs: 90000,
  });
  return outputResult(stdout, artifact);
}
export async function checkGoClipboard(options) {
  assertMemoryClipboardGuard(options.memoryClipboardGuard);
  assert.ok(options.goClipboardExe, "Set the dedicated Go clipboard checker executable");
  const executable = path.join(options.runDir, process.platform === "win32" ? "go-clipboard-client.exe" : "go-clipboard-client");
  await fs.copyFile(options.goClipboardExe, executable, constants.COPYFILE_EXCL);
  const source = path.join(options.runDir, "go-clipboard-checks.go");
  await fs.copyFile(path.join(directory, "go-clipboard-checks/main.go"), source, constants.COPYFILE_EXCL);
  await proof(options, "go", { executable, source, png: options.pngPath });
  const artifact = path.join(options.runDir, "clipboard-go-items.json");
  const stdout = await options.subprocess(executable, [options.endpoint, options.fixtureURL, artifact, options.pngPath], { timeoutMs: 90000 });
  return outputResult(stdout, artifact);
}
async function inputs(options, kind) {
  assertMemoryClipboardGuard(options.memoryClipboardGuard);
  const png = await fs.readFile(options.pngPath), text = `${kind.toUpperCase()} clipboard 中文🙂`;
  const items = [{ entries: [{ mime_type: "text/plain", text }, { mime_type: "text/html", text: `<b>${text}</b>` }, { mime_type: "image/png", base64: png.toString("base64") }] }];
  const paths = {};
  for (const [name, value] of Object.entries({ input: { items }, noop: { items: [] }, invalid: { items: [{ entries: [{ mime_type: "image/jpeg", base64: png.toString("base64") }] }] }, unknown: { items: [{ entries: [{ mime_type: "text/plain", text, extra: true }] }] } })) {
    paths[name] = path.join(options.runDir, `clipboard-${kind}-${name}.json`);
    await fs.writeFile(paths[name], JSON.stringify(value), { flag: "wx" });
  }
  await proof(options, kind, { helper: fileURLToPath(import.meta.url), executable: options.executable, png: options.pngPath, ...paths });
  return { text, items, paths };
}
async function readArtifact(filename, metadata, text) {
  assert.deepEqual(Object.keys(metadata).sort(), ["byteLength", "encoding", "mimeType", "path"]);
  assert.equal(metadata.path, filename); assert.equal(metadata.mimeType, "application/json"); assert.equal(metadata.encoding, "utf-8");
  const bytes = await fs.readFile(filename); assert.equal(metadata.byteLength, bytes.length);
  const value = JSON.parse(bytes);
  assert.deepEqual(Object.keys(value), ["items"]); assert.equal(value.items.length, 1);
  const entries = new Map(value.items[0].entries.map(entry => [entry.mime_type, entry]));
  assert.deepEqual([...entries.keys()].sort(), ["image/png", "text/html", "text/plain"]);
  assert.equal(entries.get("text/plain").text, text); assert.ok(entries.get("text/html").text.includes(text));
  const base64 = entries.get("image/png").base64, png = Buffer.from(base64, "base64"); assert.equal(png.toString("base64"), base64);
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { value, detail: { pngBytes: png.length, pngSHA256: sha256(png) } };
}
export async function checkCLIClipboard(options) {
  const { text, paths } = await inputs(options, "cli"), session = "cli-clipboard-integration";
  const common = ["--socket", options.endpoint, "--session-id", session, "--timeout", "15s"];
  const call = async (method, params = {}) => {
    const response = JSON.parse(await options.subprocess(options.executable, ["call", "--method", method, "--params", JSON.stringify(params), ...common]));
    assert.equal(response.error, undefined, JSON.stringify(response)); return response.result;
  };
  assert.equal((await call("getInfo")).metadata.clipboardVersion, 1);
  const tab = await call("createTab");
  try {
    await call("browserAction", { tabId: tab.id, action: "goto", args: { url: options.fixtureURL }, timeoutMs: 10000 });
    const argv = mode => ["clipboard", mode, "--tab-id", String(tab.id), ...common];
    const run = async (mode, extra = []) => JSON.parse(await options.subprocess(options.executable, [...argv(mode), ...extra]));
    assert.deepEqual(await run("write-text", ["--text", text]), {});
    assert.deepEqual(await run("read-text"), { text });
    assert.deepEqual(await run("write", ["--input", paths.input]), {});
    const artifact = path.join(options.runDir, "clipboard-cli-items.json");
    const metadata = await run("read", ["--output", artifact]);
    const first = await readArtifact(artifact, metadata, text), initial = await fs.readFile(artifact);
    await assert.rejects(run("read", ["--output", artifact]), /already exists/i);
    assert.deepEqual(await fs.readFile(artifact), initial);
    assert.deepEqual(await run("write", ["--input", paths.noop]), {});
    for (const input of [paths.invalid, paths.unknown]) await assert.rejects(run("write", ["--input", input]), /clipboard|MIME/i);
    await assert.rejects(run("write-text", ["--text", "中文", "--max-bytes", "1"]), /byte limit/i);
    const after = path.join(options.runDir, "clipboard-cli-after.json");
    const afterMetadata = await run("read", ["--output", after]);
    const next = await readArtifact(after, afterMetadata, text);
    assert.deepEqual(next.value, first.value);
    return { checks, artifact: path.basename(artifact), tabId: tab.id, ...first.detail, noOverwrite: true, firstMetadata:metadata, afterMetadata };
  } finally { await call("finalizeTabs", { keep: [] }); }
}
export async function checkMCPClipboard(options) {
  const { text, paths } = await inputs(options, "mcp");
  return options.withMCPClient(options.executable, options.endpoint, "mcp-clipboard-integration", async (call, tool) => {
    assert.equal((await call("getInfo")).metadata.clipboardVersion, 1);
    const tab = await call("createTab");
    try {
      await call("browserAction", { tabId: tab.id, action: "goto", args: { url: options.fixtureURL }, timeoutMs: 10000 });
      const run = async (name, values = {}) => { const result = await tool(name, { tab_id: tab.id, timeout_ms: 10000, ...values }); assert.equal(result.isError, false, JSON.stringify(result)); return result; };
      await run("write_clipboard_text", { text });
      const readText = await run("read_clipboard_text");
      assert.deepEqual(readText, { isError: false, content: [{ type: "text", text }] });
      await run("write_clipboard", { input_path: paths.input });
      const artifact = path.join(options.runDir, "clipboard-mcp-items.json");
      const response = await run("read_clipboard", { output_path: artifact });
      assert.ok(!JSON.stringify(response).includes("base64"), "MCP duplicated binary data in its tool response");
      const first = await readArtifact(artifact, response.structuredContent, text), initial = await fs.readFile(artifact);
      const existing = await tool("read_clipboard", { tab_id: tab.id, output_path: artifact }); assert.equal(existing.isError, true);
      assert.match(JSON.stringify(existing), /already exists/i); assert.deepEqual(await fs.readFile(artifact), initial);
      await run("write_clipboard", { input_path: paths.noop });
      for (const input of [paths.invalid, paths.unknown]) { const error = await tool("write_clipboard", { tab_id: tab.id, input_path: input }); assert.equal(error.isError, true); assert.match(JSON.stringify(error), /clipboard|MIME/i); }
      const oversize = await tool("write_clipboard_text", { tab_id: tab.id, text: "中文", max_bytes: 1 }); assert.equal(oversize.isError, true); assert.match(JSON.stringify(oversize), /byte limit/i);
      const after = path.join(options.runDir, "clipboard-mcp-after.json");
      const afterResponse = await run("read_clipboard", { output_path: after });
      const next = await readArtifact(after, afterResponse.structuredContent, text); assert.deepEqual(next.value, first.value);
      return { checks, artifact: path.basename(artifact), tabId: tab.id, ...first.detail, noOverwrite: true, textCopies: 1,
        firstMetadata:response.structuredContent, afterMetadata:afterResponse.structuredContent, readResponse:response, afterResponse };
    } finally { await call("finalizeTabs", { keep: [] }); }
  });
}
