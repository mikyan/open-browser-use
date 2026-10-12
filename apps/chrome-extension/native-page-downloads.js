const METHOD = "obu.native.pageDownloads";
const PROOF = "__obuNativeDownloadBinding";
const WORKER_BOOT_ID = crypto.randomUUID();
const owners = new WeakMap();
const operations = new Set(["claim", "path", "cancel", "release"]);
const claimKeys = ["guid", "frameId", "rootTargetId", "session_id", "turn_id", "control_epoch", "tabId", "claimId"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 256) => typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
const keys = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const failure = (code, message) => new Error(`OBU_NATIVE_DOWNLOAD_${code}: ${message}`);
const envelope = params => ({ jsonrpc: "2.0", method: METHOD, params: { version: 1, ...params } });

function copyClaim(value) {
  if (!keys(value, claimKeys)) throw failure("CLAIM", "invalid original Page claim");
  const descriptors = Object.getOwnPropertyDescriptors(value), copy = {};
  for (const key of claimKeys) {
    if (!Object.hasOwn(descriptors[key], "value")) throw failure("CLAIM", "claim fields must be JSON values");
    copy[key] = descriptors[key].value;
  }
  if (!["guid", "frameId", "rootTargetId", "claimId"].every(key => text(copy[key])) ||
      !["session_id", "turn_id"].every(key => text(copy[key], 4096)) ||
      !Number.isSafeInteger(copy.control_epoch) || copy.control_epoch < 1 ||
      !Number.isSafeInteger(copy.tabId) || copy.tabId < 0) throw failure("CLAIM", "invalid original Page claim");
  return copy;
}

// One instance belongs to one actual Native Port. Neither proof nor request
// IDs enter the public SDK RPC namespace. send must capture that original port.
export class NativePageDownloads {
  #send; #extensionId; #getInstanceId; #target; #onStateChange;
  #portId = crypto.randomUUID();
  #closed = false;
  #challenge = null;
  #proof = null;
  #nonces = new Set();
  #pending = new Map();
  #state = { version: 1, available: false, reason: "Native Browser binding is not ready" };

  constructor({ send, extensionId, getInstanceId, target = globalThis, onStateChange = () => {} }) {
    if (typeof send !== "function" || !/^[a-p]{32}$/.test(extensionId) || typeof getInstanceId !== "function" ||
        !object(target) || typeof onStateChange !== "function") throw new TypeError("NativePageDownloads requires a port sender and extension identity");
    this.#send = send; this.#extensionId = extensionId; this.#getInstanceId = getInstanceId;
    this.#target = target; this.#onStateChange = onStateChange;
    owners.get(target)?.close(failure("DISCONNECTED", "native port was replaced"));
    owners.set(target, this);
  }

  status() { return { ...this.#state }; }

  receive(message) {
    if (message?.method !== METHOD) return false;
    if (this.#closed || !keys(message, ["jsonrpc", "method", "params"]) || message.jsonrpc !== "2.0") return true;
    const p = message.params;
    if (!object(p) || p.version !== 1) return true;
    if (p.type === "challenge" && keys(p, ["version", "type", "requestId", "nonce"]) && text(p.requestId) && text(p.nonce)) this.#beginChallenge(p);
    else if (p.type === "ready" && keys(p, ["version", "type", "nonce", "generation", "available"], ["reason"]) &&
        text(p.nonce) && text(p.generation) && typeof p.available === "boolean" && (p.reason === undefined || text(p.reason, 4096))) this.#ready(p);
    else if (p.type === "reply") this.#reply(p);
    return true; // Malformed private traffic never falls through to public RPC.
  }

  #beginChallenge(p) {
    if (this.#nonces.has(p.nonce)) return;
    // Retain replay protection for the whole port lifetime, with a hard bound
    // instead of evicting an old nonce that could revive a retired generation.
    if (this.#nonces.size >= 4096) { this.close(failure("CAPACITY", "native port challenge capacity exceeded")); return; }
    this.#nonces.add(p.nonce);
    this.#clearProof();
    const challenge = { requestId: p.requestId, nonce: p.nonce, published: false, generation: null, retired: false };
    this.#challenge = challenge;
    this.#unavailable(failure("DISCONNECTED", "native Browser challenge changed"));
    void Promise.resolve().then(() => this.#current(challenge) ? this.#getInstanceId() : undefined).then(extensionInstanceId => {
      if (!this.#current(challenge)) return;
      if (!text(extensionInstanceId)) throw failure("IDENTITY", "extension instance identity is unavailable");
      const proof = Object.freeze({ nonce: p.nonce, extensionId: this.#extensionId, extensionInstanceId, workerBootId: WORKER_BOOT_ID, portId: this.#portId });
      Object.defineProperty(this.#target, PROOF, { value: proof, configurable: true, enumerable: false, writable: false });
      this.#proof = proof; challenge.published = true;
      this.#send(envelope({ type: "response", requestId: p.requestId, nonce: p.nonce, result: proof }));
    }).catch(error => { if (this.#current(challenge)) this.close(error); });
  }

  #current(challenge) { return !this.#closed && this.#challenge === challenge && owners.get(this.#target) === this; }

  #ready(p) {
    const c = this.#challenge;
    if (!c?.published || !this.#current(c) || c.nonce !== p.nonce || c.retired || (c.generation !== null && c.generation !== p.generation)) return;
    c.generation = p.generation;
    if (!p.available) {
      c.retired = true;
      this.#unavailable(failure("DISCONNECTED", p.reason ?? "original Browser binding is unavailable"), p.generation);
      this.#clearProof();
      return;
    }
    this.#state = { version: 1, available: true, generation: p.generation };
    this.#notify();
  }

  async request(operation, payload, { deadlineAt } = {}) {
    const wallStart = Date.now(), monoStart = performance.now();
    if (!Number.isFinite(deadlineAt)) throw failure("TIMEOUT", "a finite original deadline is required");
    const duration = Math.min(120000, deadlineAt - wallStart), monoDeadline = monoStart + duration;
    if (duration < 1) throw failure("TIMEOUT", "original download deadline expired");
    const c = this.#challenge;
    if (!this.#state.available || !c || !this.#current(c)) throw failure("DISCONNECTED", this.#state.reason ?? "original Browser binding is unavailable");
    if (!operations.has(operation)) throw failure("PROTOCOL", "unknown private download operation");
    const claim = copyClaim(payload);
    if (this.#pending.size >= 128) throw failure("CAPACITY", "private download request capacity exceeded");
    const requestId = crypto.randomUUID(), remaining = () => Math.min(deadlineAt - Date.now(), monoDeadline - performance.now());
    const timeoutMs = Math.floor(remaining());
    if (timeoutMs < 1) throw failure("TIMEOUT", "original download deadline expired");
    return new Promise((resolve, reject) => {
      const pending = { operation, challenge: c, generation: c.generation, remaining, resolve, reject, timer: null };
      this.#pending.set(requestId, pending);
      pending.timer = setTimeout(() => this.#settle(requestId, failure("TIMEOUT", "original download deadline expired")), Math.ceil(remaining()));
      try {
        this.#send(envelope({ type: "request", requestId, nonce: c.nonce, generation: c.generation, operation, payload: claim, timeoutMs }));
      } catch (error) { this.close(error); }
    });
  }

  #reply(p) {
    if (!text(p.requestId) || !text(p.nonce) || !text(p.generation)) return;
    const pending = this.#pending.get(p.requestId);
    if (!pending || !this.#state.available || !this.#current(pending.challenge) || pending.challenge.nonce !== p.nonce || pending.generation !== p.generation) return;
    if (pending.remaining() <= 0) { this.#settle(p.requestId, failure("TIMEOUT", "original download deadline expired")); return; }
    if (!keys(p, ["version", "type", "requestId", "nonce", "generation"], ["result", "error"]) || Object.hasOwn(p, "result") === Object.hasOwn(p, "error")) {
      this.#settle(p.requestId, failure("PROTOCOL", "malformed private download reply")); return;
    }
    if (Object.hasOwn(p, "error")) {
      this.#settle(p.requestId, keys(p.error, ["message"]) && text(p.error.message, 4096) ? new Error(p.error.message) : failure("PROTOCOL", "malformed private download error"));
      return;
    }
    const result = p.result, valid = pending.operation === "path" ? keys(result, ["path"]) && text(result.path, 32768) :
      pending.operation === "cancel" ? keys(result, ["cancelled"]) && result.cancelled === true : keys(result, []);
    this.#settle(p.requestId, valid ? null : failure("PROTOCOL", "malformed private download result"), valid ? { ...result } : undefined);
  }

  #settle(id, error, result) {
    const pending = this.#pending.get(id); if (!pending) return;
    this.#pending.delete(id); clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve(result);
  }

  #notify() {
    try { this.#onStateChange(this.status())?.catch?.(() => {}); } catch {}
  }

  #unavailable(error, generation) {
    this.#state = { version: 1, available: false, ...(generation ? { generation } : {}), reason: String(error?.message ?? error) };
    for (const id of this.#pending.keys()) this.#settle(id, error);
    this.#notify();
  }

  #clearProof() {
    if (this.#proof && this.#target[PROOF] === this.#proof) delete this.#target[PROOF];
    this.#proof = null;
  }

  close(reason = failure("DISCONNECTED", "original native port closed")) {
    if (this.#closed) return;
    this.#closed = true; this.#challenge = null; this.#nonces.clear(); this.#clearProof();
    if (owners.get(this.#target) === this) owners.delete(this.#target);
    this.#unavailable(reason instanceof Error ? reason : failure("DISCONNECTED", String(reason)));
  }
}
