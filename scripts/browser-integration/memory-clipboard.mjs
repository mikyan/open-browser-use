import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";

// This is a deliberately pinned test environment, not a general claim that
// browser profiles isolate the operating system clipboard. The exact upstream
// revision installs HeadlessClipboard (ClipboardNonBacked) in PreBrowserStart
// on Windows before browser content can use a clipboard. No test reads or
// restores the user's platform clipboard to establish this guard.
const version = "156.0.8078.4";
const revision = "f842f52ef39fd97b449eb27cff414bf05a98ddce";
const executableSha256 = "7f08161bbeb2853ffe1780a9ded4985087f52efb9725d7d8207aabdd42f7cfb9";
const sourcePaths = [
  "chrome/browser/chrome_browser_main.cc",
  "chrome/browser/headless/chrome_browser_main_extra_parts_headless.cc",
  "components/headless/clipboard/headless_clipboard.cc",
  "ui/base/clipboard/clipboard_non_backed.h"
];

export async function verifyMemoryClipboard(connection, executable) {
  assert.equal(process.env.OBU_TEST_MEMORY_CLIPBOARD, "1");
  assert.equal(process.platform, "win32", "Re-audit the exact platform source before adding another test binary");
  assert.equal(createHash("sha256").update(await fs.readFile(executable)).digest("hex"), executableSha256, "Unreviewed clipboard test executable");
  const native = await connection.call("Browser.getVersion");
  assert.equal(native.product, `Chrome/${version}`);
  assert.equal(native.revision, `@${revision}`);
  const { arguments: argv } = await connection.call("Browser.getBrowserCommandLine");
  assert.ok(argv.includes("--headless=new"), "Clipboard tests require Chromium's platform-independent headless clipboard");
  assert.ok(argv.includes("--enable-automation"));
  assert.ok(!argv.some(arg => arg.startsWith("--silent-debugger-extension-api") || arg.startsWith("--disable-web-security")));
  return {
    verified: true, mode: "chromium-headless-memory", version, revision, executableSha256,
    sandbox: argv.includes("--no-sandbox") ? "disabled in isolated synthetic test process" : "enabled",
    sourceURLs: sourcePaths.map(file => `https://chromium.googlesource.com/chromium/src/+/${revision}/${file}`),
    commandLine: argv,
    limitation: "Browser API acceptance against an in-memory clipboard; not headed OS clipboard or desktop focus acceptance"
  };
}
