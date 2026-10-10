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
  constructor({ storage } = {}) {
    if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function")
      throw new TypeError("SiteAccessPolicy requires a storage.local adapter");
    this.storage = storage;
    this.value = { version: 1, revision: 0, mode: "all", origins: [] };
    this.loaded = false;
    this.error = undefined;
    this.writes = Promise.resolve();
    this.ready = this.load();
    // Reading status is safe even when nobody is currently awaiting startup.
    this.ready.catch(() => {});
  }

  async load() {
    try {
      const stored = await this.storage.get(SITE_ACCESS_POLICY_KEY);
      if (!object(stored)) throw stateInvalid();
      const value = stored[SITE_ACCESS_POLICY_KEY];
      if (value !== undefined) {
        if (!exactKeys(value, ["version", "revision", "mode", "origins"]) || value.version !== 1 || !revision(value.revision)) throw stateInvalid();
        let config;
        try { config = normalizeSiteAccessPolicy({ mode: value.mode, origins: value.origins }); }
        catch { throw stateInvalid(); }
        this.value = { version: 1, revision: value.revision, ...config };
      }
      this.loaded = true;
    } catch (error) {
      const failure = error?.message?.startsWith("OBU_SITE_ACCESS_STATE_INVALID:") ? stateInvalid()
        : new Error("OBU_SITE_ACCESS_UNAVAILABLE: website access settings could not be loaded", { cause: error });
      this.loaded = false;
      this.error = failure.message;
      throw failure;
    }
  }

  status() {
    return { ...this.value, origins: [...this.value.origins], ready: this.loaded, ...(this.error ? { error: this.error } : {}) };
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
    const operation = this.writes.catch(() => {}).then(async () => {
      await this.ready;
      if (expectedRevision !== this.value.revision)
        throw new Error("OBU_SITE_ACCESS_REVISION_CONFLICT: refresh website access settings before saving");
      if (this.value.revision === Number.MAX_SAFE_INTEGER)
        throw new Error("OBU_SITE_ACCESS_REVISION_EXHAUSTED: website access revision cannot wrap");
      this.value = { version: 1, revision: this.value.revision + 1, ...candidate };
      this.loaded = false;
      this.error = undefined;
      try {
        // Never share mutable objects with the asynchronous storage adapter.
        await this.storage.set({ [SITE_ACCESS_POLICY_KEY]: { ...this.value, origins: [...this.value.origins] } });
        this.loaded = true;
      } catch (error) {
        const failure = new Error("OBU_SITE_ACCESS_UNAVAILABLE: website access settings could not be saved", { cause: error });
        this.error = failure.message;
        throw failure;
      }
      return this.status();
    });
    this.writes = operation;
    return operation;
  }
}
