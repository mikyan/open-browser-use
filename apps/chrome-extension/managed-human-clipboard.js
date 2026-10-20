// Shared browser clipboard data is not page-origin data. This module validates
// the small human transfer envelope; it never grants a lease or reads content.
export const HUMAN_CLIPBOARD_MAX_BYTES = 65536;
export const HUMAN_CLIPBOARD_PROBE_TYPE = "application/x-obu-version-probe";
const failure = code => new Error(`OBU_CLIPBOARD_${code}: human clipboard transfer unavailable`);
const own = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const operations = new Set(["copy", "cut"]);
const codes = new Set(["UNSUPPORTED", "DENIED", "BUSY", "CANCELLED", "TIMEOUT", "CHANGED", "LIMIT", "READ_FAILED"]);

export function validateHumanClipboardInput(input) {
  if (!input || !Object.hasOwn(input, "clipboardTransfer")) return null;
  const operation = input.clipboardTransfer;
  const code = operation === "copy" ? "KeyC" : "KeyX";
  const vk = operation === "copy" ? 67 : 88;
  if (!operations.has(operation) || input.type !== "key" || input.action !== "down" ||
      input.code !== code || input.windowsVirtualKeyCode !== vk ||
      typeof input.key !== "string" || ![code.slice(3), code.slice(3).toLowerCase()].includes(input.key) ||
      (input.modifiers !== 2 && input.modifiers !== 4) || Object.hasOwn(input, "repeat")) throw failure("INVALID");
  return operation;
}

export function validateHumanClipboardText(text) {
  if (typeof text !== "string" || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) throw failure("INVALID");
  if (new TextEncoder().encode(text).byteLength > HUMAN_CLIPBOARD_MAX_BYTES) throw failure("LIMIT");
  return text;
}

export function validateHumanClipboardResult(result, operation) {
  if (!operations.has(operation) || !own(result, ["operation", "status", "text", "code"]) || result.operation !== operation) throw failure("INVALID");
  if (result.status === "ready" && Object.keys(result).length === 3 && Object.hasOwn(result, "text")) {
    return { operation, status: "ready", text: validateHumanClipboardText(result.text) };
  }
  if (result.status === "unchanged" && Object.keys(result).length === 2) return { operation, status: "unchanged" };
  if (result.status === "failed" && Object.keys(result).length === 3 && codes.has(result.code)) return { operation, status: "failed", code: result.code };
  throw failure("INVALID");
}

export function clipboardFailure(error, operation) {
  if (!operations.has(operation)) throw failure("INVALID");
  const match = /^OBU_CLIPBOARD_([A-Z_]+):/.exec(error?.message ?? "");
  let code = codes.has(match?.[1]) ? match[1] : "READ_FAILED";
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") code = "DENIED";
  if (error?.name === "InvalidStateError") code = "CHANGED";
  return { operation, status: "failed", code };
}

// The version fence is an implementation contract, not a portable Clipboard
// API. Check the actual native Browser.getVersion reply, never navigator UA.
export function assertHumanClipboardRuntime(version) {
  const revisions = {
    "156.0.8078.4": "@f842f52ef39fd97b449eb27cff414bf05a98ddce",
    "156.0.8078.12": "@634b046faf2137b83af71c87baf362b533af9104"
  };
  const product = /^(?:Chrome|HeadlessChrome)\/(156\.0\.8078\.(?:4|12))$/.exec(version?.product ?? "");
  if (!product || version.revision !== revisions[product[1]]) throw failure("UNSUPPORTED");
}
