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
const writeCheck = value => {
  if (value !== undefined && typeof value !== "function") throw new Error("OBU_SITE_ACCESS_INVALID: beforeWrite must be a synchronous function");
  return value;
};

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
  #generation = crypto.randomUUID();

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
      // A malformed API response does not establish that a saved record is
      // corrupt, and must never authorize overwriting unknown settings.
      if (!object(result)) this.#readFailed("read-error");
      let next, present;
      try {
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
      this.#generation = crypto.randomUUID();
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

  assertInvalidReplacement(expectedRecoveryId) {
    this.assertRecovery(expectedRecoveryId);
    if (this.#recovery.state !== "invalid")
      throw new Error("OBU_SITE_ACCESS_RECOVERY_UNAVAILABLE: only a confirmed invalid saved policy can be replaced");
  }

  replaceInvalid(config, expectedRecoveryId, { beforeWrite } = {}) {
    const candidate = normalizeSiteAccessPolicy(config);
    writeCheck(beforeWrite);
    this.assertInvalidReplacement(expectedRecoveryId);
    // Consume before queueing: reread and replacement share this one authority.
    const reservation = { state: "pending" };
    this.#recovery = reservation;
    this.#generation = crypto.randomUUID();
    this.error = undefined;
    const operation = this.#queueReplace(candidate, this.value.revision, this.#generation, { beforeWrite, reservation });
    this.ready = operation;
    operation.catch(() => {});
    return operation;
  }

  status() {
    return { ...this.value, generation: this.#generation, origins: [...this.value.origins], ready: this.loaded, ...(this.loaded ? { stored: this.#stored } : {}),
      ...(this.error ? { error: this.error } : {}), ...(this.#recovery ? { recovery: { ...this.#recovery } } : {}),
      ...(this.#failedWrite === this.value && this.#pendingWrites === 0 ? { retryable: true } : {}) };
  }

  get restricted() { return !this.loaded || this.value.mode !== "all"; }

  get generation() { return this.#generation; }

  assertGeneration(expectedGeneration) {
    if (typeof expectedGeneration !== "string" || expectedGeneration !== this.#generation)
      throw new Error("OBU_SITE_ACCESS_GENERATION_CONFLICT: review the current website access settings before saving");
  }

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

  async replace(config, expectedRevision, expectedGeneration, { beforeWrite } = {}) {
    // Copy and validate before queueing so a caller cannot mutate its request
    // while another persistent write is pending. CAS itself runs in the queue.
    const candidate = normalizeSiteAccessPolicy(config);
    if (!revision(expectedRevision)) throw new Error("OBU_SITE_ACCESS_REVISION_CONFLICT: refresh website access settings before saving");
    this.assertGeneration(expectedGeneration);
    writeCheck(beforeWrite);
    return this.#queueReplace(candidate, expectedRevision, expectedGeneration, { beforeWrite });
  }

  assertRetryable(expectedRevision, expectedGeneration) {
    this.assertGeneration(expectedGeneration);
    if (!revision(expectedRevision) || expectedRevision !== this.value.revision)
      throw new Error("OBU_SITE_ACCESS_REVISION_CONFLICT: review the failed website access settings before retrying");
    if (this.#failedWrite !== this.value || this.#pendingWrites !== 0)
      throw new Error("OBU_SITE_ACCESS_RETRY_UNAVAILABLE: there is no settled failed website policy write to retry");
  }

  async retry(expectedRevision, expectedGeneration, { beforeWrite } = {}) {
    this.assertRetryable(expectedRevision, expectedGeneration);
    writeCheck(beforeWrite);
    const failed = this.#failedWrite;
    // The caller selects only the reviewed revision, never replacement values.
    // Keep its identity until the serialized write rechecks the original CAS.
    return this.#queueReplace({ mode: failed.mode, origins: [...failed.origins] }, expectedRevision, expectedGeneration, { beforeWrite, failed });
  }

  #queueReplace(candidate, expectedRevision, expectedGeneration, { beforeWrite, failed, reservation }) {
    const readiness = this.ready;
    this.#pendingWrites++;
    const operation = this.writes.catch(() => {}).then(async () => {
      // Invalid replacement and exact failed-write retry have their own
      // authority. Neither can wait on the original rejected startup/read.
      if (!failed && !reservation) await readiness;
      this.assertGeneration(expectedGeneration);
      if (expectedRevision !== this.value.revision)
        throw new Error("OBU_SITE_ACCESS_REVISION_CONFLICT: refresh website access settings before saving");
      if (failed && this.#failedWrite !== failed)
        throw new Error("OBU_SITE_ACCESS_RETRY_UNAVAILABLE: the failed website policy write was superseded");
      if (reservation && this.#recovery !== reservation)
        throw new Error("OBU_SITE_ACCESS_RECOVERY_CONFLICT: the invalid website policy was superseded");
      if (!failed && !reservation) this.assertReady();
      if (!reservation && this.value.revision === Number.MAX_SAFE_INTEGER)
        throw new Error("OBU_SITE_ACCESS_REVISION_EXHAUSTED: website access revision cannot wrap");
      const next = Object.freeze({ version: 1, revision: reservation ? 1 : this.value.revision + 1, mode: candidate.mode, origins: Object.freeze([...candidate.origins]) });
      // This check is deliberately outside the native-write catch. An expired
      // admission made no storage attempt and cannot manufacture retry rights.
      try {
        const checked = beforeWrite?.();
        if (checked && typeof checked.then === "function") {
          Promise.resolve(checked).catch(() => {});
          throw new Error("OBU_SITE_ACCESS_INVALID: beforeWrite must finish synchronously");
        }
      } catch (error) {
        if (reservation && this.#recovery === reservation) {
          this.#recovery = { state: "invalid", id: crypto.randomUUID() };
          this.error = stateInvalid().message;
        }
        throw error;
      }
      this.value = next;
      this.loaded = false;
      this.error = undefined;
      this.#failedWrite = null;
      this.#recovery = null;
      try {
        // Never share mutable objects with the asynchronous storage adapter.
        await this.storage.set({ [SITE_ACCESS_POLICY_KEY]: { ...this.value, origins: [...this.value.origins] } });
        this.#stored = true;
        this.loaded = true;
        // A successful repair/retry also unblocks ordinary future saves. This
        // points at the real operation; no queued operation awaits itself.
        this.ready = operation;
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
