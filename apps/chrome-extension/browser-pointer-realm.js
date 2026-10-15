// Realm identity is installation metadata, never attachment or input authority.
// Creating the schema and seed in one upgrade transaction prevents competing
// workers from choosing different committed identities. A request's success is
// insufficient: capture stays unavailable until the verifying transaction ends.
// https://www.w3.org/TR/IndexedDB/#transaction-scheduling
//
// Existing missing/invalid records are never repaired or rotated. Privileged
// deletion of the entire database is indistinguishable from first installation;
// arbitrary same-origin database writes are outside this persistence contract.
// Neither group release nor this connection's close destroys an isolated world.
export const POINTER_REALM_DATABASE = "open-browser-use-pointer-realm";
export const POINTER_REALM_STORE = "identity";
export const POINTER_REALM_KEY = "installation";
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const abi = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);
const fields = ["version", "worldId", "kernelId", "tokenId"];
const valid = value => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key)) &&
  value.version === 1 && [value.worldId, value.kernelId, value.tokenId].every(uuid) &&
  new Set([value.worldId, value.kernelId, value.tokenId]).size === 3;
const unavailable = () => new Error("OBU_POINTER_REALM_UNAVAILABLE: isolated pointer realm identity is unavailable");

export class PointerRealmIdentity {
  #database;
  #identity;
  #reason = null;
  #pending = true;
  #kernelABI;
  #resolveReady;

  // kernelABI versions the immutable injected closure, including its geometry
  // helper. Compatible workers reuse the whole identity; a changed ABI gets a
  // different world and kernel, rather than silently invoking an old closure.
  constructor({ indexedDB = globalThis.indexedDB, kernelABI, randomUUID = () => crypto.randomUUID() } = {}) {
    this.#kernelABI = abi(kernelABI) ? kernelABI : null;
    this.ready = new Promise(resolve => { this.#resolveReady = resolve; });
    if (!this.#kernelABI || typeof indexedDB?.open !== "function" || typeof randomUUID !== "function") {
      this.#revoke("invalid-configuration"); this.#finish(); return;
    }
    let request;
    try { request = indexedDB.open(POINTER_REALM_DATABASE, 1); }
    catch { this.#revoke("open-failed"); this.#finish(); return; }
    request.onblocked = () => {
      this.#revoke("open-blocked");
      // IDB cannot cancel an open request. A late result is closed below and
      // can never revive this instance. Optional readiness already failed.
      this.#resolveReady();
    };
    request.onupgradeneeded = event => {
      const transaction = request.transaction;
      try {
        if (this.#reason || event.oldVersion !== 0 || request.result.objectStoreNames.length !== 0) throw unavailable();
        const seed = { version: 1, worldId: randomUUID(), kernelId: randomUUID(), tokenId: randomUUID() };
        if (!valid(seed)) throw unavailable();
        request.result.createObjectStore(POINTER_REALM_STORE).add(seed, POINTER_REALM_KEY);
      } catch {
        this.#revoke("initialization-failed");
        try { transaction.abort(); } catch {}
      }
    };
    request.onerror = () => { this.#revoke("open-failed"); this.#finish(); };
    request.onsuccess = () => {
      const database = this.#database = request.result;
      database.onversionchange = () => this.#revoke("version-changed");
      database.onclose = () => this.#revoke("connection-closed");
      if (this.#reason) { database.close(); this.#finish(); return; }
      this.#verify(database);
    };
  }

  #revoke(reason) {
    this.#reason ??= reason;
    this.#identity = undefined;
    try { this.#database?.close(); } catch {}
  }

  #finish() { this.#pending = false; this.#resolveReady(); }

  #verify(database) {
    let transaction;
    try {
      if (database.version !== 1 || database.objectStoreNames.length !== 1 || !database.objectStoreNames.contains(POINTER_REALM_STORE)) throw unavailable();
      transaction = database.transaction(POINTER_REALM_STORE, "readonly");
      let value, count, read = false, counted = false;
      transaction.onabort = () => { this.#revoke("read-aborted"); this.#finish(); };
      transaction.onerror = () => this.#revoke("read-failed");
      transaction.oncomplete = () => {
        if (!this.#reason && read && counted && count === 1 && valid(value)) {
          this.#identity = Object.freeze({ kernelABI: this.#kernelABI,
            worldName: `Open Browser Use passive pointer ${value.worldId} ${this.#kernelABI}`,
            kernelKey: `__obuNativePointer_${value.kernelId}_${this.#kernelABI}`,
            kernelToken: `${value.tokenId}:${this.#kernelABI}` });
        } else this.#revoke("invalid-record");
        this.#finish();
      };
      const store = transaction.objectStore(POINTER_REALM_STORE);
      if (store.keyPath !== null || store.autoIncrement || store.indexNames.length !== 0) throw unavailable();
      const countRequest = store.count(), readRequest = store.get(POINTER_REALM_KEY);
      countRequest.onsuccess = () => { count = countRequest.result; counted = true; };
      readRequest.onsuccess = () => { value = readRequest.result; read = true; };
    } catch {
      this.#revoke("invalid-schema");
      if (transaction) { try { transaction.abort(); return; } catch {} }
      this.#finish();
    }
  }

  capture() {
    if (this.#reason || !this.#identity) return null;
    const identity = this.#identity;
    return Object.freeze({ identity, check: () => {
      if (this.#reason || this.#identity !== identity) throw unavailable();
    } });
  }

  snapshot() {
    return { available: !!this.#identity && !this.#reason, state: this.#reason ? "disabled" : this.#identity ? "ready" : "loading",
      reason: this.#reason, pending: this.#pending, kernelABI: this.#kernelABI };
  }
}
