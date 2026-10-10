// Private host-to-extension framing for requests larger than Chrome's native
// message limit. This is a per-port receiver, not an additional public RPC API.
const CHUNK_BYTES = 512 * 1024;
const MIN_BYTES = 1024 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const PRIVATE_PREFIX = "obu.native.";
const HOST_ID = /^obu:[1-9][0-9]{0,19}$/;
const errors = Object.freeze({
  INVALID: "OBU_NATIVE_TRANSPORT_INVALID: invalid native request framing",
  CONFLICT: "OBU_NATIVE_TRANSPORT_CONFLICT: overlapping native request framing",
  TIMEOUT: "OBU_NATIVE_TRANSPORT_TIMEOUT: native request assembly deadline expired",
  ABORTED: "OBU_NATIVE_TRANSPORT_ABORTED: native request assembly was aborted"
});
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hostId = value => typeof value === "string" && HOST_ID.test(value) ? value : null;
const budget = value => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 120000;
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export class NativeMessageReceiver {
  constructor({ dispatch, send, now = () => performance.now(), wallNow = () => Date.now(), setTimer = (callback, delay) => setTimeout(callback, delay), clearTimer = timer => clearTimeout(timer) }) {
    if (typeof dispatch !== "function" || typeof send !== "function") throw new TypeError("NativeMessageReceiver requires dispatch and send callbacks");
    Object.assign(this, { dispatch, send, now, wallNow, setTimer, clearTimer });
    this.active = null;
    this.closed = false;
  }

  receive(message) {
    if (this.closed) return;
    const privateMessage = typeof message?.method === "string" && message.method.startsWith(PRIVATE_PREFIX);
    if (!privateMessage) {
      if (this.active && message?.id === this.active.id) return this.reject("CONFLICT", this.active.id);
      return this.dispatch(message);
    }
    const incomingId = hostId(message?.params?.id);
    if (!exactKeys(message, ["jsonrpc", "method", "params"]) || message.jsonrpc !== "2.0") return this.reject("INVALID", incomingId);
    if (this.active && (this.now() >= this.active.deadlineAt || this.wallNow() >= this.active.deadlineUnixMs)) return this.reject("TIMEOUT", incomingId);
    if (message.method === "obu.native.start") return this.start(message.params);
    if (this.active && incomingId !== this.active.id) return this.reject("CONFLICT", incomingId);
    switch (message.method) {
      case "obu.native.chunk": return this.chunk(message.params);
      case "obu.native.commit": return this.commit(message.params);
      case "obu.native.abort":
        if (!exactKeys(message.params, ["id"]) || !incomingId || !this.active) return this.reject("INVALID", incomingId);
        return this.reject("ABORTED", incomingId);
      default: return this.reject("INVALID", incomingId);
    }
  }

  start(params) {
    const id = hostId(params?.id);
    if (this.active) return this.reject("CONFLICT", id);
    if (!exactKeys(params, ["id", "totalBytes", "totalChunks", "timeoutMs", "deadlineUnixMs"]) || !id ||
        !Number.isSafeInteger(params.totalBytes) || params.totalBytes <= MIN_BYTES || params.totalBytes > MAX_BYTES ||
        params.totalChunks !== Math.ceil(params.totalBytes / CHUNK_BYTES) || !budget(params.timeoutMs) ||
        !Number.isSafeInteger(params.deadlineUnixMs) || params.deadlineUnixMs <= 0) return this.reject("INVALID", id);
    const startedAt = this.now();
    const remaining = Math.min(params.timeoutMs, params.deadlineUnixMs - this.wallNow());
    if (remaining <= 0) return this.reject("TIMEOUT", id);
    let bytes;
    try { bytes = new Uint8Array(params.totalBytes); }
    catch { return this.reject("INVALID", id); }
    const state = { id, bytes, nextIndex: 0, receivedBytes: 0, totalChunks: params.totalChunks, startedAt, deadlineAt: startedAt + remaining, deadlineUnixMs: params.deadlineUnixMs };
    this.active = state;
    try {
      state.timer = this.setTimer(() => {
        if (!this.closed && this.active === state) this.reject("TIMEOUT", id);
      }, Math.max(0, state.deadlineAt - this.now()));
    } catch (error) {
      this.clear();
      throw error;
    }
  }

  chunk(params) {
    const state = this.active, id = hostId(params?.id);
    if (!state || !exactKeys(params, ["id", "index", "data"]) || !Number.isSafeInteger(params.index) ||
        params.index !== state.nextIndex || params.index >= state.totalChunks || typeof params.data !== "string") return this.reject("INVALID", id);
    const expectedBytes = Math.min(CHUNK_BYTES, state.bytes.length - state.receivedBytes);
    if (params.data.length !== Math.ceil(expectedBytes / 3) * 4) return this.reject("INVALID", id);
    let binary;
    try { binary = atob(params.data); }
    catch { return this.reject("INVALID", id); }
    // A canonical roundtrip rejects whitespace, URL-safe alphabet, missing
    // padding and nonzero unused padding bits without a large-input regexp.
    if (binary.length !== expectedBytes || btoa(binary) !== params.data) return this.reject("INVALID", id);
    for (let index = 0; index < binary.length; index++) state.bytes[state.receivedBytes + index] = binary.charCodeAt(index);
    state.receivedBytes += binary.length;
    state.nextIndex++;
  }

  commit(params) {
    const state = this.active, id = hostId(params?.id);
    if (!state || !exactKeys(params, ["id", "remainingMs"]) || !budget(params.remainingMs) ||
        state.nextIndex !== state.totalChunks || state.receivedBytes !== state.bytes.length) return this.reject("INVALID", id);
    const commitStartedAt = this.now();
    let request;
    try { request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(state.bytes)); }
    catch { return this.reject("INVALID", id); }
    if (!object(request) || request.jsonrpc !== "2.0" || request.id !== state.id || typeof request.method !== "string" || request.method.startsWith(PRIVATE_PREFIX)) return this.reject("INVALID", id);
    // Decoding and parsing are part of assembly, too. A large final payload
    // must not start an action after its deadline while the timer is queued.
    const currentTime = this.now(), elapsed = currentTime - state.startedAt, parseElapsed = currentTime - commitStartedAt;
    // Host and extension share the machine's wall clock; this absolute bound
    // covers time queued before delivery. The monotonic bound prevents a wall
    // clock rollback after start from granting that time back to the request.
    const transportRemaining = Math.min(state.deadlineAt - currentTime, state.deadlineUnixMs - this.wallNow(), params.remainingMs - parseElapsed);
    if (elapsed < 0 || parseElapsed < 0 || transportRemaining <= 0) return this.reject("TIMEOUT", id);
    // Preserve absent/invalid/unknown parameters so the ordinary RPC validator
    // retains its meaning. Only a valid, explicitly supplied budget is reduced.
    if (object(request.params) && request.params.timeoutMs >= 1 && budget(request.params.timeoutMs)) {
      const remaining = Math.floor(Math.min(request.params.timeoutMs - elapsed, transportRemaining));
      if (remaining < 1) return this.reject("TIMEOUT", id);
      request.params.timeoutMs = remaining;
    }
    this.clear();
    // Dispatch only after clearing state. Callback failures propagate, never
    // become a framing retry or a second execution of this assembled request.
    return this.dispatch(request);
  }

  reject(kind, incomingId) {
    const ids = new Set([this.active?.id, incomingId].filter(id => id !== undefined && id !== null));
    if (!ids.size) ids.add(null);
    this.clear();
    let failure;
    for (const id of ids) {
      if (this.closed) break;
      try { this.send({ jsonrpc: "2.0", id, error: { code: -32000, message: errors[kind] } }); }
      catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }

  clear() {
    const state = this.active;
    this.active = null;
    if (state) {
      state.bytes = null;
      if (state.timer !== undefined) this.clearTimer(state.timer);
    }
  }

  close() {
    this.closed = true;
    this.clear();
  }
}
