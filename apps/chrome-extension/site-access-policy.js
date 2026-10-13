// Durable user settings only. The backend owns trusted-popup admission,
// pausing/draining browser control before replace, and document/frame checks.
// storage.local must be restricted to TRUSTED_CONTEXTS by startup wiring. This
// is an automation policy, not a security boundary against the local profile.
export const SITE_ACCESS_POLICY_KEY = "OPEN_BROWSER_USE_SITE_ACCESS_POLICY";
const modes = new Set(["all", "allow", "block"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const revision = value => Number.isSafeInteger(value) && value >= 0;
const invalid = () => new Error("OBU_SITE_ACCESS_INVALID: expected a mode and at most 100 exact HTTP(S) origins");
const unavailable = () => new Error("OBU_SITE_ACCESS_UNAVAILABLE: website access settings are not ready");
const stateInvalid = () => new Error("OBU_SITE_ACCESS_STATE_INVALID: persisted website access settings are invalid");

function normalizeOrigin(value) {
  // URL parsing alone accepts whitespace, backslashes, credentials and several
  // abbreviated URL forms. Settings deliberately accept only an authority and
  // an optional single root slash; canonicalization still handles IDN and ports.
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 ||
      !/^https?:\/\/[^/]+\/?$/i.test(value) || /[\s\\@%?#*]/u.test(value)) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash || url.origin === "null") throw invalid();
  const authority = value.slice(value.indexOf("://") + 3).replace(/\/$/, "");
  const suppliedHost = authority.replace(/:\d+$/, "");
  // Do not silently reinterpret short, integer, hex or octal IPv4 spellings,
  // or a dangling port separator, in a user's explicit origin setting.
  if (authority.endsWith(":") || (/^(?:\d+\.){3}\d+$/.test(url.hostname) && suppliedHost !== url.hostname)) throw invalid();
  return url.origin;
}

export function normalizeSiteAccessPolicy(config) {
  if (!exactKeys(config, ["mode", "origins"]) || !modes.has(config.mode) || !Array.isArray(config.origins) ||
      config.origins.length > 100 || (config.mode === "all" && config.origins.length !== 0)) throw invalid();
  const origins = [...new Set(config.origins.map(normalizeOrigin))].sort();
  return { mode: config.mode, origins };
}

export class SiteAccessPolicy {
  #failedWrite = null;
  #pendingWrites = 0;
  #recovery = null;
  #stored = false;

  constructor({ storage } = {}) {
    if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function")
      throw new TypeError("SiteAccessPolicy requires a storage.local adapter");
    this.storage = storage;
    this.value = { version: 1, revision: 0, mode: "all", origins: [] };
    this.loaded = false;
    this.error = undefined;
    this.writes = Promise.resolve();
    this.#startLoad();
  }

  #startLoad() {
    // Reserve before calling the adapter, including adapters which throw
    // synchronously. An observer timeout cannot grant another read attempt.
    this.#recovery = { state: "pending" };
    this.loaded = false;
    this.error = undefined;
    const operation = (async () => {
      let result;
      try { result = await this.storage.get(SITE_ACCESS_POLICY_KEY); }
      catch (cause) { this.#readFailed("read-error", cause); }
      let next, present;
      try {
        if (!object(result)) throw stateInvalid();
        const value = result[SITE_ACCESS_POLICY_KEY];
        present = value !== undefined;
        if (present) {
          if (!exactKeys(value, ["version", "revision", "mode", "origins"]) || value.version !== 1 || !revision(value.revision)) throw stateInvalid();
          next = { version: 1, revision: value.revision, ...normalizeSiteAccessPolicy({ mode: value.mode, origins: value.origins }) };
        } else {
          // Confirmed absence follows fresh-start compatibility. This read is
          // not a reset/write or CAS against external storage modifications.
          next = { version: 1, revision: 0, mode: "all", origins: [] };
        }
      } catch { this.#readFailed("invalid"); }
      this.value = next;
      this.#stored = present;
      this.#recovery = null;
      this.loaded = true;
      this.error = undefined;
      return this.status();
    })();
    this.ready = operation;
    // Reading status is safe even when nobody is currently awaiting startup.
    operation.catch(() => {});
    return operation;
  }

  #readFailed(state, cause) {
    const failure = state === "invalid" ? stateInvalid()
      : new Error("OBU_SITE_ACCESS_UNAVAILABLE: website access settings could not be loaded", { cause });
    this.loaded = false;
    this.error = failure.message;
    this.#recovery = { state, id: crypto.randomUUID() };
    throw failure;
  }

  assertRecovery(expectedRecoveryId) {
    if (this.loaded || this.#pendingWrites !== 0 || this.#failedWrite || !this.#recovery?.id)
      throw new Error("OBU_SITE_ACCESS_RECOVERY_UNAVAILABLE: there is no settled website policy read to recover");
    if (typeof expectedRecoveryId !== "string" || expectedRecoveryId !== this.#recovery.id)
      throw new Error("OBU_SITE_ACCESS_RECOVERY_CONFLICT: refresh website access settings before reloading");
  }

  retryLoad(expectedRecoveryId) {
    this.assertRecovery(expectedRecoveryId);
    // Keep this method synchronous through reservation and return the actual
    // new ready promise. The backend owns trusted admission and Pause/drain.
    return this.#startLoad();
  }

  status() {
    return { ...this.value, origins: [...this.value.origins], ready: this.loaded, ...(this.loaded ? { stored: this.#stored } : {}),
      ...(this.error ? { error: this.error } : {}), ...(this.#recovery ? { recovery: { ...this.#recovery } } : {}),
      ...(this.#failedWrite === this.value && this.#pendingWrites === 0 ? { retryable: true } : {}) };
  }

  get restricted() { return !this.loaded || this.value.mode !== "all"; }

  assertReady() { if (!this.loaded) throw unavailable(); }

  allowsUrl(value, { allowBlank = false } = {}) {
    if (!this.loaded) return false;
    if (this.value.mode === "all") return true;
    if (typeof value !== "string" || !value) return false;
    if (allowBlank && value === "about:blank") return true;
    // Actual document URLs may include paths/search/fragments. Match only their
    // parsed origin; never use prefix matching or infer a srcdoc parent here.
    if (!/^https?:\/\//i.test(value) || /[\s\\]/u.test(value)) return false;
    let url;
    try { url = new URL(value); } catch { return false; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.origin === "null") return false;
    const listed = this.value.origins.includes(url.origin);
    return this.value.mode === "allow" ? listed : !listed;
  }

  assertUrl(value, options) {
    if (!this.allowsUrl(value, options)) throw new Error("OBU_SITE_ACCESS_DENIED: website access is not allowed by the current user policy");
  }

  async replace(config, expectedRevision) {
    // Copy and validate before queueing so a caller cannot mutate its request
    // while another persistent write is pending. CAS itself runs in the queue.
    const candidate = normalizeSiteAccessPolicy(config);
    if (!revision(expectedRevision)) throw new Error("OBU_SITE_ACCESS_REVISION_CONFLICT: refresh website access settings before saving");
    return this.#queueReplace(candidate, expectedRevision);
  }

  assertRetryable(expectedRevision) {
    if (!revision(expectedRevision) || expectedRevision !== this.value.revision)
      throw new Error("OBU_SITE_ACCESS_REVISION_CONFLICT: review the failed website access settings before retrying");
    if (this.#failedWrite !== this.value || this.#pendingWrites !== 0)
      throw new Error("OBU_SITE_ACCESS_RETRY_UNAVAILABLE: there is no settled failed website policy write to retry");
  }

  async retry(expectedRevision) {
    this.assertRetryable(expectedRevision);
    const failed = this.#failedWrite;
    // The caller selects only the reviewed revision, never replacement values.
    // Keep its identity until the serialized write rechecks the original CAS.
    return this.#queueReplace({ mode: failed.mode, origins: [...failed.origins] }, expectedRevision, failed);
  }

  #queueReplace(candidate, expectedRevision, failed) {
    this.#pendingWrites++;
    const operation = this.writes.catch(() => {}).then(async () => {
      await this.ready;
      if (expectedRevision !== this.value.revision)
        throw new Error("OBU_SITE_ACCESS_REVISION_CONFLICT: refresh website access settings before saving");
      if (failed && this.#failedWrite !== failed)
        throw new Error("OBU_SITE_ACCESS_RETRY_UNAVAILABLE: the failed website policy write was superseded");
      if (this.value.revision === Number.MAX_SAFE_INTEGER)
        throw new Error("OBU_SITE_ACCESS_REVISION_EXHAUSTED: website access revision cannot wrap");
      this.value = Object.freeze({ version: 1, revision: this.value.revision + 1, mode: candidate.mode, origins: Object.freeze([...candidate.origins]) });
      this.loaded = false;
      this.error = undefined;
      this.#failedWrite = null;
      try {
        // Never share mutable objects with the asynchronous storage adapter.
        await this.storage.set({ [SITE_ACCESS_POLICY_KEY]: { ...this.value, origins: [...this.value.origins] } });
        this.#stored = true;
        this.loaded = true;
      } catch (error) {
        const failure = new Error("OBU_SITE_ACCESS_UNAVAILABLE: website access settings could not be saved", { cause: error });
        this.error = failure.message;
        // Only the real storage operation's rejection grants retry authority.
        // Timeout of an outer observer never reaches this branch by itself.
        this.#failedWrite = this.value;
        throw failure;
      }
      return this.status();
    }).finally(() => { this.#pendingWrites--; });
    this.writes = operation;
    return operation;
  }
}
