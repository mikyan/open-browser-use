import { validateClipboardRequest, validateClipboardResult } from "./browser-clipboard.js";

const PORT_NAME = "obu.clipboard.private.v1";
const MAX_PIXELS = 16 * 1024 * 1024;
const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = code => new Error(`OBU_CLIPBOARD_${code}: private clipboard operation unavailable`);
const own = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));

// This controller never inserts clipboard HTML into a document. Only its
// private Port carries payloads; runtime broadcast messages can only reconnect.
export class ClipboardOffscreen {
  constructor({ chrome, clipboard, ClipboardItem, Blob, createImageBitmap, crypto, now = () => Date.now() }) {
    // Window.createImageBitmap is receiver-sensitive. Retain its native global
    // receiver rather than accidentally invoking it with this controller.
    Object.assign(this, { chrome, clipboard, ClipboardItem, Blob, createImageBitmap: createImageBitmap.bind(globalThis), now });
    this.nonce = crypto.randomUUID();
    this.generation = 0;
    this.operation = null;
    this.port = null;
  }

  connect() {
    if (this.port) return;
    const port = this.chrome.runtime.connect({ name: PORT_NAME });
    this.port = port;
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = null;
      this.generation++;
      // A committed native promise remains alive. Prepared work is revoked.
      if (this.operation && !this.operation.committed) this.operation.revoked = true;
    });
    port.onMessage.addListener(message => { void this.receive(port, message); });
    port.postMessage({ type: "hello", version: 1, documentNonce: this.nonce });
  }

  reply(port, message) {
    try { port.postMessage(message); } catch { /* Retain settlement for recovery. */ }
  }

  check(operation) {
    if (operation.revoked || operation.generation !== this.generation || this.operation !== operation) throw fail("CANCELLED");
    if (this.now() >= operation.deadlineAt) throw fail("TIMEOUT");
  }

  async prepare(operation) {
    const params = validateClipboardRequest(operation.method, operation.params);
    operation.params = params;
    if (!this.clipboard || typeof this.clipboard.read !== "function" || typeof this.ClipboardItem !== "function") throw fail("UNSUPPORTED");
    if (operation.method !== "writeClipboard") return;
    operation.nativeItems = [];
    for (const item of params.items) {
      const data = {};
      for (const entry of item.entries) {
        this.check(operation);
        let blob;
        if (entry.mime_type === "image/png") {
          const binary = atob(entry.base64);
          blob = new this.Blob([Uint8Array.from(binary, character => character.charCodeAt(0))], { type: "image/png" });
          // Header validation bounds decode allocation; decoding verifies the
          // entire image before any clipboard write can be committed.
          const bitmap = await this.createImageBitmap(blob);
          try {
            if (!bitmap.width || !bitmap.height || bitmap.width > MAX_PIXELS / bitmap.height) throw fail("LIMIT");
          } finally { bitmap.close(); }
          this.check(operation);
        } else {
          blob = new this.Blob([entry.text], { type: entry.mime_type });
        }
        data[entry.mime_type] = blob;
      }
      operation.nativeItems.push(new this.ClipboardItem(data, { presentationStyle: item.presentation_style }));
    }
  }

  async readItems(items, maxBytes) {
    if (!Array.isArray(items) || items.length > 1) throw fail("LIMIT");
    let remaining = maxBytes;
    const result = [];
    for (const item of items) {
      if (!Array.isArray(item.types) || !item.types.length || item.types.length > 3 || new Set(item.types).size !== item.types.length ||
          item.types.some(type => !["text/plain", "text/html", "image/png"].includes(type))) throw fail("UNSUPPORTED");
      const entries = [];
      for (const type of item.types) {
        const blob = await item.getType(type);
        if (!Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > remaining) throw fail("LIMIT");
        remaining -= blob.size;
        if (type === "image/png") {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
          const entry = { mime_type: type, base64: btoa(binary) };
          validateClipboardResult("readClipboard", { items: [{ entries: [entry] }] }, maxBytes);
          const bitmap = await this.createImageBitmap(blob);
          try {
            if (!bitmap.width || !bitmap.height || bitmap.width > MAX_PIXELS / bitmap.height) throw fail("LIMIT");
          } finally { bitmap.close(); }
          entries.push(entry);
        } else entries.push({ mime_type: type, text: await blob.text() });
      }
      result.push({ entries, presentation_style: item.presentationStyle ?? "unspecified" });
    }
    return { items: result };
  }

  commit(operation) {
    this.check(operation);
    if (!operation.prepared) throw fail("CANCELLED");
    // No await between the final deadline/token check and the native API.
    operation.committed = true;
    let native;
    try {
      switch (operation.method) {
        case "readClipboardText": native = this.clipboard.readText(); break;
        case "writeClipboardText": native = this.clipboard.writeText(operation.params.text); break;
        case "readClipboard": native = this.clipboard.read(); break;
        case "writeClipboard": native = this.clipboard.write(operation.nativeItems); break;
        default: throw fail("INVALID");
      }
    } catch (error) { native = Promise.reject(error); }
    operation.settlement = Promise.resolve(native).then(async value => {
      if (operation.method === "readClipboardText") return { text: value };
      if (operation.method === "readClipboard") return this.readItems(value, operation.params.maxBytes);
      return {};
    }).then(result => validateClipboardResult(operation.method, result, operation.params.maxBytes));
    // The native promise is never raced against a timeout. The caller owns its
    // response deadline; this actual promise is needed for end/Pause draining.
    operation.settlement.catch(() => {});
    return operation.settlement;
  }

  release(operation) {
    if (!operation) return;
    operation.params = null;
    operation.nativeItems = null;
    operation.settlement = null;
    if (this.operation === operation) this.operation = null;
  }

  async receive(port, message) {
    if (port !== this.port || !own(message, ["type", "requestId", "workerNonce", "documentNonce", "operationId", "method", "params", "deadlineAt"]) ||
        !noncePattern.test(message.requestId ?? "") || !noncePattern.test(message.workerNonce ?? "") || message.documentNonce !== this.nonce) return;
    const response = { type: "reply", requestId: message.requestId, documentNonce: this.nonce, workerNonce: message.workerNonce };
    try {
      if (message.type === "bind") {
        const generation = ++this.generation;
        this.workerNonce = message.workerNonce;
        const previous = this.operation;
        if (previous) {
          if (!previous.committed) previous.revoked = true;
          await (previous.settlement ?? previous.preparation)?.catch(() => {});
        }
        if (generation !== this.generation || port !== this.port) throw fail("CANCELLED");
        const clearedOperationId = previous?.id ?? null;
        this.release(previous);
        this.reply(port, { ...response, ok: true, value: { clearedOperationId } });
        return;
      }
      if (this.workerNonce !== message.workerNonce) throw fail("CANCELLED");
      if (!noncePattern.test(message.operationId ?? "")) throw fail("INVALID");
      if (message.type === "prepare") {
        if (this.operation) throw fail("BUSY");
        if (!Number.isFinite(message.deadlineAt) || message.deadlineAt <= this.now()) throw fail("TIMEOUT");
        const operation = { id: message.operationId, generation: this.generation, method: message.method, params: message.params, deadlineAt: message.deadlineAt, committed: false, revoked: false };
        this.operation = operation;
        operation.preparation = this.prepare(operation);
        await operation.preparation;
        this.check(operation);
        operation.prepared = true;
        this.reply(port, { ...response, ok: true, value: {} });
        return;
      }
      const operation = this.operation;
      if (!operation || operation.id !== message.operationId) throw fail("CANCELLED");
      if (message.type === "commit") {
        if (operation.committed) throw fail("CANCELLED");
        const result = await this.commit(operation);
        // Retain only operation identity after settlement. Do not replay the
        // returned read data to a replacement worker during its bind.
        operation.params = null;
        operation.nativeItems = null;
        operation.settlement = Promise.resolve();
        this.reply(port, { ...response, ok: true, value: result });
      } else if (message.type === "abort") {
        if (operation.committed) await operation.settlement.catch(() => {});
        else { operation.revoked = true; await operation.preparation.catch(() => {}); }
        this.release(operation);
        this.reply(port, { ...response, ok: true, value: {} });
      } else throw fail("INVALID");
    } catch (error) {
      const code = /^OBU_CLIPBOARD_(?:INVALID|LIMIT|TIMEOUT|CANCELLED|BUSY|UNSUPPORTED):/.exec(error?.message ?? "")?.[0]?.slice(0, -1) ?? "OBU_CLIPBOARD_FAILED";
      this.reply(port, { ...response, ok: false, error: `${code}: private clipboard operation failed` });
    }
  }
}

// Importing the controller in tests does not touch the clipboard or Chrome.
if (typeof chrome !== "undefined" && typeof document !== "undefined") {
  const controller = new ClipboardOffscreen({ chrome, clipboard: navigator.clipboard, ClipboardItem: globalThis.ClipboardItem, Blob, createImageBitmap, crypto });
  Object.defineProperty(globalThis, "__obuClipboardDocumentNonce", { value: controller.nonce, configurable: false, writable: false });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === "obu.clipboard.reconnect" && sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("background.js") && !sender.tab) controller.connect();
  });
  controller.connect();
}
