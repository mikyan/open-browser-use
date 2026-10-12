import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openOriginalDownloadFile, readOriginalDownloadProof } from "./original-download-proof.mjs";

const expectedContent = bytes => ({ base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") });

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "obu-original-file-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "downloads");
  await fs.mkdir(root);
  const file = path.join(root, "..report.bin");
  await fs.writeFile(file, "original-nonce\n");
  return { directory, root, file };
}

test("original file reads from an independently supplied root with exact handle identity", async t => {
  const { root, file } = await fixture(t);
  const opened = await openOriginalDownloadFile(root, file);
  try {
    assert.equal(await opened.handle.readFile("utf8"), "original-nonce\n");
    const stat = await fs.lstat(file, { bigint: true });
    assert.deepEqual(opened.identity, { dev: String(stat.dev), ino: String(stat.ino), size: 15, mtimeNs: String(stat.mtimeNs), realPath: await fs.realpath(file) });
  } finally { await opened.handle.close(); }
});

test("original proof publishes content only after exact fixture bytes and digest match", async t => {
  const { root, file } = await fixture(t);
  const analysis = { key: "exact-fixture", nonce: "test-nonce", owner: "original-owner" };
  const bytes = Buffer.concat([Buffer.from(JSON.stringify(analysis) + "\n原始报表\n"), Buffer.from([0, 255, 195, 40])]);
  await fs.writeFile(file, bytes);
  const expected = expectedContent(bytes), proof = await readOriginalDownloadProof(root, file, expected);
  assert.deepEqual(proof.analysis, analysis); assert.equal(proof.base64, expected.base64);
  assert.equal(proof.sha256, expected.sha256); assert.equal(proof.bytes, bytes.length);
  assert.equal(proof.path, file); assert.equal(proof.identity.realPath, await fs.realpath(file));
  assert.ok((await fs.readFile(file)).equals(bytes));
});

test("wrong in-root JSON content stays out of proof and serialized errors and remains unchanged", async t => {
  const { root, file } = await fixture(t);
  const marker = "PRIVATE_UNRELATED_CONTENT_9f4bc7", privateBytes = Buffer.from(JSON.stringify({ credential: marker }) + "\nprivate payload");
  await fs.writeFile(file, privateBytes);
  const before = await fs.stat(file, { bigint: true });
  const expected = expectedContent(Buffer.from('{"key":"expected-fixture"}\nexpected payload'));
  const item = {}; let failure;
  try { item.file = await readOriginalDownloadProof(root, file, expected); }
  catch (error) { failure = error; }
  assert.ok(failure); assert.equal(item.file, undefined);
  assert.equal(failure.message, "Original download bytes do not match this fixture");
  const output = JSON.stringify({ item, error: failure, message: failure.message, stack: failure.stack, actual: failure.actual, expected: failure.expected });
  for (const secret of [marker, privateBytes.toString("base64"), privateBytes.toString("utf8"), "credential", "private payload"]) assert.equal(output.includes(secret), false);
  assert.equal(typeof failure.actual, "boolean", "Assertion metadata must contain no actual Buffer or content");
  assert.ok((await fs.readFile(file)).equals(privateBytes));
  const after = await fs.stat(file, { bigint: true });
  for (const field of ["ino", "dev", "size", "mtimeNs"]) assert.equal(after[field], before[field]);
});

test("matching bytes with an incorrect expected digest never publish content", async t => {
  const { root, file } = await fixture(t);
  const bytes = Buffer.from('{"key":"verified-only-after-digest"}\npayload'); await fs.writeFile(file, bytes);
  let failure;
  try { await readOriginalDownloadProof(root, file, { ...expectedContent(bytes), sha256: "0".repeat(64) }); }
  catch (error) { failure = error; }
  assert.equal(failure?.message, "Original download digest does not match this fixture");
  assert.doesNotMatch(JSON.stringify({ error: failure, stack: failure.stack }), /verified-only-after-digest|payload/);
  assert.ok((await fs.readFile(file)).equals(bytes));
});

test("original proof supports the largest fixture and rejects the next byte", async t => {
  const { root, file } = await fixture(t);
  const head = Buffer.from('{"key":"maximum-fixture"}\n');
  const bytes = Buffer.concat([head, Buffer.alloc(65535 - head.length, 123)]); await fs.writeFile(file, bytes);
  assert.equal((await readOriginalDownloadProof(root, file, expectedContent(bytes))).bytes, 65535);
  await fs.appendFile(file, Buffer.from([42]));
  await assert.rejects(readOriginalDownloadProof(root, file, expectedContent(bytes)), /size bound/);
  assert.equal((await fs.stat(file)).size, 65536);
});

test("original file rejects relative paths, the root itself and files outside the root", async t => {
  const { root, file, directory } = await fixture(t);
  const outside = path.join(directory, "outside.bin"); await fs.writeFile(outside, "foreign");
  await assert.rejects(openOriginalDownloadFile("relative", file), /must be absolute/);
  await assert.rejects(openOriginalDownloadFile(root, "relative.bin"), /must be absolute/);
  await assert.rejects(openOriginalDownloadFile(root, root), /independently identified/);
  await assert.rejects(openOriginalDownloadFile(root, outside), /independently identified/);
  assert.equal(await fs.readFile(outside, "utf8"), "foreign");
});

test("original file rejects directories and oversized fixture files", async t => {
  const { root, file } = await fixture(t);
  const nested = path.join(root, "directory"); await fs.mkdir(nested);
  await assert.rejects(openOriginalDownloadFile(root, nested), /regular file/);
  await fs.writeFile(file, Buffer.alloc(65536));
  await assert.rejects(openOriginalDownloadFile(root, file), /size bound/);
});

test("original file rejects an ancestor junction escaping the download directory", async t => {
  const { directory, root } = await fixture(t);
  const outside = path.join(directory, "outside"); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "foreign.bin"), "foreign");
  const link = path.join(root, "nested"); await fs.symlink(outside, link, "junction");
  await assert.rejects(openOriginalDownloadFile(root, path.join(link, "foreign.bin")), /independently identified/);
  assert.equal(await fs.readFile(path.join(outside, "foreign.bin"), "utf8"), "foreign");
});

test("original file rejects a symbolic-link leaf before opening it", async t => {
  const { root, file } = await fixture(t);
  const link = path.join(root, "alias.bin");
  try { await fs.symlink(file, link, "file"); }
  catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") { t.skip("Windows file-symlink privilege unavailable"); return; }
    throw error;
  }
  await assert.rejects(openOriginalDownloadFile(root, link), /regular file/);
});
