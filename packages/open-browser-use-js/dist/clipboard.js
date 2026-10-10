export const MAX_CLIPBOARD_BYTES = 16 * 1024 * 1024;
const MAX_CLIPBOARD_JSON_BYTES = 48 * 1024 * 1024;
function boundedClipboardWire(value) {
    const json = JSON.stringify(value);
    let size = Buffer.byteLength(json, "utf8");
    if (size > MAX_CLIPBOARD_JSON_BYTES)
        throw new Error("OBU_CLIPBOARD_LIMIT: encoded clipboard body exceeds 48 MiB");
    // The Go host re-encodes JSON with HTML and line-separator escaping.
    // Bound that representation before any connection or clipboard request.
    for (let index = 0; index < json.length; index++) {
        const unit = json.charCodeAt(index);
        if (unit === 0x3c || unit === 0x3e || unit === 0x26)
            size += 5;
        else if (unit === 0x2028 || unit === 0x2029)
            size += 3;
        if (size > MAX_CLIPBOARD_JSON_BYTES)
            throw new Error("OBU_CLIPBOARD_LIMIT: encoded clipboard body exceeds 48 MiB");
    }
    return value;
}
export const clipboardMethods = new Set(["readClipboardText", "writeClipboardText", "readClipboard", "writeClipboard"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function keys(value, allowed) {
    if (Object.keys(value).some(key => !allowed.includes(key)))
        throw new Error("Invalid clipboard fields");
}
function textBytes(value) {
    if (typeof value !== "string" || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))
        throw new Error("Invalid clipboard UTF-8 text");
    return Buffer.byteLength(value, "utf8");
}
function pngBytes(value, maximum) {
    if (typeof value !== "string" || value.length > 4 * Math.ceil(maximum / 3))
        throw new Error("Invalid clipboard PNG base64");
    const bytes = Buffer.from(value, "base64");
    if (bytes.length < 33 || bytes.length > maximum || bytes.toString("base64") !== value ||
        !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR")
        throw new Error("Invalid clipboard PNG");
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
    if (!width || !height || width > 16777216 / height || !depths[bytes[25]]?.includes(bytes[24]) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1)
        throw new Error("Invalid clipboard PNG IHDR or pixel limit");
    // Structural preflight only. The trusted browser adapter must fully decode.
    return bytes.length;
}
export function validateClipboardItems(value, maximum) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > MAX_CLIPBOARD_BYTES)
        throw new Error("Invalid clipboard maxBytes");
    if (!Array.isArray(value) || value.length > 1)
        throw new Error("Clipboard items must contain at most one item");
    let total = 0;
    return value.map(item => {
        if (!object(item))
            throw new Error("Invalid clipboard item");
        keys(item, ["entries", "presentation_style"]);
        if (Object.hasOwn(item, "presentation_style") && !["unspecified", "inline", "attachment"].includes(item.presentation_style))
            throw new Error("Invalid clipboard presentation_style");
        if (!Array.isArray(item.entries) || item.entries.length < 1 || item.entries.length > 3)
            throw new Error("Invalid clipboard entries");
        const seen = new Set();
        const entries = item.entries.map(entry => {
            if (!object(entry) || typeof entry.mime_type !== "string" || seen.has(entry.mime_type))
                throw new Error("Invalid or duplicate clipboard MIME type");
            seen.add(entry.mime_type);
            let copied;
            if (entry.mime_type === "text/plain" || entry.mime_type === "text/html") {
                keys(entry, ["mime_type", "text"]);
                total += textBytes(entry.text);
                copied = { mime_type: entry.mime_type, text: entry.text };
            }
            else if (entry.mime_type === "image/png") {
                keys(entry, ["mime_type", "base64"]);
                total += pngBytes(entry.base64, maximum);
                copied = { mime_type: "image/png", base64: entry.base64 };
            }
            else
                throw new Error("Unsupported clipboard MIME type");
            if (total > maximum)
                throw new Error("Clipboard byte limit exceeded");
            return copied;
        });
        return { entries, ...(Object.hasOwn(item, "presentation_style") ? { presentation_style: item.presentation_style } : {}) };
    });
}
export function clipboardParams(method, tabId, payload = {}, options = {}) {
    if (!clipboardMethods.has(method) || !Number.isSafeInteger(tabId) || tabId < 0 || !object(options))
        throw new Error("Invalid clipboard request");
    keys(options, ["maxBytes", "timeoutMs"]);
    const maxBytes = options.maxBytes === undefined ? MAX_CLIPBOARD_BYTES : options.maxBytes;
    const timeoutMs = options.timeoutMs === undefined ? 10000 : options.timeoutMs;
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CLIPBOARD_BYTES)
        throw new Error("Invalid clipboard maxBytes");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
        throw new Error("Invalid clipboard timeoutMs");
    const result = { tabId, maxBytes, timeoutMs };
    keys(payload, method === "writeClipboardText" ? ["text"] : method === "writeClipboard" ? ["items"] : []);
    if (method === "writeClipboardText") {
        if (textBytes(payload.text) > maxBytes)
            throw new Error("Clipboard byte limit exceeded");
        result.text = payload.text;
    }
    else if (method === "writeClipboard")
        result.items = validateClipboardItems(payload.items, maxBytes);
    return boundedClipboardWire(result);
}
export function validateClipboardResult(method, value, maximum) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > MAX_CLIPBOARD_BYTES)
        throw new Error("Invalid clipboard maxBytes");
    if (!object(value))
        throw new Error("Invalid clipboard result");
    if (method === "readClipboardText") {
        keys(value, ["text"]);
        if (textBytes(value.text) > maximum)
            throw new Error("Clipboard byte limit exceeded");
        return boundedClipboardWire({ text: value.text });
    }
    if (method === "readClipboard") {
        keys(value, ["items"]);
        return boundedClipboardWire({ items: validateClipboardItems(value.items, maximum) });
    }
    if (method !== "writeClipboard" && method !== "writeClipboardText")
        throw new Error("Invalid clipboard method");
    keys(value, []);
    return {};
}
export class OpenBrowserUseClipboard {
    client;
    tabId;
    constructor(client, tabId) {
        this.client = client;
        this.tabId = tabId;
    }
    async readText(options = {}) { return (await this.client.readClipboardText(this.tabId, options)).text; }
    async writeText(text, options = {}) { await this.client.writeClipboardText(this.tabId, text, options); }
    async read(options = {}) { return (await this.client.readClipboard(this.tabId, options)).items; }
    async write(items, options = {}) { await this.client.writeClipboard(this.tabId, items, options); }
}
