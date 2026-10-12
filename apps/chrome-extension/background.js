import { createBrowserActionEngine } from "./browser-runtime.js";
import { NativeInputTracker } from "./browser-input-adapter.js";
import { BrowserLifetime } from "./browser-lifetime.js";
import { BrowserNetworkWaits } from "./browser-network-waits.js";
import { BrowserNavigationWaits } from "./browser-navigation-waits.js";
import { BrowserFileChooserWaits } from "./browser-file-chooser-waits.js";
import { DirectoryUploadRegistry } from "./browser-directory-upload.js";
import { BrowserDownloadWaits } from "./browser-download-waits.js";
import { BrowserPageWaits } from "./browser-page-waits.js";
import { BrowserDownloads, downloadDeadline } from "./browser-downloads.js";
import { validateMediaDownload, MEDIA_CANCEL_FUNCTION } from "./browser-media-source.js";
import { MediaContextLifetimes } from "./browser-media-lifetime.js";
import { BrowserPageExports } from "./browser-page-exports.js";
import { BrowserClipboard } from "./browser-clipboard.js";
import { BrowserClipboardBroker } from "./clipboard-broker.js";
import { BROWSER_ENGINE_INFO, validateBrowserAction } from "./browser-action-engine.js";
import { AuxiliaryTabOwnership } from "./auxiliary-tab-ownership.js";
import { NativeMessageReceiver } from "./native-message-receiver.js";
import { NativePageDownloads } from "./native-page-downloads.js";
import { SiteAccessPolicy, normalizeSiteAccessPolicy } from "./site-access-policy.js";
import { assertSiteAccessFrames } from "./site-access-frames.js";

const NATIVE_HOST_NAME = "com.ifuryst.open_browser_use.extension";
let extensionInstancePromise;
function getExtensionInstanceId() {
  if (!extensionInstancePromise) {
    extensionInstancePromise = (async () => {
      const stored = await chrome.storage.local.get("extensionInstanceId");
      if (typeof stored.extensionInstanceId === "string" && stored.extensionInstanceId) return stored.extensionInstanceId;
      const extensionInstanceId = crypto.randomUUID();
      await chrome.storage.local.set({ extensionInstanceId });
      return extensionInstanceId;
    })().catch(error => { extensionInstancePromise = undefined; throw error; });
  }
  return extensionInstancePromise;
}
const NATIVE_HOST_STATUS_KEY = "OPEN_BROWSER_USE_NATIVE_HOST_STATUS";
const SESSION_STATE_KEY = "OPEN_BROWSER_USE_SESSION_STATE";
const CONTROL_STATE_KEY = "OPEN_BROWSER_USE_CONTROL_STATE";
const AUTOMATION_CONTROL_KEY = "OPEN_BROWSER_USE_AUTOMATION_CONTROL";
const MAX_CONTROL_SESSIONS = 64;
const MAX_LEGACY_TURNS = 256;
const AUTOMATION_CLEANUP_TIMEOUT_MS = 10_000;
const WEBMCP_ENABLED_KEY = "OPEN_BROWSER_USE_WEBMCP_ENABLED";
const RECONNECT_ALARM_NAME = "open-browser-use-native-reconnect";
const HEARTBEAT_ALARM_NAME = "open-browser-use-heartbeat";
const DEFAULT_CDP_TIMEOUT_MS = 10_000;
const DEFAULT_WEBMCP_TIMEOUT_MS = 10_000;
const DEFAULT_WEBMCP_LIST_TIMEOUT_MS = 5_000;
const WEBMCP_TIMEOUT_GRACE_MS = 1_500;
const CURSOR_ARRIVAL_TIMEOUT_MS = 1_000;
const POINTER_FEEDBACK_TIMEOUT_MS = 250;
const MAX_POINTER_FEEDBACK_JOBS = 8;
const MAX_USER_TABS = 1000;
const DEFAULT_SESSION_GROUP_TITLE = "Task - OBU";
const DELIVERABLE_GROUP_TITLE = "✅ Open Browser Use";
const LEGACY_SESSION_GROUP_TITLE_PATTERN = /^Open Browser Use [0-9a-f]{8}$/i;
const WEBMCP_CAPABILITY = {
  id: "webmcp",
  description: "Fetch page-defined WebMCP tools bound to the current document and invoke them."
};
const WEBMCP_CONTENT_SCRIPTS = [
  {
    id: "open-browser-use-webmcp-main",
    js: ["content-webmcp-main.js"],
    matches: ["<all_urls>"],
    persistAcrossSessions: false,
    runAt: "document_start",
    world: "MAIN"
  },
  {
    id: "open-browser-use-webmcp-bridge",
    js: ["content-webmcp-bridge.js"],
    matches: ["<all_urls>"],
    persistAcrossSessions: false,
    runAt: "document_start",
    world: "ISOLATED"
  }
];
const PUBLIC_BROWSER_METHODS = new Set([
  "ping", "getInfo", "getControlState", "createTab", "getTabs", "getUserTabs", "getUserHistory", "claimUserTab", "finalizeTabs", "nameSession",
  "attach", "detach", "executeCdp", "browserAction", "moveMouse", "webmcp_list_tools", "webmcp_invoke_tool",
  "waitForFileChooser", "setFileChooserFiles", "waitForDownload", "downloadURL", "downloadMedia", "downloadPath", "cancelDownload", "readClipboardText", "writeClipboardText",
  "armNetworkWait", "collectNetworkWait", "cancelNetworkWait",
  "armNavigationWait", "collectNavigationWait", "cancelNavigationWait",
  "armFileChooserWait", "collectFileChooserWait", "cancelFileChooserWait",
  "armDownloadWait", "collectDownloadWait", "cancelDownloadWait",
  "armPageWait", "collectPageWait", "cancelPageWait",
  "readClipboard", "writeClipboard", "exportPage", "turnEnded", "executeUnhandledCommand"
]);

class JsonRpcPeer {
  constructor(transport, handlers) {
    this.transport = transport;
    this.handlers = handlers;
    this.transport.setMessageCallback((message, reply) => {
      void this.handleMessage(message, reply);
    });
  }

  async handleMessage(message, reply = response => this.transport.sendMessage(response)) {
    if (!message || typeof message !== "object" || typeof message.method !== "string") {
      return;
    }
    const id = message.id;
    try {
      const handler = PUBLIC_BROWSER_METHODS.has(message.method) ? this.handlers[message.method] : undefined;
      if (typeof handler !== "function") {
        throw new Error(`No handler registered for method: ${message.method}`);
      }
      const result = await handler.call(this.handlers, message.params ?? {});
      if (id !== undefined) {
        reply({ jsonrpc: "2.0", id, result: result ?? {} });
      }
    } catch (error) {
      if (id !== undefined) {
        reply({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error)
          }
        });
      }
    }
  }

  sendNotification(method, params) {
    this.transport.sendMessage({ jsonrpc: "2.0", method, params });
  }
}

class NativeTransport {
  constructor(hostName, { onDisconnect = () => {} } = {}) {
    this.hostName = hostName;
    this.port = null;
    this.receiver = null;
    this.pageDownloads = null;
    this.messageCallback = null;
    this.onDisconnect = onDisconnect;
    this.reconnectAttempt = 0;
    this.reconnect = null;
    this.reconnectAlarmUpdate = Promise.resolve();
    this.status = {
      hostName: this.hostName,
      lastChecked: Date.now(),
      reconnectAttempt: this.reconnectAttempt,
      state: "disconnected"
    };
    this.connect();
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === RECONNECT_ALARM_NAME && !this.port) {
        this.connect();
      }
    });
  }

  setMessageCallback(callback) {
    this.messageCallback = callback;
  }

  sendMessage(message) {
    if (!this.port) {
      this.scheduleReconnect("native host disconnected");
      throw new Error("Native host is disconnected");
    }
    this.port.postMessage(message);
  }

  connect() {
    if (this.port) {
      return;
    }
    // The alarm may wake a replacement worker whose short timer was lost.
    // A real attempt consumes the pending retry; notifications never do.
    if (this.reconnect) clearTimeout(this.reconnect.timer);
    this.reconnect = null;
    let port, receiver, pageDownloads;
    try {
      port = chrome.runtime.connectNative(this.hostName);
      this.port = port;
      receiver = new NativeMessageReceiver({
        dispatch: message => {
          if (this.port === port && this.receiver === receiver) this.messageCallback?.(message, response => {
            // A new native host starts a new request-ID namespace. A handler
            // admitted on the old port must never reply on its replacement.
            if (this.port === port && this.receiver === receiver) port.postMessage(response);
          });
        },
        send: message => {
          if (this.port === port && this.receiver === receiver) port.postMessage(message);
        }
      });
      this.receiver = receiver;
      pageDownloads = new NativePageDownloads({
        target: globalThis,
        extensionId: chrome.runtime.id,
        getInstanceId: getExtensionInstanceId,
        send: message => {
          if (this.port !== port || this.pageDownloads !== pageDownloads) throw new Error("Original native port disconnected");
          port.postMessage(message);
        }
      });
      this.pageDownloads = pageDownloads;
      port.onMessage.addListener((message) => {
        if (this.port === port && this.receiver === receiver && !pageDownloads.receive(message)) receiver.receive(message);
      });
      port.onDisconnect.addListener(() => {
        if (this.port !== port) return;
        this.port = null;
        this.receiver = null;
        this.pageDownloads = null;
        pageDownloads.close("Native host disconnected");
        receiver.close();
        // Fence already admitted work before scheduling the replacement host.
        // The callback is tied to this exact port, just like replies above.
        this.onDisconnect();
        this.scheduleReconnect(chrome.runtime.lastError?.message ?? "native host disconnected");
      });
      port.postMessage({ jsonrpc: "2.0", method: "obu.native.hello", params: { version: 1 } });
      this.reconnectAttempt = 0;
      this.setStatus({ state: "connected" });
      this.updateReconnectAlarm(() => {
        if (this.port === port && !this.reconnect) return chrome.alarms.clear(RECONNECT_ALARM_NAME);
      });
    } catch (error) {
      if (this.port === port) { this.port = null; this.receiver = null; this.pageDownloads = null; }
      pageDownloads?.close("Native host connection failed");
      receiver?.close();
      try { port?.disconnect(); } catch {}
      this.scheduleReconnect(error instanceof Error ? error.message : String(error));
    }
  }

  scheduleReconnect(error) {
    if (this.port || this.reconnect) return;
    const retry = { timer: null };
    this.reconnect = retry;
    this.reconnectAttempt += 1;
    this.setStatus({
      state: "reconnecting",
      error,
      nextRetryMs: 5000,
      reconnectAttempt: this.reconnectAttempt
    });
    retry.timer = setTimeout(() => {
      if (this.reconnect === retry && !this.port) this.connect();
    }, 5000);
    this.updateReconnectAlarm(() => {
      // Packed extensions clamp alarms to 30 seconds. Keep this fallback
      // while the worker lives, and do not postpone it on each heartbeat.
      if (this.reconnect === retry && !this.port)
        return chrome.alarms.create(RECONNECT_ALARM_NAME, { periodInMinutes: 0.5 });
    });
  }

  updateReconnectAlarm(operation) {
    // Serialize native alarm writes: a slow clear for an earlier successful
    // port must finish before a later disconnect creates its replacement.
    this.reconnectAlarmUpdate = this.reconnectAlarmUpdate.then(operation).catch(() => {});
  }

  setStatus(status) {
    this.status = {
      hostName: this.hostName,
      lastChecked: Date.now(),
      reconnectAttempt: this.reconnectAttempt,
      ...status
    };
    chrome.storage.local
      .set({
        [NATIVE_HOST_STATUS_KEY]: this.status
      })
      .catch(() => {});
  }

  getStatus() {
    return this.status;
  }
}

class SessionStore {
  constructor(lifetime) {
    this.lifetime = lifetime;
    this.writes = Promise.resolve();
    this.state = { sessions: {}, deliverableGroupId: null };
    this.ready = this.load();
  }

  async load() {
    await this.lifetime.ready;
    const stored = await chrome.storage.local.get(SESSION_STATE_KEY);
    const value = stored[SESSION_STATE_KEY];
    this.state = { incarnation: this.lifetime.incarnation, sessions: {}, deliverableGroupId: null, deliverableGroups: {} };
    if (value && typeof value === "object") {
      const sameLifetime = this.lifetime.isCurrent(value.incarnation);
      this.state = {
        incarnation: this.lifetime.incarnation,
        sessions: value.sessions && typeof value.sessions === "object" && !Array.isArray(value.sessions) ? value.sessions : {},
        deliverableGroupId:
          sameLifetime && typeof value.deliverableGroupId === "number" ? value.deliverableGroupId : null,
        deliverableGroups: sameLifetime && value.deliverableGroups && typeof value.deliverableGroups === "object" && !Array.isArray(value.deliverableGroups) ? value.deliverableGroups : {},
        deliverableTabs: sameLifetime && value.deliverableTabs && typeof value.deliverableTabs === "object" && !Array.isArray(value.deliverableTabs) ? value.deliverableTabs : {}
      };
      let migrated = !sameLifetime;
      for (const session of Object.values(this.state.sessions)) {
        if (session && typeof session === "object" && !sameLifetime) {
          session.chromeGroupId = null;
          session.activeTabId = null;
          session.tabOrigins = {};
          session.ungrouped = false;
        }
        if (
          session &&
          typeof session === "object" &&
          typeof session.title === "string" &&
          LEGACY_SESSION_GROUP_TITLE_PATTERN.test(session.title)
        ) {
          session.title = DEFAULT_SESSION_GROUP_TITLE;
          migrated = true;
        }
      }
      if (migrated) {
        await this.save();
      }
    }
  }

  async save() {
    const state = structuredClone(this.state);
    this.writes = this.writes.catch(() => {}).then(() => chrome.storage.local.set({ [SESSION_STATE_KEY]: state }));
    await this.writes;
  }

  async getSession(sessionId) {
    await this.ready;
    const existing = Object.hasOwn(this.state.sessions, sessionId) ? this.state.sessions[sessionId] : undefined;
    if (existing && typeof existing === "object") {
      return existing;
    }
    const created = {
      chromeGroupId: null,
      title: DEFAULT_SESSION_GROUP_TITLE,
      activeTabId: null,
      tabOrigins: {}
    };
    Object.defineProperty(this.state.sessions, sessionId, { value: created, enumerable: true, writable: true, configurable: true });
    await this.save();
    return created;
  }

  async removeSession(sessionId) {
    await this.ready;
    delete this.state.sessions[sessionId];
    await this.save();
  }

  async findSessionByGroup(groupId) {
    await this.ready;
    for (const [sessionId, session] of Object.entries(this.state.sessions)) {
      if (session.chromeGroupId === groupId) {
        return { sessionId, session };
      }
    }
    return null;
  }
}

// Epochs come from one persistent monotonic counter. Evicting an idle session
// cannot make an old epoch valid again, even when that session is bootstrapped.
class ControlLedger {
  constructor(assertAdmission = () => {}, lifetime) {
    this.lifetime = lifetime;
    this.assertAdmission = assertAdmission;
    this.records = new Map();
    this.counter = 0;
    this.noNewLegacy = false;
    this.writes = Promise.resolve();
    this.ready = this.load();
  }

  async load() {
    if (this.lifetime) await this.lifetime.ready;
    const { [CONTROL_STATE_KEY]: state } = await chrome.storage.local.get(CONTROL_STATE_KEY);
    if (!state) return;
    if (state.version !== 1 || !Number.isSafeInteger(state.counter) || state.counter < 0 || !Array.isArray(state.records)) {
      throw new Error("OBU_CONTROL_STATE_INVALID: refusing to reset persisted control epochs");
    }
    this.counter = state.counter;
    this.noNewLegacy = state.noNewLegacy === true;
    for (const entry of state.records) {
      const [id, record] = entry;
      if (typeof id !== "string" || !record || !Number.isSafeInteger(record.epoch) || record.epoch < 1 || record.epoch > this.counter ||
          !["idle", "active", "closing"].includes(record.status) || !Array.isArray(record.legacyTurns) || record.legacyTurns.length > MAX_LEGACY_TURNS) {
        throw new Error("OBU_CONTROL_STATE_INVALID: invalid persisted session epoch");
      }
      this.records.set(id, record);
    }
    if (this.records.size > MAX_CONTROL_SESSIONS) throw new Error("OBU_CONTROL_STATE_INVALID: too many persisted sessions");
    if (this.lifetime && !this.lifetime.isCurrent(state.incarnation)) {
      this.noNewLegacy = true;
      for (const record of this.records.values()) {
        this.invalidate(record, "browser-lifetime-changed");
        record.legacyBlocked = true;
        record.legacyTurns = [];
      }
      await this.save();
    }
  }

  save() {
    const state = JSON.parse(JSON.stringify({ version: 1, incarnation: this.lifetime?.incarnation, counter: this.counter, noNewLegacy: this.noNewLegacy, records: [...this.records] }));
    const write = this.writes.catch(() => {}).then(() => chrome.storage.local.set({ [CONTROL_STATE_KEY]: state }));
    this.writes = write;
    return write;
  }

  nextEpoch() {
    if (this.counter >= Number.MAX_SAFE_INTEGER) throw new Error("OBU_CONTROL_EPOCH_EXHAUSTED: control epoch counter cannot wrap");
    return ++this.counter;
  }

  create(sessionId, legacy = false) {
    if (legacy && this.noNewLegacy) throw new Error("OBU_CONTROL_BOOTSTRAP_REQUIRED: call getControlState and send control_epoch");
    if (this.records.size >= MAX_CONTROL_SESSIONS) {
      const idle = [...this.records].find(([, record]) => record.status === "idle");
      if (!idle) throw new Error("OBU_CONTROL_CAPACITY: end an active session before bootstrapping another");
      this.noNewLegacy = true;
      this.records.delete(idle[0]);
      if (legacy) throw new Error("OBU_CONTROL_BOOTSTRAP_REQUIRED: call getControlState and send control_epoch");
    }
    const record = { epoch: this.nextEpoch(), status: "idle", legacyTurns: [], legacyBlocked: this.noNewLegacy };
    this.records.set(sessionId, record);
    return record;
  }

  describe(record) {
    return { controlEpoch: record.epoch, closing: record.status === "closing", nextTurnId: `turn-${record.epoch}`, lifecycleVersion: 1 };
  }

  async bootstrap(sessionId) {
    await this.ready;
    this.assertAdmission();
    const record = this.records.get(sessionId) ?? this.create(sessionId);
    await this.save();
    this.assertAdmission();
    return this.describe(record);
  }

  assertCurrent(params) {
    this.assertAdmission();
    const record = this.records.get(params.session_id);
    if (params.control_epoch !== undefined) {
      if (!Number.isSafeInteger(params.control_epoch) || params.control_epoch < 1) throw new Error("control_epoch must be a positive safe integer");
      if (!record || record.epoch !== params.control_epoch) throw new Error("OBU_STALE_CONTROL_EPOCH: bootstrap a new turn explicitly; do not replay the request");
    } else {
      if (!record || record.legacyBlocked) throw new Error("OBU_CONTROL_BOOTSTRAP_REQUIRED: call getControlState and send control_epoch");
      if (record.legacyTurns.some(([id, ended]) => id === params.turn_id && ended)) throw new Error("OBU_TURN_ENDED: this browser turn has ended");
    }
    if (record.status === "closing") throw new Error("OBU_CONTROL_ENDING: browser control is still being released");
    return record;
  }

  async admit(params) {
    await this.ready;
    this.assertAdmission();
    let record = this.records.get(params.session_id);
    if (!record && params.control_epoch === undefined) {
      try { record = this.create(params.session_id, true); }
      catch (error) { await this.save(); throw error; }
    }
    record = this.assertCurrent(params);
    let changed = record.status !== "active";
    record.status = "active";
    if (params.control_epoch === undefined && !record.legacyTurns.some(([id]) => id === params.turn_id)) {
      if (record.legacyTurns.length >= MAX_LEGACY_TURNS) {
        record.legacyBlocked = true;
        record.legacyTurns = [];
        await this.save();
        throw new Error("OBU_CONTROL_BOOTSTRAP_REQUIRED: legacy turn capacity reached; send control_epoch");
      }
      record.legacyTurns.push([params.turn_id, false]);
      changed = true;
    }
    if (changed) await this.save();
    else await this.writes;
    this.assertCurrent(params);
    return record;
  }

  async beginEnd(params) {
    await this.ready;
    const record = this.assertCurrent(params);
    this.invalidate(record, params.turn_id);
    await this.save();
    return record;
  }

  invalidate(record, endedTurnId) {
    record.status = "closing";
    record.epoch = this.nextEpoch();
    record.legacyTurns = record.legacyTurns.map(([id]) => [id, true]);
    record.endedTurnId = endedTurnId;
  }

  async invalidateAll(reason = "user-pause") {
    await this.ready;
    this.noNewLegacy = true;
    for (const record of this.records.values()) {
      this.invalidate(record, reason);
      record.legacyBlocked = true;
      record.legacyTurns = [];
    }
    await this.save();
  }

  async finishEnd(record) {
    record.status = "idle";
    await this.save();
    const { closing, ...state } = this.describe(record);
    return { ...state, endedTurnId: record.endedTurnId };
  }
}

// User control is separate from session epochs: pausing fences admission even
// when storage or debugger cleanup fails. Only a trusted popup can resume it.
class AutomationControlGate {
  constructor() {
    this.state = "running";
    this.inputBlocked = false;
    this.revision = 0;
    this.cleanupComplete = false;
    this.error = undefined;
    this.requestedPause = false;
    this.pauseSequence = 0;
    this.pendingTabIds = new Set();
    this.recoveredPendingTabs = new Set();
    this.writes = Promise.resolve();
    this.ready = this.load();
  }

  async load() {
    try {
      const { [AUTOMATION_CONTROL_KEY]: value } = await chrome.storage.local.get(AUTOMATION_CONTROL_KEY);
      if (value !== undefined && (!value || value.version !== 1 || typeof value.paused !== "boolean" || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
          (value.pendingTabIds !== undefined && (!Array.isArray(value.pendingTabIds) || value.pendingTabIds.length > 10000 || value.pendingTabIds.some(id => !Number.isSafeInteger(id) || id < 0))) ||
          (value.paused === false && value.pendingTabIds?.length))) {
        throw new Error("OBU_AUTOMATION_STATE_INVALID: invalid persisted user control state");
      }
      this.revision = value?.revision ?? 0;
      this.pendingTabIds = new Set(value?.pendingTabIds ?? []);
      this.recoveredPendingTabs = new Set(this.pendingTabIds);
      this.incarnation = typeof value?.incarnation === "string" ? value.incarnation : null;
      this.inputBlocked = this.requestedPause || value?.paused === true;
      if (this.state !== "error") this.state = this.inputBlocked ? "pausing" : "running";
    } catch (error) {
      this.loadError = error;
      this.fail(error);
    }
  }

  block() {
    this.pauseSequence++;
    this.requestedPause = true;
    this.inputBlocked = true;
    this.state = "pausing";
    this.cleanupComplete = false;
  }

  assertOpen() {
    if (this.inputBlocked) throw new Error("OBU_AUTOMATION_PAUSED: browser automation is paused; resume in the extension popup, then begin a new turn explicitly");
  }

  status() {
    return { state: this.state, inputBlocked: this.inputBlocked, revision: this.revision, cleanupComplete: this.cleanupComplete, ...(this.error ? { error: this.error } : {}) };
  }

  fail(error) {
    this.requestedPause = true;
    this.inputBlocked = true;
    this.cleanupComplete = false;
    this.state = "error";
    this.error = String(error?.message ?? error);
  }

  async persist(paused) {
    // Recovery writes must not replace unread durable revision/pending IDs
    // with constructor defaults when startup storage is still unresolved.
    await this.ready;
    if (this.loadError) throw this.loadError;
    const value = { version: 1, incarnation: this.incarnation, paused, revision: this.revision, pendingTabIds: [...this.pendingTabIds] };
    this.writes = this.writes.catch(() => {}).then(() => chrome.storage.local.set({ [AUTOMATION_CONTROL_KEY]: value }));
    await this.writes;
  }
}

class WebMcpGate {
  constructor() {
    this.enabledValue = false;
    this.applyQueue = Promise.resolve(false);
    this.ready = this.refresh();
    chrome.storage.onChanged?.addListener((changes, areaName) => {
      if (areaName !== "local" || !Object.hasOwn(changes, WEBMCP_ENABLED_KEY)) {
        return;
      }
      const enabled = changes[WEBMCP_ENABLED_KEY]?.newValue !== false;
      this.ready = this.queueApply(enabled);
    });
  }

  async enabled() {
    await this.ready;
    return this.enabledValue;
  }

  async refresh() {
    try {
      const stored = await chrome.storage.local.get(WEBMCP_ENABLED_KEY);
      return await this.queueApply(stored[WEBMCP_ENABLED_KEY] !== false);
    } catch {
      this.enabledValue = false;
      return false;
    }
  }

  queueApply(enabled) {
    this.applyQueue = this.applyQueue
      .catch(() => false)
      .then(async () => await this.apply(enabled));
    return this.applyQueue;
  }

  async apply(enabled) {
    if (
      typeof chrome.scripting?.getRegisteredContentScripts !== "function" ||
      typeof chrome.scripting?.registerContentScripts !== "function" ||
      typeof chrome.scripting?.unregisterContentScripts !== "function"
    ) {
      this.enabledValue = false;
      return false;
    }
    const ids = WEBMCP_CONTENT_SCRIPTS.map((script) => script.id);
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids });
    if (registered.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: registered.map((script) => script.id) });
    }
    if (enabled) {
      await chrome.scripting.registerContentScripts(WEBMCP_CONTENT_SCRIPTS);
    }
    this.enabledValue = enabled;
    return enabled;
  }
}

class BrowserBackend {
  constructor({ webMcpGate = null, browserEngine = null, automationCleanupTimeoutMs = AUTOMATION_CLEANUP_TIMEOUT_MS } = {}) {
    this.automationCleanupTimeoutMs = automationCleanupTimeoutMs;
    this.automationControl = new AutomationControlGate();
    const trustedStorage = chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }) ?? Promise.resolve();
    this.siteAccess = new SiteAccessPolicy({ storage: {
      get: async key => { await trustedStorage; return chrome.storage.local.get(key); },
      set: async value => { await trustedStorage; return chrome.storage.local.set(value); }
    } });
    this.siteNavigationVersions = new Map();
    this.sitePendingFrames = new Map();
    this.siteRevokedTabs = new Set();
    this.sitePolicyUpdate = null;
    this.browserLifetime = new BrowserLifetime({ storage: chrome.storage,
      onStartup: chrome.runtime?.onStartup,
      legacyPending: async () => { await this.automationControl.ready; return { tabIds: [...this.automationControl.recoveredPendingTabs], incarnation: this.automationControl.incarnation }; }
    });
    this.store = new SessionStore(this.browserLifetime);
    this.controlLedger = new ControlLedger(() => { this.assertControlOpen(); this.siteAccess.assertReady(); }, this.browserLifetime);
    this.acceptedRequests = new Set();
    this.controlBootstrapRequests = new Set();
    this.nativeRecovery = null;
    this.automationTransitions = Promise.resolve();
    this.pauseReleaseFailures = new Map();
    this.inputRiskIds = new WeakMap();
    const durableInput = async operation => {
      try { return await operation(); }
      catch (error) { this.automationControl.fail(error); void this.automationControl.persist(true).catch(() => {}); throw error; }
    };
    const clearInput = (tabId, token) => durableInput(async () => {
      const riskId = this.inputRiskIds.get(token);
      if (riskId) await this.browserLifetime.clearInputRisk(riskId);
    });
    this.inputTracker = new NativeInputTracker({
      beforeInput: (tabId, token) => durableInput(async () => {
        let riskId = this.inputRiskIds.get(token);
        if (!riskId) { riskId = crypto.randomUUID(); this.inputRiskIds.set(token, riskId); }
        await this.browserLifetime.markInputRisk({ riskId, tabId });
      }),
      assertInput: (tabId, token) => {
        this.assertControlOpen();
        this.assertAttachmentAdmission(tabId, token);
        if (this.controlReleases.has(tabId) || this.browserEngine?.releases?.has(tabId))
          throw new Error("OBU_INPUT_RELEASE_IN_PROGRESS: original attachment cleanup has started");
        const owner = this.attachmentOwners.get(tabId);
        if (!owner || owner.attachment !== token) throw new Error("OBU_TRANSFER_CANCELLED: input attachment ownership changed");
        this.assertTransferScope(owner);
      },
      released: clearInput, onDestroyed: clearInput
    });
    this.networkWaits = new BrowserNetworkWaits();
    this.navigationWaits = new BrowserNavigationWaits();
    this.directDownloads = new BrowserDownloads({ downloads: chrome.downloads, extensionId: chrome.runtime?.id,
      validateScope: scope => this.validateDirectDownloadScope(scope), assertScope: scope => this.assertDirectDownloadScope(scope) });
    this.exportDocumentRevisions = new Map();
    this.pageExports = new BrowserPageExports({
      send: (scope, method, args, options) => this.sendPageExportCommand(scope, method, args, options),
      validateScope: scope => this.validatePageExportScope(scope),
      assertScope: scope => this.assertPageExportScope(scope)
    });
    this.clipboardBroker = new BrowserClipboardBroker({ chrome, validateScope: scope => this.validateClipboardScope(scope) });
    this.clipboard = new BrowserClipboard({
      execute: (...args) => this.clipboardBroker.execute(...args),
      validateScope: scope => this.validateClipboardScope(scope),
      assertScope: scope => this.assertClipboardScope(scope)
    });
    this.navigationSetups = new Map();
    this.auxiliaryTabs = new AuxiliaryTabOwnership({ storage: {
      setAccessLevel: value => chrome.storage.session.setAccessLevel(value),
      get: async key => {
        await this.browserLifetime.ready;
        const stored = await chrome.storage.session.get(key), value = stored[key];
        if (value === undefined) return {};
        if (!this.browserLifetime.isCurrent(value?.incarnation)) {
          await chrome.storage.session.set({ [key]: { version: 1, incarnation: this.browserLifetime.incarnation, records: [] } });
          return {};
        }
        const { incarnation, ...state } = value;
        return { [key]: state };
      },
      set: async values => {
        await this.browserLifetime.ready;
        return chrome.storage.session.set(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { ...value, incarnation: this.browserLifetime.incarnation }])));
      }
    } });
    this.auxiliaryReleases = new Map();
    this.creationTransactions = new Map();
    this.freshBlankTabs = new Map();
    this.membershipAdmissions = new Map();
    this.sessionMutations = new Map();
    this.endingSessions = new Map();
    this.webMcpGate = webMcpGate;
    this.browserEngine = browserEngine;
    this.controlEpochs = new Map();
    this.controlReleases = new Map();
    this.pageWaitNativeReleases = new Map();
    this.coldAttachmentResets = new Set();
    this.attachedTabs = new Set();
    this.attachmentEpochs = new Map();
    this.attachmentOwners = new Map();
    this.revokedAttachmentTokens = new WeakSet();
    this.destroyedAttachmentTokens = new WeakSet();
    this.pendingAttachmentEpochs = new Map();
    this.childSessionsByTabId = new Map();
    this.pendingAttachmentTabs = new Set();
    this.documentEpochs = new Map();
    this.activeTabsBySession = new Map();
    this.cursorByTabId = new Map();
    this.pointerFeedbackByTabId = new Map();
    this.renderingQueues = new Map();
    this.renderingDrains = new Set();
    this.externalScreencastTabs = new Set();
    this.internalScreencasts = new Map();
    this.downloadsById = new Map();
    this.downloadWaits = new BrowserDownloadWaits({
      send: (scope, sessionId) => chrome.debugger.sendCommand({ tabId: scope.tabId, ...(sessionId ? { sessionId } : {}) }, "Page.enable"),
      assertScope: scope => this.assertTransferScope(scope),
      validateScope: async (scope, waiter) => {
        await this.validateTransferScope(scope);
        if (waiter.result && this.downloadsById.get(waiter.result.downloadId)?.waiterId !== waiter.waiterId)
          throw new Error("OBU_DOWNLOAD_WAIT_EXPIRED: download result is no longer available");
      },
      sourceAlive: (scope, sessionId) => this.attachedTabs.has(scope.tabId) && this.attachmentEpochs.get(scope.tabId) === scope.attachment &&
        (sessionId === undefined || this.childSessionsByTabId.get(scope.tabId)?.has(sessionId)),
      publish: (result, waiter) => {
        const record = this.downloadsById.get(result.downloadId);
        if (record?.waiterId !== waiter.waiterId) throw new Error("OBU_DOWNLOAD_WAIT_EXPIRED: download result is no longer available");
        record.authorized = true;
        this.claimPageDownload(record, waiter.deadlineAt);
        this.emitDownloadChange(record);
      },
      discard: (result, waiter) => {
        if (this.downloadsById.get(result.downloadId)?.waiterId === waiter.waiterId) this.retirePageDownload(result.downloadId);
      },
      deliver: (result, waiter) => {
        const record = this.downloadsById.get(result.downloadId);
        if (record?.waiterId === waiter.waiterId) record.delivered = true;
      }
    });
    this.downloadWaiters = this.downloadWaits.byTab;
    this.pageWaits = new BrowserPageWaits({
      assertScope: scope => {
        this.assertControlOpen();
        this.assertTransferScope(scope);
        if (scope.controlRevision !== this.automationControl.revision)
          throw new Error("OBU_PAGE_WAIT_EXPIRED: automation control changed");
      },
      validateScope: async (scope, record) => {
        await this.validateTransferScope(scope);
        this.pageWaits.check(record);
        await this.assertSiteTab(scope.tabId);
        this.pageWaits.check(record);
        if (record.pageResult) await this.validateCreatedPage(record);
      },
      snapshotFrames: scope => chrome.webNavigation.getAllFrames({ tabId: scope.tabId }),
      adopt: (scope, event, record) => this.adoptCreatedPage(scope, event, record),
      release: record => record.pageAdmission ? this.releaseAuxiliaryClaim(record.pageAdmission, { pageWaitRelease: record }) : Promise.resolve()
    });
    this.downloadChangeListeners = new Set();
    this.cursorArrivalWaitersByKey = new Map();
    this.fileChoosersById = new Map();
    this.fileInputDocumentsByTabId = new Map();
    this.directoryUploads = new DirectoryUploadRegistry({
      send: (target, method, commandParams) => chrome.debugger.sendCommand(target, method, commandParams),
      checkCurrent: scope => {
        this.assertControlOpen();
        this.assertAttachmentAdmission(scope.tabId, scope.attachment);
        this.assertTransferScope(scope);
      },
      canCleanup: identity => this.attachedTabs.has(identity.tabId) && this.attachmentEpochs.get(identity.tabId) === identity.attachment &&
        this.fileInputDocumentsByTabId.get(identity.tabId)?.get(identity.frameId) === identity.documentToken &&
        (identity.sessionId === undefined || this.childSessionsByTabId.get(identity.tabId)?.has(identity.sessionId))
    });
    this.fileChooserWaits = new BrowserFileChooserWaits({
      send: (scope, sessionId, enabled) => chrome.debugger.sendCommand({ tabId: scope.tabId, ...(sessionId ? { sessionId } : {}) }, "Page.setInterceptFileChooserDialog", { enabled }),
      assertScope: scope => this.assertTransferScope(scope),
      validateScope: async (scope, record) => {
        await this.validateTransferScope(scope);
        if (record.selectedDocumentEpoch !== undefined && record.selectedDocumentEpoch !== (this.documentEpochs.get(scope.tabId) ?? 0))
          throw new Error("OBU_FILE_CHOOSER_WAIT_EXPIRED: chooser document changed");
        if (record.result && !this.fileChoosersById.has(record.result.fileChooserId))
          throw new Error("OBU_FILE_CHOOSER_WAIT_EXPIRED: chooser result is no longer available");
      },
      targetAlive: (scope, sessionId) => this.attachedTabs.has(scope.tabId) && this.attachmentEpochs.get(scope.tabId) === scope.attachment &&
        (sessionId === undefined || this.childSessionsByTabId.get(scope.tabId)?.has(sessionId)),
      discard: result => this.fileChoosersById.delete(result.fileChooserId)
    });
    this.fileChooserWaitersByTabId = this.fileChooserWaits.byTab;
    this.fileChooserSetupsByTabId = new Map();
    this.nextCursorMoveSequence = 1;
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (typeof source.tabId === "number") {
        if (reason === "target_closed") this.markAttachmentDestroyed(source.tabId);
        this.networkWaits.invalidateTab(source.tabId);
        this.navigationWaits.invalidateTab(source.tabId);
        void this.fileChooserWaits.invalidateTab(source.tabId).catch(() => {});
        void this.downloadWaits.invalidateTab(source.tabId).catch(() => {});
        void this.pageWaits.invalidateTab(source.tabId).catch(() => {});
        void this.directDownloads.invalidateTab(source.tabId);
        void this.pageExports.invalidateTab(source.tabId).catch(() => {});
        void this.clipboard.invalidateTab(source.tabId).catch(() => {});
        this.controlEpochs.set(source.tabId, (this.controlEpochs.get(source.tabId) ?? 0) + 1);
        this.browserEngine?.forget(source.tabId);
        try { this.releaseEngineAttachment(source.tabId); }
        catch (error) { this.pauseReleaseFailures.set(source.tabId, error); void this.pauseAutomation().catch(() => {}); }
      }
    });
    chrome.tabs?.onRemoved?.addListener(tabId => {
      void this.browserLifetime.originalTabRemoved(tabId).catch(error => this.automationControl.fail(error));
      this.markAttachmentDestroyed(tabId);
      this.browserEngine?.forget?.(tabId);
      this.siteNavigationVersions.delete(tabId);
      this.exportDocumentRevisions.delete(tabId);
      this.sitePendingFrames.delete(tabId);
      this.siteRevokedTabs.delete(tabId);
      this.networkWaits.invalidateTab(tabId);
      this.navigationWaits.invalidateTab(tabId);
      void this.fileChooserWaits.invalidateTab(tabId).catch(() => {});
      void this.downloadWaits.invalidateTab(tabId).catch(() => {});
      void this.pageWaits.invalidateTab(tabId).catch(() => {});
      void this.directDownloads.invalidateTab(tabId);
      void this.pageExports.invalidateTab(tabId).catch(() => {});
      void this.clipboard.invalidateTab(tabId).catch(() => {});
      this.inputTracker.forget(tabId, this.attachmentEpochs.get(tabId), { destroyed: true });
      this.pauseReleaseFailures.delete(tabId);
      this.automationControl.recoveredPendingTabs?.delete(tabId);
      this.releaseEngineAttachment(tabId);
      const claim = this.auxiliaryTabs.entry(tabId);
      if (claim) void this.releaseAuxiliaryClaim(claim, { destroyed: true }).catch(() => {});
    });
    chrome.tabs?.onUpdated?.addListener((tabId, change) => {
      this.observeCreationChange(tabId, "updated", change);
      if (change.url) {
        void this.fileChooserWaits.invalidateAttachedTab(tabId).catch(() => {});
        this.invalidatePageExportDocument(tabId);
        this.onSiteNavigation({ tabId, frameId: 0, url: change.url }, "updated");
      }
      if (Object.hasOwn(change, "groupId")) this.networkWaits.invalidateTab(tabId);
      if (Object.hasOwn(change, "groupId")) this.navigationWaits.invalidateTab(tabId);
      if (Object.hasOwn(change, "groupId") && !(change.groupId === -1 && this.auxiliaryTabs.owner(tabId)?.kind === "background-window")) {
        this.revokeMovedTab(tabId, change.groupId);
        this.cancelTabTransfers(tabId, new Error("OBU_TRANSFER_CANCELLED: tab ownership changed"));
        void this.directDownloads.invalidateTab(tabId);
        void this.pageExports.invalidateTab(tabId).catch(() => {});
        void this.clipboard.invalidateTab(tabId).catch(() => {});
        this.invalidateAuxiliaryTab(tabId);
      }
      if (change.pinned === true && ["ordinary", "background-window", "created-page"].includes(this.auxiliaryTabs.owner(tabId)?.kind)) this.invalidateAuxiliaryTab(tabId);
    });
    chrome.tabs?.onActivated?.addListener(info => this.observeCreationChange(info.tabId, "activated", info));
    chrome.webNavigation?.onCreatedNavigationTarget?.addListener(details => this.pageWaits.observe(details));
    chrome.tabs?.onMoved?.addListener(tabId => {
      this.observeCreationChange(tabId, "moved");
      const record = this.auxiliaryTabs.owner(tabId);
      if (["ordinary", "background-window", "created-page"].includes(record?.kind)) this.invalidateAuxiliaryTab(tabId);
    });
    chrome.tabs?.onDetached?.addListener(tabId => { this.observeCreationChange(tabId, "detached"); void this.pageWaits.invalidateTab(tabId).catch(() => {}); });
    chrome.tabs?.onReplaced?.addListener((_added, removed) => { this.observeCreationChange(removed, "replaced"); void this.pageWaits.invalidateTab(removed).catch(() => {}); });
    chrome.tabs?.onRemoved?.addListener(tabId => this.observeCreationChange(tabId, "removed"));
    chrome.windows?.onFocusChanged?.addListener(windowId => {
      if (!Number.isSafeInteger(windowId) || windowId < 0) return;
      for (const transaction of this.creationTransactions.values()) {
        if (transaction.record.kind !== "background-window" || (transaction.finished && !transaction.cleanupFailed)) continue;
        if (transaction.createdWindowId === undefined) {
          transaction.focusedWindows ??= new Set();
          if (transaction.focusedWindows.size < 128) transaction.focusedWindows.add(windowId);
          else transaction.invalid = true;
        } else if (transaction.createdWindowId === windowId) transaction.invalid = true;
      }
    });
    chrome.tabs?.onDetached?.addListener(tabId => { this.revokeMovedTab(tabId); this.networkWaits.invalidateTab(tabId); this.navigationWaits.invalidateTab(tabId); this.cancelTabTransfers(tabId, new Error("OBU_TRANSFER_CANCELLED: tab moved")); void this.directDownloads.invalidateTab(tabId); void this.pageExports.invalidateTab(tabId).catch(() => {}); void this.clipboard.invalidateTab(tabId).catch(() => {}); this.invalidateAuxiliaryTab(tabId); });
    chrome.tabs?.onReplaced?.addListener((_added, removed) => { this.revokeMovedTab(removed); this.networkWaits.invalidateTab(removed); this.navigationWaits.invalidateTab(removed); this.cancelTabTransfers(removed, new Error("OBU_TRANSFER_CANCELLED: tab replaced")); void this.directDownloads.invalidateTab(removed); void this.pageExports.invalidateTab(removed).catch(() => {}); void this.clipboard.invalidateTab(removed).catch(() => {}); this.invalidateAuxiliaryTab(removed); });
    for (const [event, phase] of [["onBeforeNavigate", "pending"], ["onCommitted", "committed"], ["onErrorOccurred", "error"], ["onHistoryStateUpdated", "committed"], ["onReferenceFragmentUpdated", "committed"]]) {
      chrome.webNavigation?.[event]?.addListener(details => {
        this.pageWaits.navigation(event, details);
        if (details.frameId === 0) void this.fileChooserWaits.invalidateAttachedTab(details.tabId).catch(() => {});
        this.invalidatePageExportDocument(details.tabId);
        this.onSiteNavigation(details, phase);
      });
    }
    this.controlReady = this.recoverControlState();
    this.controlReady.catch(error => this.automationControl.fail(error));
    for (const method of PUBLIC_BROWSER_METHODS) {
      if (["ping", "getInfo"].includes(method) || typeof this[method] !== "function") continue;
      const original = this[method].bind(this);
      const handler = (...args) => { this.assertSiteMethod(method, args[0]); return original(...args); };
      if (["readClipboardText", "writeClipboardText", "readClipboard", "writeClipboard"].includes(method)) {
        this[method] = async params => {
          const record = this.clipboard.reserve(method, params);
          try { return await this.clipboard.within(record, () => this.runControlledRequest(() => handler(record.params, record))); }
          catch (error) { void this.clipboard.cancel(record, error).catch(() => {}); throw error; }
        };
      } else if (method === "exportPage") {
        this[method] = async params => {
          const record = this.pageExports.reserve(params);
          try { return await this.pageExports.within(record, () => this.runControlledRequest(() => handler(record.params, record))); }
          catch (error) { void this.pageExports.cancel(record, error, false).catch(() => {}); throw error; }
        };
      } else if (method === "downloadMedia") {
        this[method] = async params => {
          const request = validateMediaDownload(params);
          const { locator, ...base } = request;
          const record = this.directDownloads.reserveSource(base);
          try { return await this.directDownloads.within(record, record.deadlineAt, () => this.runControlledRequest(() => handler(request, record))); }
          catch (error) { void this.directDownloads.retire(record).catch(() => {}); throw error; }
        };
      } else if (method === "downloadURL") {
        this[method] = async params => {
          const record = this.directDownloads.reserve(params);
          try { return await this.directDownloads.within(record, record.deadlineAt, () => this.runControlledRequest(() => handler(record.params, record))); }
          catch (error) { void this.directDownloads.retire(record).catch(() => {}); throw error; }
        };
      } else if (["downloadPath", "cancelDownload"].includes(method)) {
        this[method] = params => {
          const deadline = downloadDeadline(params);
          return withTimeout(Math.max(1, deadline - Date.now()), () => this.runControlledRequest(() => handler(params, deadline)),
            () => new Error("OBU_DOWNLOAD_TIMEOUT: download operation deadline expired"));
        };
      } else if (method === "setFileChooserFiles") {
        this[method] = async params => {
          const timeoutMs = params?.timeoutMs === undefined ? 10000 : params.timeoutMs;
          if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
            throw new Error("setFileChooserFiles timeoutMs must be an integer between 1 and 120000");
          const deadlineAt = Date.now() + timeoutMs;
          return withTimeout(timeoutMs, () => this.runControlledRequest(() => handler(params, deadlineAt)),
            () => new Error("OBU_DIRECTORY_UPLOAD_TIMEOUT: original file submission deadline expired; native selection may still complete"));
        };
      } else if (method === "armNavigationWait") {
        this[method] = params => this.startNavigationWait(params);
      } else if (["armFileChooserWait", "waitForFileChooser"].includes(method)) {
        this[method] = params => this.startFileChooserWait(params, { legacy: method === "waitForFileChooser" });
      } else if (["armDownloadWait", "waitForDownload"].includes(method)) {
        this[method] = params => this.startDownloadWait(params, { legacy: method === "waitForDownload" });
      } else if (method === "armPageWait") {
        this[method] = params => this.startPageWait(params);
      } else if (["collectPageWait", "cancelPageWait"].includes(method)) {
        this[method] = params => {
          if (method === "collectPageWait") {
            let record;
            try { record = this.pageWaits.lookup(params); } catch (error) { return Promise.reject(error); }
            return Promise.race([this.runControlledRequest(() => handler(params)), record.cancellation.promise]);
          }
          try { this.pageWaits.validateHandle(params); } catch (error) { return Promise.reject(error); }
          return withTimeout(10000, () => this.runControlledRequest(() => handler(params)),
            () => new Error("OBU_PAGE_WAIT_CLEANUP_TIMEOUT: created-page authorization is still pending"));
        };
      } else if (["collectFileChooserWait", "cancelFileChooserWait", "collectDownloadWait", "cancelDownloadWait"].includes(method)) {
        this[method] = params => {
          const downloads = method === "collectDownloadWait" || method === "cancelDownloadWait";
          const registry = downloads ? this.downloadWaits : this.fileChooserWaits;
          // Validate the finite handle schema before bootstrap/admission too.
          if (method.startsWith("collect")) {
            let record;
            try { record = registry.lookup(params); } catch (error) { return Promise.reject(error); }
            return Promise.race([this.runControlledRequest(() => handler(params)), record.cancellation.promise]);
          }
          try { registry.validateHandle(params); } catch (error) { return Promise.reject(error); }
          return withTimeout(10000, () => this.runControlledRequest(() => handler(params)),
            () => new Error(downloads ? "OBU_DOWNLOAD_WAIT_CLEANUP_TIMEOUT: native download observation setup is still pending" : "OBU_FILE_CHOOSER_CLEANUP_TIMEOUT: original native cleanup is still pending"));
        };
      } else if (["browserAction", "executeCdp", "attach"].includes(method)) {
        this[method] = params => {
          if (method === "browserAction" && ["waitForURL", "waitForLoadState"].includes(params?.action))
            return this.startNavigationWait(params, { direct: true });
          // Capture earlier setups synchronously: a later wait must not hold an
          // already accepted trigger, and a fast trigger cannot overtake setup.
          const setups = this.captureNavigationSetups(params);
          return this.runAfterNavigationSetups(params, setups, handler);
        };
      } else if (method === "claimUserTab") {
        this[method] = async params => {
          const deadlineAt = Date.now() + DEFAULT_CDP_TIMEOUT_MS;
          const reservation = this.auxiliaryTabs.reserve(params);
          let cancelled = false;
          const timeoutError = () => new Error("OBU_AUXILIARY_CLAIM_TIMEOUT: tab claim deadline expired");
          const checkDeadline = () => { if (cancelled || Date.now() >= deadlineAt) throw timeoutError(); };
          try {
            return await withTimeout(Math.max(1, deadlineAt - Date.now()),
              () => this.runControlledRequest(() => handler(params, reservation, checkDeadline)), timeoutError);
          } catch (error) {
            cancelled = true;
            if (this.auxiliaryTabs.owner(reservation.tabId) !== reservation)
              void this.releaseAuxiliaryClaim(reservation).catch(() => {});
            throw error;
          }
        };
      } else if (method === "armNetworkWait") {
        this[method] = async params => {
          // Reserve before controlReady or any other await. Setup and the event
          // consume one deadline; a delayed worker bootstrap cannot extend it.
          const record = this.networkWaits.reserve(params);
          try {
            return await this.networkWaits.within(record, () => this.runControlledRequest(() => handler(record.params, record)));
          } catch (error) {
            this.networkWaits.fail(record, error);
            throw error;
          }
        };
      } else this[method] = (...args) => this.runControlledRequest(() => handler(...args), { bootstrap: method === "getControlState" });
    }
  }

  async runControlledRequest(operation, { bootstrap = false } = {}) {
    await this.controlReady;
    this.automationControl.assertOpen();
    this.siteAccess.assertReady();
    if (!bootstrap) this.assertNativeControl();
    const pending = Promise.resolve().then(() => {
      this.automationControl.assertOpen();
      this.siteAccess.assertReady();
      if (!bootstrap) this.assertNativeControl();
      return operation();
    });
    this.acceptedRequests.add(pending);
    if (bootstrap) this.controlBootstrapRequests.add(pending);
    try { return await pending; }
    finally { this.acceptedRequests.delete(pending); this.controlBootstrapRequests.delete(pending); }
  }

  assertControlOpen() {
    this.automationControl.assertOpen();
    this.browserLifetime.assertInputRecoveryClear();
    this.assertNativeControl();
  }

  assertNativeControl() {
    if (this.nativeRecovery) throw new Error(this.nativeRecovery.error
      ? "OBU_NATIVE_RECOVERY_FAILED: native host control cleanup failed; explicitly begin a new turn to retry cleanup"
      : "OBU_NATIVE_RECOVERY_PENDING: native host control is being released; explicitly begin a new turn after reconnection");
  }

  nativeDisconnected() {
    if (this.nativeRecovery) return this.nativeRecovery.promise;
    return this.startNativeRecovery();
  }

  startNativeRecovery({ retryPageCleanup = false } = {}) {
    const recovery = { error: null, pending: true };
    // This assignment blocks every ordinary admission and CRX command before
    // cancellation, storage, or native cleanup reaches its first await.
    this.nativeRecovery = recovery;
    // Only explicit bootstrap retries a cleanup attempt that actually failed.
    // Restart it before invalidation captures its drain; an in-flight attempt
    // remains unchanged, and no candidate adoption or original action replays.
    const pageCleanup = retryPageCleanup ? this.pageWaits.retryFailedCleanup() : null;
    pageCleanup?.catch(() => {});
    const cancelled = this.cancelGlobalControl(new Error("OBU_NATIVE_CONNECTION_LOST: native host disconnected"));
    if (pageCleanup) cancelled.releases.push(pageCleanup);
    // A bootstrap may itself await this recovery. Its durability writes are
    // joined by invalidateAll below; awaiting its RPC here would self-deadlock.
    cancelled.pending = cancelled.pending.filter(pending => !this.controlBootstrapRequests.has(pending));
    const operation = this.controlReady.then(() => {
      const queued = this.automationTransitions.catch(() => {}).then(() => this.finishNativeRecovery(recovery, cancelled));
      this.automationTransitions = queued;
      return queued;
    });
    recovery.promise = operation;
    operation.then(() => {
      recovery.pending = false;
      if (this.nativeRecovery === recovery) this.nativeRecovery = null;
    }, error => { recovery.pending = false; recovery.error = error; });
    return operation;
  }

  async finishNativeRecovery(recovery, cancelled) {
    await this.controlLedger.invalidateAll("native-host-disconnect");
    const results = await Promise.allSettled([...cancelled.releases, ...cancelled.pending]);
    const failures = results.slice(0, cancelled.releases.length).filter(result => result.status === "rejected");
    if (failures.length) throw new Error(`OBU_NATIVE_RECOVERY_FAILED: ${failures.map(result => String(result.reason?.message ?? result.reason)).join("; ")}`);
    const tabIds = this.globalControlSnapshot().tabIds;
    for (const sessionId of this.controlLedger.records.keys()) {
      for (const tab of await this.getSessionTabs(sessionId, { strict: true })) tabIds.add(tab.id);
    }
    const released = await Promise.allSettled([...tabIds].map(tabId => this.detachTab(tabId)));
    const failed = released.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
    if (this.nativeRecovery !== recovery) throw new Error("OBU_NATIVE_RECOVERY_FAILED: native recovery identity changed");
    for (const sessionId of this.controlLedger.records.keys()) await this.clearSessionActivity(sessionId);
    for (const record of this.controlLedger.records.values()) record.status = "idle";
    await this.controlLedger.save();
  }

  assertAttachmentAdmission(tabId, token = this.attachmentEpochs.get(tabId)) {
    this.assertNativeControl();
    if (this.coldAttachmentResets.has(tabId))
      throw new Error("OBU_TAB_CONTROL_REVOKED: explicit claim is resetting an orphaned native attachment");
    if (token && this.revokedAttachmentTokens.has(token))
      throw new Error("OBU_TAB_CONTROL_REVOKED: tab moved out of its controlled location; wait for release and explicitly claim it again");
  }

  markAttachmentDestroyed(tabId) {
    const token = this.attachmentEpochs.get(tabId);
    if (token) this.destroyedAttachmentTokens.add(token);
    this.inputTracker.forget(tabId, token, { destroyed: true });
  }

  revokeMovedTab(tabId, groupId) {
    const owner = this.attachmentOwners.get(tabId);
    // Group updates which preserve this exact task membership are harmless.
    // A cross-window detach always retires the current native attachment.
    if (groupId !== undefined && owner && this.store.state.sessions[owner.session_id]?.chromeGroupId === groupId) return;
    const token = this.attachmentEpochs.get(tabId);
    if (!token && !this.pendingAttachmentTabs.has(tabId) && !this.browserEngine?.pages?.has(tabId) && !this.browserEngine?.queues?.has(tabId)) return;
    if (token && this.revokedAttachmentTokens.has(token)) return;
    if (token) this.revokedAttachmentTokens.add(token);
    // No await precedes the gate. Cleanup retains the original token and uses
    // private native release, without moving or activating the user's tab.
    void this.detachTab(tabId).catch(error => {
      this.pauseReleaseFailures.set(tabId, error);
      // Auxiliary claims already retain a durable quarantined ownership lock
      // and retry through their existing cleanup path.
      if (!this.auxiliaryTabs.entry(tabId)) void this.pauseAutomation().catch(() => {});
    });
  }

  assertSiteMethod(method, params) {
    this.siteAccess.assertReady();
    if (!this.siteAccess.restricted) return;
    // These channels can expose origins other than the tab's live documents.
    // A URL check around arbitrary CDP/JavaScript is not an origin boundary.
    const unsupported = ["executeCdp", "moveMouse", "webmcp_list_tools", "webmcp_invoke_tool", "readClipboardText", "writeClipboardText", "readClipboard", "writeClipboard", "armNetworkWait", "collectNetworkWait", "cancelNetworkWait", "waitForDownload", "downloadURL", "downloadPath", "cancelDownload", "waitForFileChooser", "setFileChooserFiles", "armFileChooserWait", "collectFileChooserWait", "cancelFileChooserWait", "armDownloadWait", "collectDownloadWait", "cancelDownloadWait"];
    if (method === "downloadMedia" || unsupported.includes(method) || (method === "browserAction" && params?.action === "diagnostics") || (method === "exportPage" && params?.format === "mhtml"))
      throw new Error("OBU_SITE_ACCESS_UNSUPPORTED: this operation is unavailable with website restrictions; use the locator, snapshot and screenshot browser actions");
  }

  async getSiteAccessPolicy() {
    try {
      await withTimeout(this.automationCleanupTimeoutMs, () => this.siteAccess.ready.catch(() => {}),
        () => new Error("OBU_SITE_ACCESS_UNAVAILABLE: website access settings did not finish loading"));
    } catch {
      // Status must remain available even when the native read never settles.
      // A late valid read may still finish normal startup; this response does
      // not pretend the settings were loaded or change the global pause state.
      return { ...this.siteAccess.status(), ready: false,
        error: "OBU_SITE_ACCESS_UNAVAILABLE: website access settings did not finish loading" };
    }
    return this.siteAccess.status();
  }

  setSiteAccessPolicy(config, expectedRevision) {
    const deadlineAt = Date.now() + this.automationCleanupTimeoutMs;
    const timeout = () => new Error("OBU_SITE_ACCESS_UNAVAILABLE: website policy change is unconfirmed; automation remains paused");
    const normalized = normalizeSiteAccessPolicy(config);
    if (this.sitePolicyUpdate) throw new Error("OBU_SITE_ACCESS_BUSY: a website policy change is already pending");
    const token = {};
    this.sitePolicyUpdate = token;
    // Pause fences input synchronously and drains native work before a policy
    // can be replaced. Saving never resumes or replays the retired tasks.
    const paused = this.pauseAutomation();
    const operation = (async () => {
      try {
        await paused;
        if (Date.now() >= deadlineAt) throw timeout();
        return await this.siteAccess.replace(normalized, expectedRevision);
      } finally {
        if (this.sitePolicyUpdate === token) this.sitePolicyUpdate = null;
      }
    })();
    // Keep the real operation/token alive after an outer deadline. Storage
    // writes cannot be canceled; Resume stays fenced until its actual result.
    return withTimeout(Math.max(1, deadlineAt - Date.now()), () => operation, timeout);
  }

  onSiteNavigation(details, phase) {
    const { tabId, frameId, url } = details;
    if (!this.siteAccess.restricted || !Number.isInteger(tabId) || tabId < 0) return;
    // Track only tabs this backend controls; user browsing never grows a ledger.
    if (!this.attachedTabs.has(tabId) && !this.pendingAttachmentTabs.has(tabId) && !this.siteRevokedTabs.has(tabId)) return;
    this.siteNavigationVersions.set(tabId, (this.siteNavigationVersions.get(tabId) ?? 0) + 1);
    const pending = this.sitePendingFrames.get(tabId) ?? new Map();
    if (frameId === 0 && phase === "committed") pending.clear();
    if (phase === "pending" && pending.size >= 1000 && !pending.has(frameId)) { this.revokeSiteTab(tabId); return; }
    if (phase === "pending") pending.set(frameId, url);
    else if (phase !== "updated") pending.delete(frameId);
    if (pending.size) this.sitePendingFrames.set(tabId, pending);
    else this.sitePendingFrames.delete(tabId);
    const inherited = frameId !== 0 && ["about:blank", "about:srcdoc"].includes(url);
    // A newly created blank tab may bootstrap goto. A running document that
    // navigates to blank is different: opener/page scripts may populate it.
    if (phase === "error" || (!inherited && !this.siteAccess.allowsUrl(url))) this.revokeSiteTab(tabId);
  }

  revokeSiteTab(tabId) {
    if (!this.attachedTabs.has(tabId) && !this.pendingAttachmentTabs.has(tabId) && !this.browserEngine?.pages?.has(tabId) && !this.browserEngine?.queues?.has(tabId)) return;
    if (this.siteRevokedTabs.has(tabId)) return;
    this.siteRevokedTabs.add(tabId);
    this.networkWaits.invalidateTab(tabId);
    this.navigationWaits.invalidateTab(tabId);
    this.cancelTabTransfers(tabId, new Error("OBU_SITE_ACCESS_DENIED: document access was revoked"));
    void this.detachTab(tabId).catch(error => {
      this.pauseReleaseFailures.set(tabId, error);
      void this.pauseAutomation().catch(() => {});
    });
  }

  async assertSiteTab(tabId, { recover = false, allowBlank = false } = {}) {
    this.siteAccess.assertReady();
    if (!this.siteAccess.restricted) return;
    if (!recover && this.siteRevokedTabs.has(tabId)) throw new Error("OBU_SITE_ACCESS_DENIED: document access was revoked");
    const revision = this.siteAccess.status().revision;
    const version = this.siteNavigationVersions.get(tabId) ?? 0;
    for (const [frameId, url] of this.sitePendingFrames.get(tabId) ?? []) {
      if (frameId !== 0 && ["about:blank", "about:srcdoc"].includes(url)) continue;
      this.siteAccess.assertUrl(url, { allowBlank: frameId === 0 && allowBlank });
    }
    try {
      const [tab, frames] = await withTimeout(1000, () => Promise.all([
        chrome.tabs.get(tabId), chrome.webNavigation.getAllFrames({ tabId })
      ]), () => new Error("OBU_SITE_ACCESS_UNVERIFIED: document inspection timed out"));
      assertSiteAccessFrames(this.siteAccess, tab, frames);
      if (!allowBlank && tab.url === "about:blank") throw new Error("OBU_SITE_ACCESS_UNVERIFIED: blank documents are available only for navigation to an allowed website");
      this.siteAccess.assertReady();
      if (revision !== this.siteAccess.status().revision || version !== (this.siteNavigationVersions.get(tabId) ?? 0))
        throw new Error("OBU_SITE_ACCESS_UNVERIFIED: documents changed during permission inspection");
      if (recover) this.siteRevokedTabs.delete(tabId);
      return { tabId, revision, version, documentId: frames.find(frame => frame.frameId === 0)?.documentId };
    } catch (error) {
      this.revokeSiteTab(tabId);
      if (/^OBU_SITE_ACCESS_/.test(error?.message)) throw error;
      throw new Error("OBU_SITE_ACCESS_UNVERIFIED: live documents could not be inspected");
    }
  }

  assertSiteProof(proof) {
    this.siteAccess.assertReady();
    if (!proof && !this.siteAccess.restricted) return;
    if (!proof || this.siteRevokedTabs.has(proof.tabId) || proof.revision !== this.siteAccess.status().revision || proof.version !== (this.siteNavigationVersions.get(proof.tabId) ?? 0))
      throw new Error("OBU_SITE_ACCESS_UNVERIFIED: document permission changed before the browser command");
  }

  async getAutomationControlStatus() {
    // A timed-out storage read must not make the failed Pause response wait on
    // that same unresolved read a second time merely to display its status.
    if (this.automationControl.state !== "error") {
      try { await this.automationDeadline().within(() => this.automationControl.ready); }
      catch (error) { this.automationControl.fail(error); }
    }
    const status = this.automationControl.status();
    const inputRecovery = status.inputBlocked ? this.browserLifetime.inputRecoveryGuidance() : null;
    return inputRecovery ? { ...status, inputRecovery } : status;
  }

  automationDeadline() {
    const at = Date.now() + this.automationCleanupTimeoutMs;
    const error = new Error("OBU_AUTOMATION_CLEANUP_TIMEOUT: browser cleanup is unconfirmed; automation remains paused");
    return { at, error, within: operation => {
      const remaining = at - Date.now();
      return remaining <= 0 ? Promise.reject(error) : withTimeout(remaining, operation, () => error);
    } };
  }

  globalControlSnapshot() {
    const engine = this.browserEngine?.controlSnapshot?.() ?? { tabIds: [...this.browserEngine?.pages?.keys?.() ?? [], ...this.browserEngine?.queues?.keys?.() ?? [], ...this.browserEngine?.releases?.keys?.() ?? []], pending: [] };
    const input = this.inputTracker.controlSnapshot();
    const network = this.networkWaits.controlSnapshot();
    const navigation = this.navigationWaits.controlSnapshot();
    const chooser = this.fileChooserWaits.controlSnapshot();
    const downloadWaits = this.downloadWaits.controlSnapshot();
    const pages = this.pageWaits.controlSnapshot();
    const auxiliary = this.auxiliaryTabs.controlSnapshot();
    const downloads = this.directDownloads.controlSnapshot();
    const exports = this.pageExports.controlSnapshot();
    const clipboard = this.clipboard.controlSnapshot();
    const broker = this.clipboardBroker.controlSnapshot();
    const lifetime = this.browserLifetime.controlSnapshot();
    // Readiness reservations may precede ownership validation. Only admitted
    // chooser scopes, not the raw setup/waiter IDs, confer detach authority.
    const tabIds = new Set([...this.attachedTabs, ...this.pendingAttachmentTabs, ...this.controlReleases.keys(), ...this.attachmentOwners.keys(), ...this.cursorByTabId.keys(), ...this.pointerFeedbackByTabId.keys(), ...engine.tabIds, ...input.tabIds, ...network.tabIds, ...navigation.tabIds, ...chooser.tabIds, ...auxiliary.tabIds, ...downloads.tabIds, ...exports.tabIds, ...clipboard.tabIds, ...broker.tabIds]);
    for (const tabId of [...downloadWaits.tabIds, ...pages.tabIds]) tabIds.add(tabId);
    for (const tabId of this.directoryUploads.tabIds()) tabIds.add(tabId);
    return { tabIds, pending: [...this.acceptedRequests, ...this.controlReleases.values(), ...this.auxiliaryReleases.values(), ...this.navigationSetups.values(), ...new Set([...this.renderingQueues.values(), ...this.renderingDrains]), ...engine.pending, ...input.pending, ...network.pending, ...navigation.pending, ...chooser.pending, ...downloadWaits.pending, ...pages.pending, ...auxiliary.pending, ...downloads.pending, ...exports.pending, ...clipboard.pending, ...broker.pending, ...lifetime.pending, ...[...this.sessionMutations.values()].flatMap(values => [...values])] };
  }

  cancelGlobalControl(error = new Error("OBU_AUTOMATION_PAUSED: browser automation was paused by the user")) {
    for (const marker of this.freshBlankTabs.values()) this.retireFreshBlankTab(marker);
    const snapshot = this.globalControlSnapshot();
    this.networkWaits.invalidateAll();
    this.navigationWaits.invalidateAll();
    this.directoryUploads.cancelWhere(() => true, error);
    this.auxiliaryTabs.cancelPending();
    for (const setup of this.fileChooserSetupsByTabId.values()) setup.reject(error);
    for (const resolve of this.cursorArrivalWaitersByKey.values()) resolve();
    this.cursorArrivalWaitersByKey.clear();
    this.cursorByTabId.clear();
    for (const tabId of snapshot.tabIds) void this.publishCursorState(tabId).catch(() => {});
    const releases = [this.fileChooserWaits.invalidateAll(error), this.downloadWaits.invalidateAll(error), this.pageWaits.invalidateAll(error), this.directDownloads.invalidateAll(), this.pageExports.invalidateAll(), this.clipboard.invalidateAll(), ...[...snapshot.tabIds].map(tabId => {
      this.cancelTabTransfers(tabId, error);
      return this.detachTab(tabId).then(() => this.pauseReleaseFailures.delete(tabId), failure => { this.pauseReleaseFailures.set(tabId, failure); throw failure; });
    })];
    releases.forEach(release => release.catch(() => {}));
    for (const record of this.auxiliaryTabs.entries()) {
      if (record.phase !== "committed") {
        const release = this.releaseAuxiliaryClaim(record);
        release.catch(() => {});
        releases.push(release);
      }
    }
    return { tabIds: snapshot.tabIds, pending: snapshot.pending, releases };
  }

  pauseAutomation() {
    const deadline = this.automationDeadline();
    this.automationControl.block();
    // Cancel known engine work synchronously, before a slow storage write can
    // allow an already-running locator wait to deliver its first input.
    const cancelled = this.cancelGlobalControl();
    const operation = this.automationTransitions.catch(() => {}).then(() => this.finishAutomationPause(cancelled, deadline));
    this.automationTransitions = operation;
    return deadline.within(() => operation).catch(error => {
      if (error !== deadline.error) throw error;
      const failure = new Error(`OBU_AUTOMATION_PAUSE_FAILED: ${error.message}`);
      this.automationControl.fail(failure);
      throw failure;
    });
  }

  async finishAutomationPause(cancelled = this.cancelGlobalControl(), deadline = this.automationDeadline()) {
    const gate = this.automationControl;
    const errors = [];
    const within = deadline.within;
    const fail = () => {
      const error = new Error(`OBU_AUTOMATION_PAUSE_FAILED: ${errors.map(error => String(error?.message ?? error)).join("; ")}`);
      gate.fail(error);
      throw error;
    };
    try {
      await within(() => Promise.all([gate.ready, this.store.ready, this.controlLedger.ready, this.auxiliaryTabs.ready]));
      if (gate.revision >= Number.MAX_SAFE_INTEGER) throw new Error("OBU_AUTOMATION_REVISION_EXHAUSTED: user control revision cannot wrap");
      gate.revision++;
      gate.state = "pausing";
      gate.cleanupComplete = false;
      gate.error = undefined;
      for (const tabId of [...cancelled.tabIds, ...this.globalControlSnapshot().tabIds]) gate.pendingTabIds.add(tabId);
      await within(() => gate.persist(true));
      await within(() => this.controlLedger.invalidateAll());
    } catch (error) { errors.push(error); }
    // Explicit Pause/Retry may reconcile only the original broker document.
    // This never replays a clipboard read/write or creates a replacement for
    // an uncertain native operation, and may unblock the captured drain below.
    try { await within(() => this.clipboardBroker.retryCleanup()); }
    catch (error) { errors.push(error); }
    try { await within(() => this.browserLifetime.ready); this.browserLifetime.assertInputRecoveryClear(); }
    catch (error) { errors.push(error); return fail(); }
    let outcomes;
    try { outcomes = await within(() => Promise.allSettled([...cancelled.releases, ...cancelled.pending])); }
    catch (error) { errors.push(error); return fail(); }
    // Cancelled requests are expected to reject. Only release failures matter.
    for (const result of outcomes.slice(0, cancelled.releases.length)) if (result.status === "rejected") errors.push(result.reason);
    const tabIds = this.globalControlSnapshot().tabIds;
    for (const sessionId of this.controlLedger.records.keys()) {
      try { for (const tab of await within(() => this.getSessionTabs(sessionId, { strict: true }))) tabIds.add(tab.id); }
      catch (error) { errors.push(error); }
    }
    for (const tabId of this.pauseReleaseFailures.keys()) tabIds.add(tabId);
    let released;
    try { released = await within(() => Promise.allSettled([...tabIds].map(tabId => this.detachTab(tabId)))); }
    catch (error) { errors.push(error); return fail(); }
    for (const result of released) if (result.status === "rejected") errors.push(result.reason);
    try {
      for (const sessionId of this.controlLedger.records.keys()) await within(() => this.clearSessionActivity(sessionId));
      if (!errors.length) {
        for (const record of this.controlLedger.records.values()) record.status = "idle";
        await within(() => this.controlLedger.save());
        gate.pendingTabIds.clear();
        await within(() => gate.persist(true));
      }
    } catch (error) { errors.push(error); }
    if (errors.length) {
      return fail();
    }
    this.pauseReleaseFailures.clear();
    gate.state = "paused";
    gate.cleanupComplete = true;
    return gate.status();
  }

  resumeAutomation(expectedRevision) {
    const deadline = this.automationDeadline();
    const gate = this.automationControl;
    let failed = false;
    const failResume = error => {
      if (failed) return;
      failed = true;
      gate.block();
      gate.fail(error);
      // The native storage write may outlive its deadline. Serialize a paused
      // repair after it; do not wait for that uncertain write to report Failed.
      void gate.persist(true).catch(error => gate.fail(error));
    };
    const operation = this.automationTransitions.catch(() => {}).then(async () => {
      await deadline.within(() => gate.ready);
      this.siteAccess.assertReady();
      if (this.sitePolicyUpdate) throw new Error("OBU_SITE_ACCESS_BUSY: wait for the website policy change before resuming");
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== gate.revision) throw new Error("OBU_CONTROL_REVISION_CONFLICT: refresh user control status before resuming");
      if (gate.state !== "paused" || !gate.cleanupComplete) throw new Error("OBU_AUTOMATION_PAUSE_INCOMPLETE: retry Pause until browser control is fully released");
      if (gate.revision >= Number.MAX_SAFE_INTEGER) throw new Error("OBU_AUTOMATION_REVISION_EXHAUSTED: user control revision cannot wrap");
      gate.revision++;
      const pauseSequence = gate.pauseSequence;
      try {
        await deadline.within(() => this.controlLedger.writes);
        await deadline.within(() => gate.persist(false));
      } catch (error) { failResume(error); throw error; }
      if (gate.pauseSequence !== pauseSequence) {
        void gate.persist(true).catch(error => gate.fail(error));
        throw new Error("OBU_AUTOMATION_PAUSED: a newer Pause request superseded Resume");
      }
      if (failed || Date.now() >= deadline.at) { failResume(deadline.error); throw deadline.error; }
      gate.requestedPause = false;
      gate.inputBlocked = false;
      gate.cleanupComplete = false;
      gate.state = "running";
      gate.error = undefined;
      return gate.status();
    });
    this.automationTransitions = operation;
    return deadline.within(() => operation).catch(error => {
      if (error === deadline.error) failResume(error);
      throw error;
    });
  }

  ping() {
    return "pong";
  }

  async getInfo() {
    const extensionInstanceId = await getExtensionInstanceId();
    const webMcpEnabled = (await this.webMcpGate?.enabled?.()) === true;
    return {
      name: "Open Browser Use Chrome",
      version: chrome.runtime.getManifest().version,
      type: "extension",
      capabilities: {
        tab: webMcpEnabled ? [WEBMCP_CAPABILITY] : []
      },
      metadata: {
        extensionId: chrome.runtime.id,
        extensionInstanceId,
        nativeHostName: NATIVE_HOST_NAME,
        browserActionProtocolVersion: 1,
        turnLifecycleVersion: 1,
        networkWaitVersion: 1,
        navigationWaitVersion: 1,
        fileChooserWaitVersion: 1,
        fileChooserDirectoryVersion: 1,
        backgroundWindowVersion: 1,
        downloadWaitVersion: 1,
        pageWaitVersion: 1,
        auxiliaryTabsVersion: 1,
        directDownloadsVersion: 1,
        pageDownloads: this.nativePageDownloads?.()?.status() ?? { version: 1, available: false, reason: "Browser connection is not bound" },
        pageExportVersion: 1,
        clipboardVersion: 1,
        mediaDownloadsVersion: 1,
        siteAccess: { version: 1, mode: this.siteAccess.status().mode, restricted: this.siteAccess.restricted, ready: this.siteAccess.status().ready },
        automationControl: await this.getAutomationControlStatus()
      }
    };
  }

  async createTab(params) {
    if (params?.backgroundWindow !== undefined && typeof params.backgroundWindow !== "boolean")
      throw new Error("createTab backgroundWindow must be a boolean");
    return this.admitSessionMembership(params?.session_id, () => this.createTabTransaction(params));
  }

  async createTabTransaction(params) {
    let transaction;
    try {
      const result = await this.runSessionMutation(params, async () => {
        await this.auxiliaryTabs.ready;
        await this.requireSession(params);
        const record = this.auxiliaryTabs.reserveCreation({ ...params, controlRevision: this.automationControl.revision },
          { kind: params.backgroundWindow === true ? "background-window" : "ordinary" });
        let resolve;
        transaction = { record, events: [], invalid: false, destroyed: false, finished: false,
          ...(record.kind === "background-window" ? { groupId: -1 } : {}), done: new Promise(done => { resolve = done; }), resolve };
        this.creationTransactions.set(record, transaction);
        return this.createTabInTurn(params, transaction);
      }, async () => {
        if (transaction) try { await this.cleanupCreatedTab(transaction); }
        catch (error) {
          transaction.cleanupFailed = true;
          transaction.nativeGroupPending = false;
          transaction.allowSingletonLoss = false;
          throw error;
        }
      });
      transaction.admitted = true;
      return result;
    } finally {
      if (transaction) {
        transaction.finished = true;
        if (!transaction.cleanupFailed) this.creationTransactions.delete(transaction.record);
        this.auxiliaryTabs.retireCreation(transaction.record);
        transaction.resolve();
      }
    }
  }

  async admitSessionMembership(sessionId, operation) {
    const previous = this.membershipAdmissions.get(sessionId) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    this.membershipAdmissions.set(sessionId, pending);
    try { return await pending; }
    finally { if (this.membershipAdmissions.get(sessionId) === pending) this.membershipAdmissions.delete(sessionId); }
  }

  observeCreationChange(tabId, kind, change = {}) {
    const marker = this.freshBlankTabs.get(tabId);
    if (marker?.transaction.finished && this.consumeCreatedWindowActivation(marker.transaction, kind, change)) return;
    if (marker?.transaction.finished && (kind !== "updated" || change.pinned === true ||
        (change.url && change.url !== "about:blank") ||
        (Object.hasOwn(change, "groupId") && change.groupId !== marker.groupId))) this.retireFreshBlankTab(marker);
    for (const transaction of this.creationTransactions.values()) {
      if (transaction.finished && !transaction.cleanupFailed) continue;
      if (transaction.record.tabId === null) {
        if (transaction.events.length < 128) transaction.events.push({ tabId, kind, change });
        else transaction.invalid = true;
      } else if (transaction.record.tabId === tabId) this.applyCreationChange(transaction, kind, change);
    }
  }

  applyCreationChange(transaction, kind, change) {
    if (this.consumeCreatedWindowActivation(transaction, kind, change)) return;
    if (kind === "removed") { transaction.destroyed = true; transaction.invalid = true; return; }
    if (["detached", "replaced"].includes(kind) || kind === "activated" ||
        (kind === "moved" && !transaction.nativeGroupPending) ||
        (kind === "updated" && (change.pinned === true || (change.url && change.url !== "about:blank")))) transaction.invalid = true;
    if (kind === "updated" && Object.hasOwn(change, "groupId")) {
      if (transaction.nativeGroupPending) {
        transaction.groupEvents ??= [];
        if (transaction.groupEvents.length < 16) transaction.groupEvents.push(change.groupId);
        else transaction.invalid = true;
      } else if (change.groupId === transaction.groupId && !transaction.groupLost) {
        // The event for our exact native group may arrive after its ACK.
      } else if (change.groupId === -1 && transaction.allowSingletonLoss && Number.isSafeInteger(transaction.groupId) && !transaction.groupLost) {
        transaction.groupLost = true;
      } else transaction.invalid = true;
    }
  }

  consumeCreatedWindowActivation(transaction, kind, change) {
    if (transaction.record.kind !== "background-window" || transaction.initialActivationSeen || kind !== "activated" ||
        transaction.createdWindowId !== change.windowId || transaction.initialTab?.active !== true ||
        transaction.record.tabId !== change.tabId || transaction.cleanupFailed) return false;
    transaction.initialActivationSeen = true;
    return true;
  }

  async validateCreatedTab(transaction) {
    const tab = await chrome.tabs.get(transaction.record.tabId);
    const ownWindow = transaction.createdWindowId === tab.windowId;
    if (transaction.invalid || tab.windowId !== transaction.record.windowId || tab.pinned || (!ownWindow && tab.active) ||
        (tab.url && tab.url !== "about:blank") || (tab.pendingUrl && tab.pendingUrl !== "about:blank"))
      throw new Error(`OBU_TAB_CREATION_REVOKED: new tab ${transaction.record.tabId} changed before admission`);
    if (ownWindow) {
      const window = await chrome.windows.get(tab.windowId);
      if (window.focused || (transaction.record.kind === "background-window" && window.focused !== false))
        throw new Error(`OBU_TAB_CREATION_REVOKED: new window ${tab.windowId} became focused before admission`);
      if (transaction.record.kind === "background-window") {
        const members = await chrome.tabs.query({ windowId: tab.windowId });
        if (window.type !== "normal" || tab.active !== true || tab.groupId !== -1 || members.length !== 1 || members[0].id !== tab.id || transaction.invalid)
          throw new Error(`OBU_TAB_CREATION_REVOKED: new background window ${tab.windowId} changed before admission`);
      }
    }
    return tab;
  }

  async cleanupCreatedTab(transaction) {
    this.retireFreshBlankTab(transaction.freshBlank);
    const record = transaction.record;
    if (record.tabId === null) return;
    transaction.excludedGroupId = undefined;
    transaction.excludeBackground = false;
    const preserve = async () => {
      if (record.kind === "background-window") {
        // Creation can lose authority before publishing its reply. Preserve
        // the same denial as an admitted page that the user subsequently moves.
        transaction.excludeBackground = true;
        return false;
      }
      const state = this.store.state.sessions[record.session_id];
      // A failed page inside a pre-existing task group needs an individual
      // denial; removing its temporary lock would silently admit it by group.
      if (Number.isSafeInteger(transaction.groupId) && transaction.createdGroupId === undefined && state?.chromeGroupId === transaction.groupId) {
        let tab;
        try { tab = await chrome.tabs.get(record.tabId); }
        catch (error) { if (/No tab with (given )?id|Invalid tab id/i.test(String(error?.message))) return; throw error; }
        if (tab.windowId === record.windowId && tab.groupId === transaction.groupId) {
          transaction.excludedGroupId = transaction.groupId;
          return false;
        }
      }
    };
    const cleanup = async () => {
      const owner = this.attachmentOwners.get(record.tabId);
      if (!owner || owner.session_id === record.session_id) await this.detachTab(record.tabId);
      if (transaction.destroyed) return;
      if (transaction.invalid) return preserve();
      let tab;
      try { tab = await this.validateCreatedTab(transaction); }
      catch (error) {
        if (/No tab with (given )?id|Invalid tab id/i.test(String(error?.message))) return;
        if (transaction.invalid || String(error?.message).startsWith("OBU_TAB_CREATION_REVOKED")) return preserve();
        throw error;
      }
      if (tab.groupId !== -1 && tab.groupId !== transaction.groupId) return preserve();
      if (owner && owner.session_id !== record.session_id) return preserve();
      await chrome.tabs.remove(record.tabId);
    };
    try {
      if (this.auxiliaryTabs.entry(record.tabId) === record) await this.auxiliaryTabs.remove(record, { cleanup, releaseExcluded: true });
      else await cleanup();
      if (Number.isSafeInteger(transaction.excludedGroupId) && this.auxiliaryTabs.entry(record.tabId) === record)
        await this.auxiliaryTabs.exclude(record, transaction.excludedGroupId);
      if (transaction.excludeBackground && this.auxiliaryTabs.entry(record.tabId) === record)
        await this.auxiliaryTabs.excludeBackground(record);
    } finally {
      // Admissions are still serialized here. Forget only this transaction's
      // newly created visual group, including a group whose tab was preserved
      // after takeover; otherwise group enumeration would re-grant authority.
      // Apply the in-memory compensation once even if its durable write fails.
      if (!transaction.membershipCompensated) {
        transaction.membershipCompensated = true;
        const state = this.store.state.sessions[record.session_id];
        if (state) {
          if (Number.isSafeInteger(transaction.createdGroupId) && state.chromeGroupId === transaction.createdGroupId) state.chromeGroupId = null;
          if (state.tabOrigins[String(record.tabId)] === "agent") delete state.tabOrigins[String(record.tabId)];
          if (state.activeTabId === record.tabId) state.activeTabId = null;
          if (this.activeTabsBySession.get(record.session_id) === record.tabId) this.activeTabsBySession.delete(record.session_id);
          transaction.membershipWrite = this.store.save();
          await transaction.membershipWrite;
        }
      } else if (transaction.membershipWrite) {
        try { await transaction.membershipWrite; }
        catch { transaction.membershipWrite = this.store.save(); await transaction.membershipWrite; }
      }
    }
  }

  async commitUngroupedTab(record, session, windowId, check) {
    const validate = async () => {
      const tab = await chrome.tabs.get(record.tabId);
      check();
      assertControllableTab(tab);
      if (tab.windowId !== windowId || tab.groupId !== -1 || tab.pinned)
        throw new Error("OBU_AUXILIARY_CLAIM_CANCELLED: ordinary tab moved before admission");
    };
    await this.auxiliaryTabs.commit(record, { windowId, kind: "ordinary", check, validate });
    check();
    session.ungrouped = true;
    session.chromeGroupId = null;
    session.tabOrigins[String(record.tabId)] = record.origin;
    await this.store.save();
    check();
  }

  async commitBackgroundWindowTab(record, session, check) {
    const validate = async () => {
      const tab = await chrome.tabs.get(record.tabId);
      check();
      assertControllableTab(tab);
      const window = await chrome.windows.get(record.windowId);
      check();
      if (tab.windowId !== record.windowId || window.type !== "normal" || tab.groupId !== -1 || tab.pinned)
        throw new Error("OBU_AUXILIARY_CLAIM_CANCELLED: background window tab moved before admission");
    };
    await this.auxiliaryTabs.commit(record, { windowId: record.windowId, kind: "background-window", check, validate });
    check();
    session.tabOrigins[String(record.tabId)] = "agent";
    await this.store.save();
    check();
  }

  async singletonGroupDisappeared(groupId, tabId, windowId) {
    if (!Number.isSafeInteger(groupId)) return false;
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId !== -1 || tab.windowId !== windowId || tab.pinned) return false;
    try { await chrome.tabGroups.get(groupId); return false; }
    catch (error) { if (/No group with id|Invalid group id/i.test(String(error?.message))) return true; throw error; }
  }

  async createTabInTurn(params, transaction) {
    const session = await this.requireSession(params);
    const state = await this.store.getSession(session.sessionId), record = transaction.record;
    const creationEpoch = this.controlLedger.assertCurrent(params).epoch;
    const check = () => {
      this.assertControlOpen();
      this.controlLedger.assertCurrent(params);
      if (this.automationControl.revision !== record.controlRevision) throw new Error("OBU_TAB_CREATION_REVOKED: browser control changed");
      this.auxiliaryTabs.check(record);
      if (transaction.invalid) throw new Error("OBU_TAB_CREATION_REVOKED: new page changed before admission");
    };
    check();
    const chromeTab = await createBackgroundTab(check, windowId => {
      transaction.createdWindowId = windowId;
      if (transaction.focusedWindows?.has(windowId)) transaction.invalid = true;
    }, record.kind === "background-window");
    transaction.initialTab = chromeTab;
    const binding = this.auxiliaryTabs.bindCreated(record, chromeTab);
    // Publish before ownership becomes enumerable, but admit only after the
    // outer mutation has also passed its final control-epoch check.
    let retire;
    transaction.freshBlank = { tabId: chromeTab.id, windowId: chromeTab.windowId,
      session_id: params.session_id, turn_id: params.turn_id, control_epoch: creationEpoch,
      revision: record.controlRevision, ownWindow: transaction.createdWindowId === chromeTab.windowId,
      transaction, retired: new Promise(resolve => { retire = resolve; }), retire };
    this.freshBlankTabs.set(chromeTab.id, transaction.freshBlank);
    // Native creation events may precede its Promise result. Match only the
    // returned ID; never infer a created tab from URL or event arrival order.
    for (const event of transaction.events) if (event.tabId === chromeTab.id) {
      if (record.kind !== "background-window" && event.kind === "activated" && transaction.createdWindowId === chromeTab.windowId && chromeTab.active) continue;
      this.applyCreationChange(transaction, event.kind, event.change);
    }
    transaction.events = [];
    try { await binding; } catch (error) { check(); throw error; }
    check();
    await this.validateCreatedTab(transaction);
    if (record.kind === "background-window") {
      transaction.groupId = -1;
      await this.commitBackgroundWindowTab(record, state, check);
      await this.validateCreatedTab(transaction);
      check();
    } else if (state.ungrouped === true || this.auxiliaryTabs.list(session.sessionId).some(value => value.kind === "ordinary"))
      await this.commitUngroupedTab(record, state, chromeTab.windowId, check);
    else {
      let groupingError;
      try { await this.ensureSessionGroup(session.sessionId, chromeTab.id, "agent", check, {
        before: options => {
          transaction.nativeGroupPending = true;
          transaction.creatingGroup = options.groupId === undefined;
          transaction.allowSingletonLoss = transaction.creatingGroup;
          transaction.groupEvents = [];
        },
        after: groupId => {
          // Capture the actual ACK before the cancellation guard can throw.
          transaction.nativeGroupPending = false; transaction.groupId = groupId;
          if (transaction.creatingGroup) transaction.createdGroupId = groupId;
          for (const id of transaction.groupEvents) this.applyCreationChange(transaction, "updated", { groupId: id });
          transaction.groupEvents = [];
        },
        failed: () => { transaction.nativeGroupPending = false; if (transaction.groupEvents?.length) transaction.invalid = true; }
      }); }
      catch (error) { groupingError = error; }
      check();
      if (groupingError && !/No group with id|Invalid group id/i.test(String(groupingError?.message))) throw groupingError;
      await this.validateCreatedTab(transaction);
      const disappeared = transaction.createdGroupId === transaction.groupId && await this.singletonGroupDisappeared(transaction.groupId, chromeTab.id, chromeTab.windowId);
      check();
      if (disappeared) await this.commitUngroupedTab(record, state, chromeTab.windowId, check);
      else if (groupingError) throw groupingError;
      else {
        const live = await this.validateCreatedTab(transaction);
        check();
        if (live.groupId !== transaction.groupId) {
          transaction.invalid = true;
          throw new Error("OBU_TAB_CREATION_REVOKED: new page left its expected group before admission");
        }
      }
    }
    await this.setSessionActiveTab(session.sessionId, chromeTab.id, check);
    check();
    transaction.freshBlank.groupId = record.kind === "background-window" || state.ungrouped === true ? -1 : transaction.groupId;
    if (record.kind !== "background-window" && state.ungrouped !== true) await this.auxiliaryTabs.remove(record);
    return { ...toBrowserTab(chromeTab), active: true };
  }

  async getTabs(params) {
    return this.runSessionMutation(params, () => this.getTabsInTurn(params));
  }

  async getTabsInTurn(params) {
    const session = await this.requireSession(params);
    const tabs = await this.getSessionTabs(session.sessionId);
    return await this.withLogicalActive(session.sessionId, tabs.filter(tab => this.siteAccess.allowsUrl(tab.url, { allowBlank: true }) && (!tab.pendingUrl || this.siteAccess.allowsUrl(tab.pendingUrl, { allowBlank: true }))).map(toBrowserTab));
  }

  async getUserTabs(params) {
    await this.requireSession(params);
    const tabs = (await chrome.tabs.query({}))
      .filter(hasTabId)
      .filter(tab => this.siteAccess.allowsUrl(tab.url) && (!tab.pendingUrl || this.siteAccess.allowsUrl(tab.pendingUrl)))
      .sort(compareLastAccessed)
      .slice(0, MAX_USER_TABS);
    const groupTitles = await readGroupTitles(tabs);
    return tabs.map((tab) => toUserTab(tab, groupTitles));
  }

  /**
   * Search retained history for one or more terms.
   * Merges matches by URL (newest visit wins) and applies a single limit.
   */
  async getUserHistory(params) {
    await this.requireSession(params);
    if (params.queries == null && params.query != null && typeof params.query !== "string") {
      throw new Error("getUserHistory requires query to be a string");
    }
    const queries = params.queries ?? [params.query ?? ""];
    if (!Array.isArray(queries) || queries.length === 0) {
      throw new Error("getUserHistory requires queries to be a non-empty array of strings");
    }
    for (const query of queries) {
      if (typeof query !== "string") {
        throw new Error("getUserHistory requires queries to be a non-empty array of strings");
      }
    }
    const maxResults = optionalPositiveInteger(params.limit ?? undefined, 100, "getUserHistory limit");
    // Chrome searches only the last 24 hours when startTime is omitted.
    const search = { maxResults, startTime: 0 };
    for (const [field, key] of [["from", "startTime"], ["to", "endTime"]]) {
      if (params[field] == null) continue;
      if (typeof params[field] !== "string") {
        throw new Error(`getUserHistory requires ${field} to be a valid date`);
      }
      search[key] = parseDate(params[field], field);
    }
    if (search.endTime !== undefined && search.endTime < search.startTime) {
      throw new Error("getUserHistory requires to >= from");
    }
    const batches = await Promise.all(
      [...new Set(queries)].map((text) => chrome.history.search({ ...search, text }))
    );
    const seenUrls = new Set();
    return batches
      .flat()
      .filter((item) =>
        typeof item?.url === "string" &&
        this.siteAccess.allowsUrl(item.url) &&
        typeof item.lastVisitTime === "number" &&
        Number.isFinite(new Date(item.lastVisitTime).getTime())
      )
      .sort((left, right) => right.lastVisitTime - left.lastVisitTime)
      .filter(({ url }) => {
        if (seenUrls.has(url)) return false;
        seenUrls.add(url);
        return true;
      })
      .slice(0, maxResults)
      .map((item) => ({
        url: item.url,
        ...(item.title ? { title: item.title } : {}),
        dateVisited: new Date(item.lastVisitTime).toISOString()
      }));
  }

  async claimUserTab(params, reservation, checkDeadline) {
    checkDeadline();
    reservation = this.auxiliaryTabs.check(reservation);
    return this.runSessionMutation(params, () => this.admitSessionMembership(params.session_id,
      () => this.claimUserTabInTurn(params, reservation, checkDeadline)));
  }

  async claimUserTabInTurn(params, reservation, checkDeadline) {
    const session = await this.requireSession(params);
    const tabId = requireTabId(params, "claimUserTab");
    const epoch = this.controlLedger.assertCurrent(params).epoch;
    const revision = this.automationControl.revision;
    const check = () => {
      checkDeadline();
      this.auxiliaryTabs.check(reservation);
      if (this.controlLedger.assertCurrent(params).epoch !== epoch || this.automationControl.revision !== revision)
        throw new Error("OBU_AUXILIARY_CLAIM_CANCELLED: browser control changed");
    };
    check();
    if (reservation.kind === "background-window" && reservation.phase === "excluded") {
      await this.auxiliaryReleases.get(reservation);
      check();
    }
    await this.auxiliaryTabs.settled(tabId);
    check();
    await this.controlReleases.get(tabId);
    check();
    const tab = await chrome.tabs.get(tabId);
    check();
    if (!hasTabId(tab)) {
      throw new Error(`Chrome tab ${tabId} has no id`);
    }
    assertControllableTab(tab);
    await this.assertSiteTab(tabId, { recover: true });
    if (tab.url?.startsWith("chrome://")) {
      throw new Error(`Chrome internal tab ${tabId} cannot be claimed`);
    }
    if (typeof tab.groupId === "number" && tab.groupId !== -1) {
      const owner = await this.store.findSessionByGroup(tab.groupId);
      check();
      if (owner && owner.sessionId !== session.sessionId) {
        throw new Error(`Tab ${tabId} is already part of browser session ${owner.sessionId}`);
      }
    }
    const window = await chrome.windows.get(tab.windowId);
    check();
    this.retireFreshBlankTab(this.freshBlankTabs.get(tabId));
    await this.resetClaimedColdAttachment(tab, check);
    check();
    if (reservation.kind === "created-page" && this.auxiliaryTabs.owner(tabId) === reservation) {
      const live = await this.liveAuxiliaryTab(reservation, { strict: true }); check();
      if (!live) throw new Error("OBU_AUXILIARY_CLAIM_CANCELLED: native child moved before explicit claim");
      await this.setSessionActiveTab(session.sessionId, tab.id, check); check();
      return { ...toBrowserTab(live), active: true };
    }
    if (window.type === "popup") {
      const validate = async () => {
        const live = await chrome.tabs.get(tabId);
        check();
        assertControllableTab(live);
        await this.assertSiteTab(tabId, { recover: true });
        if (live.windowId !== tab.windowId || live.groupId !== -1 || live.url?.startsWith("chrome://"))
          throw new Error("OBU_AUXILIARY_CLAIM_CANCELLED: popup moved or became uncontrollable");
      };
      reservation = await this.auxiliaryTabs.commit(reservation, {
        windowId: tab.windowId, kind: "popup", control_epoch: epoch, controlRevision: revision, check, validate
      });
      check();
      await this.setSessionActiveTab(session.sessionId, tab.id, check);
      check();
    } else {
      const existing = this.auxiliaryTabs.owner(tabId);
      if (existing?.kind === "background-window") {
        const state = await this.store.getSession(session.sessionId);
        await this.commitBackgroundWindowTab(existing, state, check);
        await this.setSessionActiveTab(session.sessionId, tab.id, check);
        check();
        return { ...toBrowserTab(tab), active: true };
      }
      if (existing && existing.kind !== "ordinary") {
        await this.releaseAuxiliaryClaim(reservation);
        throw new Error("OBU_AUXILIARY_CLAIM_CANCELLED: popup moved; explicitly claim it again");
      }
      const state = await this.store.getSession(session.sessionId);
      if (state.ungrouped === true || existing?.kind === "ordinary" || this.auxiliaryTabs.list(session.sessionId).some(value => value.kind === "ordinary")) {
        await this.commitUngroupedTab(reservation, state, tab.windowId, check);
        await this.setSessionActiveTab(session.sessionId, tab.id, check);
        check();
        return { ...toBrowserTab(tab), active: true };
      }
      const priorGroup = state.chromeGroupId;
      // Re-claiming an existing task page must not turn an agent-created page
      // into a user page. Stale origin metadata alone is insufficient after a
      // page has left the task's native group.
      const live = await chrome.tabs.get(tab.id);
      check();
      const origin = reservation.phase !== "excluded" && Number.isSafeInteger(priorGroup) && live.groupId === priorGroup &&
        state.tabOrigins[String(tab.id)] === "agent" ? "agent" : "user";
      let groupingError, creatingGroup = false, createdGroupId;
      try { await this.ensureSessionGroup(session.sessionId, tab.id, origin, check, {
        before: options => { creatingGroup = options.groupId === undefined; },
        after: groupId => { if (creatingGroup) createdGroupId = groupId; }
      }); }
      catch (error) { groupingError = error; }
      check();
      if (groupingError && !/No group with id|Invalid group id/i.test(String(groupingError?.message))) throw groupingError;
      if (Number.isSafeInteger(createdGroupId) && createdGroupId === state.chromeGroupId && await this.singletonGroupDisappeared(createdGroupId, tab.id, tab.windowId)) {
        await this.commitUngroupedTab(reservation, state, tab.windowId, check);
        await this.setSessionActiveTab(session.sessionId, tab.id, check);
        check();
        return { ...toBrowserTab(tab), active: true };
      }
      if (groupingError) throw groupingError;
      check();
      await this.setSessionActiveTab(session.sessionId, tab.id, check);
      check();
      await this.auxiliaryTabs.remove(reservation, { releaseExcluded: true });
    }
    return { ...toBrowserTab(tab), active: true };
  }

  async resetClaimedColdAttachment(tab, check) {
    const tabId = tab.id;
    const tracked = () => this.attachedTabs.has(tabId) || this.attachmentEpochs.has(tabId) ||
      this.pendingAttachmentTabs.has(tabId) || this.browserEngine?.pages?.has(tabId) ||
      this.browserEngine?.releases?.has(tabId);
    check();
    this.assertControlOpen(); // Recovered input is never cleared by debugger detach.
    if (tracked() || this.controlReleases.has(tabId)) return;
    const epoch = this.controlEpochs.get(tabId) ?? 0;
    const current = () => {
      check();
      this.assertControlOpen();
      if ((this.controlEpochs.get(tabId) ?? 0) !== epoch || tracked())
        throw new Error("OBU_TAB_CONTROL_REVOKED: native attachment changed during explicit claim");
    };
    // A stopped worker can leave its extension-owned native debugger alive.
    // Probe only a currently authorized explicit claim, never persisted IDs.
    // Chrome's InitClientHost matches both target and extension ID: failure
    // proves no authority to reset, rather than permission to detach a rival.
    this.coldAttachmentResets.add(tabId);
    let nativeDetachStarted = false, nativeDetachCompleted = false;
    const operation = Promise.resolve().then(async () => {
      current();
      let result;
      try { result = await chrome.debugger.sendCommand({ tabId }, "Target.getTargetInfo", {}); }
      catch { current(); return; }
      current();
      const targetId = result?.targetInfo?.targetId;
      if (typeof targetId !== "string" || targetId.length === 0 || result.targetInfo.type !== "page") return;
      const live = await chrome.tabs.get(tabId);
      current();
      if (live.windowId !== tab.windowId || live.groupId !== tab.groupId)
        throw new Error("OBU_TAB_CONTROL_REVOKED: claimed tab moved during native attachment reset");
      this.assertSiteProof(await this.assertSiteTab(tabId, { recover: true }));
      current();
      // Opaque native identity prevents a numeric tab replacement from being
      // detached. This API only closes this extension's client host. Failure
      // remains observable; it does not certify input release or erase a risk.
      nativeDetachStarted = true;
      await chrome.debugger.detach({ targetId });
      nativeDetachCompleted = true;
      current();
    });
    // Admission cancellation is expected, but a native reset failure is not.
    // Keep the actual cleanup barrier distinct from the claim's result so a
    // successful detach followed by Pause does not report false cleanup failure.
    const release = operation.then(() => {}, error => {
      if (nativeDetachStarted && !nativeDetachCompleted) throw error;
    });
    this.controlReleases.set(tabId, release);
    release.catch(() => {});
    try { await operation; }
    finally {
      this.coldAttachmentResets.delete(tabId);
      if (this.controlReleases.get(tabId) === release) this.controlReleases.delete(tabId);
    }
  }

  async finalizeTabs(params) {
    const session = await this.requireSession(params);
    if (!Array.isArray(params.keep)) {
      throw new Error("finalizeTabs requires keep array");
    }
    let tabs = await this.getSessionTabs(session.sessionId, { strict: true });
    const knownTabIds = new Set(tabs.filter(hasTabId).map((tab) => tab.id));
    const keep = new Map();
    for (const entry of params.keep) {
      if (!entry || typeof entry !== "object") {
        throw new Error("finalizeTabs received invalid tab entry");
      }
      const tabId = requireTabId(entry, "finalizeTabs");
      if (!knownTabIds.has(tabId)) {
        throw new Error(`finalizeTabs cannot keep unknown tab ${tabId}`);
      }
      if (keep.has(tabId)) {
        throw new Error(`finalizeTabs received duplicate tab ${tabId}`);
      }
      const status = entry.status;
      if (status !== "handoff" && status !== "deliverable") {
        throw new Error(`finalizeTabs received invalid status ${String(status)}`);
      }
      if (status === "deliverable" && ["popup", "created-page"].includes(this.auxiliaryTabs.owner(tabId)?.kind)) {
        throw new Error("OBU_AUXILIARY_DELIVERABLE_UNSUPPORTED: use handoff to preserve the native window");
      }
      keep.set(tabId, status);
    }
    return this.endSessionControl(params, async () => {
      tabs = await this.getSessionTabs(session.sessionId, { strict: true });
      const sessionState = await this.store.getSession(session.sessionId);
      const agentTabsToClose = [];
      const userTabsToRelease = [];
      const deliverableTabs = [];
      const handoffTabs = [];
      const auxiliaryToRelease = [];
      const ordinaryToRelease = [];
      const backgroundRecords = new Map();
      for (const tab of tabs) {
        if (!hasTabId(tab)) {
          continue;
        }
        const keptStatus = keep.get(tab.id);
        const explicit = this.auxiliaryTabs.owner(tab.id);
        if (explicit?.kind === "background-window") backgroundRecords.set(tab.id, explicit);
        if (keptStatus === "handoff") {
          handoffTabs.push(tab.id);
          continue;
        }
        if (keptStatus === "deliverable") {
          deliverableTabs.push(tab.id);
          if (["ordinary", "background-window", "created-page"].includes(explicit?.kind)) ordinaryToRelease.push(explicit);
          continue;
        }
        const auxiliary = this.auxiliaryTabs.owner(tab.id);
        if (auxiliary?.session_id === session.sessionId && ["popup", "created-page"].includes(auxiliary.kind)) {
          auxiliaryToRelease.push(auxiliary);
        } else if ((auxiliary?.origin ?? sessionState.tabOrigins[String(tab.id)]) === "agent") {
          agentTabsToClose.push(tab.id);
          if (auxiliary) ordinaryToRelease.push(auxiliary);
        } else {
          userTabsToRelease.push(tab.id);
          if (auxiliary) ordinaryToRelease.push(auxiliary);
        }
      }
      // Detach every disposition, including handoff tabs we keep alive: leaving a
      // tab attached keeps Chrome's "started debugging this browser" banner up
      // after the turn ends. The debugger re-attaches lazily on the next CDP call
      // (the CLI runner and background handlers attach on demand), so dropping it
      // here is loss-free while clearing the banner.
      await this.detachMany([
        ...agentTabsToClose,
        ...userTabsToRelease,
        ...deliverableTabs,
        ...handoffTabs,
        ...auxiliaryToRelease.map(record => record.tabId)
      ]);
      // Detach may await real native input cleanup. A user move during that
      // wait withdraws this exact page from every planned disposition.
      const backgroundStillOwned = async (tabId, record) => {
        const live = await this.liveAuxiliaryTab(record, { strict: true });
        return !!live && this.auxiliaryTabs.owner(tabId) === record;
      };
      for (const [tabId, record] of backgroundRecords) if (!await backgroundStillOwned(tabId, record)) {
        for (const list of [agentTabsToClose, userTabsToRelease, deliverableTabs, handoffTabs]) {
          const index = list.indexOf(tabId); if (index !== -1) list.splice(index, 1);
        }
        const index = ordinaryToRelease.indexOf(record); if (index !== -1) ordinaryToRelease.splice(index, 1);
      }
      for (const record of auxiliaryToRelease) await this.releaseAuxiliaryClaim(record);
      this.assertControlOpen();
      if (agentTabsToClose.length > 0) {
        const grouped = agentTabsToClose.filter(tabId => !backgroundRecords.has(tabId));
        if (grouped.length) await chrome.tabs.remove(grouped.length === 1 ? grouped[0] : grouped);
        for (const tabId of agentTabsToClose) {
          const record = backgroundRecords.get(tabId);
          if (record && await backgroundStillOwned(tabId, record)) {
            this.assertControlOpen();
            await chrome.tabs.remove(tabId);
          }
        }
      }
      this.assertControlOpen();
      if (userTabsToRelease.length > 0 && chrome.tabs.ungroup) {
        const groupedUsers = userTabsToRelease.filter(tabId => !ordinaryToRelease.some(record => record.tabId === tabId));
        if (groupedUsers.length) await chrome.tabs.ungroup(groupedUsers.length === 1 ? groupedUsers[0] : groupedUsers);
      }
      this.assertControlOpen();
      if (deliverableTabs.length > 0) {
        const explicitIds = new Set(ordinaryToRelease.filter(record => deliverableTabs.includes(record.tabId)).map(record => record.tabId));
        await this.moveToDeliverables(deliverableTabs.filter(tabId => !explicitIds.has(tabId)));
        // These are delivered pages, not remaining task authority or imaginary
        // native groups. The lifetime-bound store drops their IDs on restart.
        this.store.state.deliverableTabs ??= {};
        for (const record of ordinaryToRelease) if (explicitIds.has(record.tabId))
          this.store.state.deliverableTabs[String(record.tabId)] = { windowId: record.windowId };
        if (explicitIds.size) await this.store.save();
      }
      for (const record of ordinaryToRelease) {
        if (record.kind === "background-window" && this.auxiliaryTabs.entry(record.tabId) === record &&
            this.auxiliaryTabs.owner(record.tabId) !== record) continue;
        await this.releaseAuxiliaryClaim(record, { disposition: true });
      }
      for (const tabId of [...agentTabsToClose, ...userTabsToRelease, ...deliverableTabs]) {
        delete sessionState.tabOrigins[String(tabId)];
        this.cursorByTabId.delete(tabId);
      }
      if (handoffTabs.length > 0) {
        sessionState.activeTabId = handoffTabs.includes(sessionState.activeTabId)
          ? sessionState.activeTabId
          : handoffTabs[0];
        this.activeTabsBySession.set(session.sessionId, sessionState.activeTabId);
        await this.store.save();
      } else {
        this.activeTabsBySession.delete(session.sessionId);
        await this.store.removeSession(session.sessionId);
      }
    });
  }

  async nameSession(params) {
    return this.runSessionMutation(params, () => this.nameSessionInTurn(params));
  }

  async nameSessionInTurn(params) {
    const session = await this.requireSession(params);
    const name = typeof params.name === "string" && params.name.trim() ? params.name.trim() : DEFAULT_SESSION_GROUP_TITLE;
    const sessionState = await this.store.getSession(session.sessionId);
    sessionState.title = name;
    await this.store.save();
    this.assertControlOpen();
    if (typeof sessionState.chromeGroupId === "number") {
      await chrome.tabGroups.update(sessionState.chromeGroupId, { title: name }).catch(() => {});
    }
  }

  async attach(params) {
    return this.runSessionMutation(params, () => this.attachInTurn(params));
  }

  async attachInTurn(params) {
    const tabId = requireTabId(params, "attach");
    let epoch = this.controlEpochs.get(tabId) ?? 0;
    await this.requireSessionTab(params, "attach");
    await this.controlReleases.get(tabId)?.catch(() => {});
    await this.requireSessionTab(params, "attach");
    if ((this.controlEpochs.get(tabId) ?? 0) !== epoch) throw new Error("Browser attachment was cancelled because tab control ended");
    if (await this.releasePreviousAttachmentOwner(params, tabId)) epoch = this.controlEpochs.get(tabId) ?? 0;
    this.assertControlOpen();
    if (this.browserEngine) {
      await this.browserEngine.attach(tabId);
      if ((this.controlEpochs.get(tabId) ?? 0) !== epoch) throw new Error("Browser attachment was cancelled because tab control ended");
      await this.requireSessionTab(params, "attach");
      this.rememberAttachmentOwner(params, tabId);
      return;
    }
    // The legacy raw attach RPC has no action deadline. With an engine, only
    // its actual creator may retire fresh state in onBeforeAttach; joining an
    // existing gated Page must not cancel that creator's readiness wait.
    this.retireFreshBlankTab(this.freshBlankTabs.get(tabId));
    if (!this.attachedTabs.has(tabId)) {
      let attachedHere = false;
      try {
        this.pendingAttachmentTabs.add(tabId);
        await chrome.debugger.attach({ tabId }, "1.3");
        attachedHere = true;
      } catch (error) {
        if (!String(error?.message ?? error).includes("Another debugger")) {
          this.pendingAttachmentTabs.delete(tabId);
          throw error;
        }
      }
      try {
        this.controlLedger.assertCurrent(params);
        await this.registerEngineAttachment(tabId, epoch);
      } catch (error) {
        // Do not leave a half-initialized debugger attached, or detach another
        // debugger when Chrome rejected our original attachment.
        if (attachedHere) await chrome.debugger.detach({ tabId }).catch(() => {});
        this.pendingAttachmentTabs.delete(tabId);
        throw error;
      }
    }
    this.rememberAttachmentOwner(params, tabId);
  }

  async getBrowserEngine() {
    if (this.browserEngine) return this.browserEngine;
    this.browserEngine = createBrowserActionEngine({
      restrictedSelectors: () => this.siteAccess.restricted,
      prepareFileInput: options => this.prepareLocatorFileInput(options),
      authorize: async (params) => {
        await this.requireSessionTab(params, "browserAction");
        this.rememberAttachmentOwner(params, params.tabId);
      },
      onBeforeAttach: (tabId, admission) => this.prepareEngineAttachment(tabId, admission),
      onAttached: (tabId) => this.registerEngineAttachment(tabId),
      onDetached: (tabId) => this.releaseEngineAttachment(tabId),
      aroundAction: ({ params, timeoutMs, run }) => this.withRenderingLease({ tabId: params.tabId }, timeoutMs, run, params.action),
      isInternalEvent: (source, method, params) => this.isInternalCdpEvent(source, method, params),
      inputHooks: {
        prepareMediaCleanup: (target, contextId) => this.prepareMediaCleanup(target, contextId),
        beginPointerAction: (target, check) => {
          this.assertControlOpen();
          const token = this.attachmentEpochs.get(target.tabId);
          const assertCurrent = () => {
            this.assertControlOpen();
            this.assertAttachmentAdmission(target.tabId, token);
            check();
          };
          assertCurrent();
          return this.inputTracker.beginPointerAction(target.tabId, token, assertCurrent);
        },
        send: (target, method, params, operation, pointerGuard) => {
          this.assertControlOpen();
          const token = this.attachmentEpochs.get(target.tabId);
          this.assertAttachmentAdmission(target.tabId, token);
          this.inputTracker.assertSend(target.tabId, token);
          const send = () => {
            this.assertControlOpen();
            this.assertAttachmentAdmission(target.tabId, token);
            this.inputTracker.assertSend(target.tabId, token);
            if (this.siteAccess.restricted) return this.assertSiteTab(target.tabId, { allowBlank: true }).then(proof => {
              this.assertControlOpen();
              this.assertAttachmentAdmission(target.tabId, token);
              this.assertSiteProof(proof);
              this.inputTracker.assertSend(target.tabId, token);
              return this.inputTracker.send(target, token, method, params, () => {
                this.assertSiteProof(proof);
                return operation();
              }, pointerGuard);
            });
            return this.inputTracker.send(target, token, method, params, operation, pointerGuard);
          };
          if (method.startsWith("Input.") && (this.fileChooserWaitersByTabId.has(target.tabId) || this.downloadWaits.byTab.has(target.tabId)))
            return this.waitForTransferTargets(target.tabId).then(send);
          return send();
        },
        release: tabId => this.releaseTrackedInput(tabId),
        prepareRelease: tabId => this.prepareInputRelease(tabId)
      },
      onCommand: ({ target, method, commandParams, metadata }) => {
        this.enqueuePointerFeedback({ ...metadata, target, method, commandParams });
      }
    });
    return this.browserEngine;
  }

  async browserAction(params) {
    if (params.action === "setInputFiles") params = validateBrowserAction(params);
    const startedAt = Date.now();
    const timeoutMs = params.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("timeoutMs must be between 1 and 120000");
    const deadlineAt = performance.now() + timeoutMs;
    const remaining = () => {
      const value = deadlineAt - performance.now();
      if (value < 1) throw new Error("Browser action timed out during admission");
      return value;
    };
    if (params.action === "goto") {
      assertControllableUrl(params.args?.url);
      this.siteAccess.assertUrl(params.args?.url);
    }
    const tabId = requireTabId(params, "browserAction");
    let epoch = this.controlEpochs.get(tabId) ?? 0;
    await this.controlReleases.get(tabId)?.catch(() => {});
    remaining();
    await this.requireSessionTab(params, "browserAction");
    remaining();
    if (await this.releasePreviousAttachmentOwner(params, tabId, remaining)) epoch = this.controlEpochs.get(tabId) ?? 0;
    remaining();
    const engine = await this.getBrowserEngine();
    remaining();
    const downloadSetup = this.downloadWaits.byTab.get(tabId);
    const setup = this.fileChooserSetupsByTabId.get(tabId) ?? (downloadSetup && { sessionId: downloadSetup.params.session_id, promise: downloadSetup.ready.promise });
    if (setup?.sessionId !== params.session_id && (this.controlEpochs.get(tabId) ?? 0) !== epoch) {
      throw new Error("Browser action was cancelled while loading the engine");
    }
    if (setup?.sessionId === params.session_id) {
      await this.withinTransferDeadline(startedAt + timeoutMs, () => setup.promise);
      await this.requireSessionTab(params, "browserAction");
    }
    await this.withinTransferDeadline(startedAt + timeoutMs, () => this.waitForTransferTargets(tabId));
    let result;
    try { result = await engine.dispatch({ ...params, timeoutMs: params.action === "setInputFiles" ? Math.floor(remaining()) : remaining() }); }
    catch (error) {
      if (this.siteAccess.restricted && this.siteRevokedTabs.has(tabId)) throw new Error("OBU_SITE_ACCESS_DENIED: document access was revoked during the browser action");
      throw error;
    }
    this.assertSiteProof(await this.assertSiteTab(tabId));
    return result;
  }

  async armNetworkWait(params, record) {
    const check = () => this.networkWaits.check(record);
    check();
    const tabId = requireTabId(params, "armNetworkWait");
    await this.controlReleases.get(tabId)?.catch(() => {});
    check();
    await this.requireSessionTab(params, "armNetworkWait");
    check();
    await this.releasePreviousAttachmentOwner(params, tabId, check, { preserveNetworkArming: true });
    check();
    const engine = await this.getBrowserEngine();
    check();
    return engine.withPage(params, { deadlineAt: record.deadlineAt }, async ({ page, check: checkPage }) => {
      check();
      await checkPage();
      check();
      await this.requireSessionTab(params, "armNetworkWait");
      check();
      this.rememberAttachmentOwner(params, tabId);
      const scope = { ...this.attachmentOwners.get(tabId) };
      this.assertTransferScope(scope);
      return this.networkWaits.arm(record, page, scope, value => this.validateTransferScope(value));
    });
  }

  async collectNetworkWait(params) {
    await this.requireSessionTab(params, "collectNetworkWait");
    return this.networkWaits.collect(params);
  }

  async cancelNetworkWait(params) {
    await this.requireSessionTab(params, "cancelNetworkWait");
    return this.networkWaits.cancel(params);
  }

  captureNavigationSetups(params) {
    const pages = [...this.pageWaits.byTab.values()].filter(record => ["reserved", "arming"].includes(record.state))
      .map(record => [record, record.ready.promise]);
    return [...this.navigationSetups, ...pages].filter(([record]) => {
      const scope = record.params;
      return scope.session_id === params?.session_id && scope.turn_id === params?.turn_id &&
        (params?.tabId === undefined || scope.tabId === params.tabId) &&
        (params?.control_epoch === undefined || scope.control_epoch === undefined || scope.control_epoch === params.control_epoch);
    }).map(([, pending]) => pending);
  }

  async runAfterNavigationSetups(params, setups, handler) {
    if (!setups.length) return this.runControlledRequest(() => handler(params));
    const timeoutMs = params.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("timeoutMs must be between 1 and 120000");
    const deadlineAt = performance.now() + timeoutMs;
    const remaining = () => {
      const value = deadlineAt - performance.now();
      if (value <= 0) throw new Error("OBU_NAVIGATION_SETUP_TIMEOUT: action expired before navigation listener setup");
      return value;
    };
    await withTimeout(remaining(), () => this.runControlledRequest(async () => {
      remaining();
      await Promise.all(setups);
    }), () => new Error("OBU_NAVIGATION_SETUP_TIMEOUT: action expired before navigation listener setup"));
    return this.runControlledRequest(() => {
      const timeoutMs = Math.max(1, Math.floor(remaining()));
      return handler({ ...params, timeoutMs });
    });
  }

  async startNavigationWait(request, { direct = false } = {}) {
    let params = request;
    if (direct) {
      const action = validateBrowserAction(request);
      params = {
        session_id: action.session_id, turn_id: action.turn_id, control_epoch: action.control_epoch,
        tabId: action.tabId, timeoutMs: action.timeoutMs,
        ...(action.action === "waitForURL" ? { event: "url", url: action.args.url, waitUntil: action.args.waitUntil }
          : { event: "loadstate", state: action.args.state })
      };
    }
    const record = this.navigationWaits.reserve(params, { allowLegacyEpoch: direct });
    const setup = this.navigationWaits.within(record, () => this.runControlledRequest(() => this.setupNavigationWait(record)));
    this.navigationSetups.set(record, setup);
    setup.finally(() => { if (this.navigationSetups.get(record) === setup) this.navigationSetups.delete(record); }).catch(() => {});
    try {
      const ack = await setup;
      if (!direct) return ack;
      await this.runControlledRequest(() => this.collectNavigationWait({
        session_id: record.params.session_id, turn_id: record.params.turn_id, control_epoch: record.params.control_epoch,
        tabId: record.params.tabId, waiterId: ack.waiterId
      }));
      return { value: null, engine: BROWSER_ENGINE_INFO };
    } catch (error) {
      this.navigationWaits.fail(record, error);
      throw error;
    } finally {
      if (direct) this.navigationWaits.remove(record);
    }
  }

  async armNavigationWait(_params, record) {
    return this.setupNavigationWait(record);
  }

  async setupNavigationWait(record) {
    const check = () => this.navigationWaits.check(record);
    check();
    const tabId = record.params.tabId;
    await this.controlReleases.get(tabId)?.catch(() => {});
    check();
    await this.requireSessionTab(record.params, "armNavigationWait");
    check();
    const params = { ...record.params, control_epoch: this.controlLedger.assertCurrent(record.params).epoch };
    await this.releasePreviousAttachmentOwner(params, tabId, check, { preserveNavigationArming: true });
    check();
    const engine = await this.getBrowserEngine();
    check();
    return engine.withPage(params, {
      deadlineAt: record.deadlineAt,
      isolateTimeout: true,
      timeoutError: () => new Error("OBU_NAVIGATION_WAIT_TIMEOUT: Page setup deadline expired"),
      expiredError: () => new Error("OBU_NAVIGATION_WAIT_EXPIRED: tab control ended during setup")
    }, async ({ page, check: checkPage, remainingMs }) => {
      check();
      await checkPage();
      await this.requireSessionTab(params, "armNavigationWait");
      check();
      this.rememberAttachmentOwner(params, tabId);
      const scope = { ...this.attachmentOwners.get(tabId) };
      this.assertTransferScope(scope);
      const runtime = await engine.runtime();
      check();
      const observer = runtime.createOpenBrowserUseNavigationWait(page, {
        event: params.event, url: params.url, waitUntil: params.waitUntil, state: params.state,
        timeoutMs: remainingMs()
      });
      try { return await this.navigationWaits.arm(record, observer, scope, value => this.validateTransferScope(value)); }
      catch (error) { observer.cancel(error); throw error; }
    });
  }

  async collectNavigationWait(params) {
    await this.requireSessionTab(params, "collectNavigationWait");
    return this.navigationWaits.collect(params);
  }

  async cancelNavigationWait(params) {
    await this.requireSessionTab(params, "cancelNavigationWait");
    return this.navigationWaits.cancel(params);
  }

  async releasePreviousAttachmentOwner(params, tabId, check = () => {}, options = {}) {
    const owner = this.attachmentOwners.get(tabId);
    const current = this.controlLedger.assertCurrent(params);
    if (!owner || (owner.session_id === params.session_id && owner.control_epoch === current.epoch)) return false;
    // Prove the new owner before releasing the exact old attachment. The tab
    // may have been regrouped by the user while its old Page was still alive.
    await this.requireSessionTab({ ...params, tabId }, "attachment transfer");
    check();
    if (this.attachmentOwners.get(tabId) === owner && this.attachmentEpochs.get(tabId) === owner.attachment) {
      await this.detachTab(tabId, options);
      check();
      await this.requireSessionTab({ ...params, tabId }, "attachment transfer");
      check();
      return true;
    }
    return false;
  }

  retireFreshBlankTab(marker) {
    if (marker && this.freshBlankTabs.get(marker.tabId) === marker) {
      this.freshBlankTabs.delete(marker.tabId);
      marker.retire();
    }
  }

  async waitForFreshBlankTab(tabId, admission) {
    const marker = this.freshBlankTabs.get(tabId);
    if (!marker) return;
    if (!admission) { this.retireFreshBlankTab(marker); return; }
    const cancelled = () => new Error("OBU_TAB_CREATION_REVOKED: fresh page changed before its first attachment");
    let stopped = false;
    const current = () => {
      admission.remainingMs();
      this.assertControlOpen();
      const params = admission.params;
      if (stopped || this.freshBlankTabs.get(tabId) !== marker || marker.transaction.invalid ||
          marker.tabId !== params.tabId || marker.session_id !== params.session_id || marker.turn_id !== params.turn_id ||
          marker.control_epoch !== this.controlLedger.assertCurrent(params).epoch || marker.revision !== this.automationControl.revision)
        throw cancelled();
    };
    const check = async () => { current(); await admission.check(); current(); };
    const observe = async () => {
      await check();
      await marker.transaction.done;
      await check();
      if (!marker.transaction.admitted) throw cancelled();
      let observed = false;
      for (;;) {
        const tab = await chrome.tabs.get(tabId);
        await check();
        if (tab.id !== tabId || tab.windowId !== marker.windowId || tab.groupId !== marker.groupId || tab.pinned ||
            (!marker.ownWindow && tab.active)) throw cancelled();
        if (marker.ownWindow) {
          const window = await chrome.windows.get(marker.windowId);
          await check();
          if (window.id !== marker.windowId || window.focused) throw cancelled();
        }
        // A page already navigated before this first attempt is no longer a
        // fresh blank. A navigation arriving during our wait cancels it.
        if (!observed && tab.url && tab.url !== "about:blank" && tab.status === "complete" && !tab.pendingUrl) return;
        if ((tab.url && tab.url !== "about:blank") || (tab.pendingUrl && tab.pendingUrl !== "about:blank")) throw cancelled();
        observed = true;
        if (tab.url === "about:blank" && tab.status === "complete" && !tab.pendingUrl) return;
        await new Promise(resolve => setTimeout(resolve, Math.min(25, admission.remainingMs())));
        await check();
      }
    };
    try {
      // Bound the read itself as well as each continuation. A timed-out native
      // tabs.get may settle later, but cannot send a subsequent read or attach.
      current();
      await withTimeout(admission.remainingMs(), () => Promise.race([
        observe(), marker.retired.then(() => { throw cancelled(); })
      ]), admission.timeoutError);
      current();
      this.retireFreshBlankTab(marker);
    } finally { stopped = true; }
  }

  async prepareEngineAttachment(tabId, admission) {
    const epoch = this.controlEpochs.get(tabId) ?? 0;
    this.assertControlOpen();
    this.assertAttachmentAdmission(tabId);
    try { await this.waitForFreshBlankTab(tabId, admission); }
    catch (error) {
      // This gate precedes raw migration and token allocation. Only a proven
      // unprepared Page may drain engine cleanup without a native detach.
      if (!this.attachedTabs.has(tabId) && !this.pendingAttachmentTabs.has(tabId) && !this.attachmentEpochs.has(tabId)) {
        error.attachmentReleased = true;
        error.attachmentCleanupComplete = true;
      }
      throw error;
    }
    admission?.remainingMs();
    this.assertSiteProof(await this.assertSiteTab(tabId, { recover: true, allowBlank: true }));
    admission?.remainingMs();
    // CRX must establish its own protocol state. Release only a raw attachment
    // that this backend actually owns; never detach a competing debugger.
    if (this.attachedTabs.has(tabId)) {
      const releases = [this.fileChooserWaits.invalidateAttachedTab(tabId), this.downloadWaits.invalidateAttachedTab(tabId), this.pageWaits.invalidateAttachedTab(tabId), this.directDownloads.invalidate(record => record.params.tabId === tabId && record.scope?.mediaDownload),
        this.pageExports.invalidateAttachedTab(tabId), this.clipboard.invalidateAttachedTab(tabId)];
      const results = await Promise.allSettled(releases);
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
      await this.releaseTrackedInput(tabId);
      admission?.remainingMs();
      await chrome.debugger.detach({ tabId });
      this.releaseEngineAttachment(tabId);
    }
    await admission?.check();
    admission?.remainingMs();
    this.assertControlOpen();
    this.assertNativeControl();
    if ((this.controlEpochs.get(tabId) ?? 0) !== epoch) throw new Error("Browser attachment was cancelled because tab control ended");
    const token = {};
    this.inputTracker.register(tabId, token);
    this.pendingAttachmentEpochs.set(tabId, epoch);
    this.attachmentEpochs.set(tabId, token);
    this.pendingAttachmentTabs.add(tabId);
  }

  async registerEngineAttachment(tabId, expectedEpoch = this.pendingAttachmentEpochs.get(tabId)) {
    // Shared with the action engine after it owns the native attachment. Keep
    // background pages responsive without activating their tab or window.
    // Chrome resets this renderer override when the debugger detaches.
    this.assertControlOpen();
    this.assertAttachmentAdmission(tabId);
    const current = () => {
      this.assertAttachmentAdmission(tabId);
      if (expectedEpoch !== undefined && (this.controlEpochs.get(tabId) ?? 0) !== expectedEpoch)
        throw new Error("Browser attachment was cancelled because tab control ended");
    };
    current();
    this.assertSiteProof(await this.assertSiteTab(tabId, { allowBlank: true }));
    current();
    if (!this.attachmentEpochs.has(tabId)) this.attachmentEpochs.set(tabId, {});
    this.inputTracker.register(tabId, this.attachmentEpochs.get(tabId));
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
    this.assertControlOpen();
    current();
    this.attachedTabs.add(tabId);
    this.pendingAttachmentTabs.delete(tabId);
    this.pendingAttachmentEpochs.delete(tabId);
  }

  releaseEngineAttachment(tabId) {
    // A cold network arm reserves capacity before the raw-to-CRX migration.
    // Release only waits bound to the retiring Page here. External detach,
    // explicit cancellation and ownership events also retire unbound setups.
    this.networkWaits.invalidateAttachedTab(tabId);
    this.navigationWaits.invalidateAttachedTab(tabId);
    this.directoryUploads.invalidate({ tabId, attachment: this.attachmentEpochs.get(tabId) }, new Error("OBU_TRANSFER_CANCELLED: browser attachment changed"));
    this.fileInputDocumentsByTabId.delete(tabId);
    // detachTab already owns this exact native cleanup attempt. Its engine
    // hook and final attachment release must not start untracked retries of a
    // rejected download cancellation after that attempt's barrier resolves.
    if (!this.pageWaitNativeReleases.has(tabId)) void this.directDownloads.invalidateAttachedTab(tabId);
    void this.pageExports.invalidateAttachedTab(tabId).catch(() => {});
    void this.clipboard.invalidateAttachedTab(tabId).catch(() => {});
    this.inputTracker.forget(tabId, this.attachmentEpochs.get(tabId));
    this.cancelTabTransfers(tabId, new Error("OBU_TRANSFER_CANCELLED: tab control ended"), { attachedOnly: true });
    this.attachmentOwners.delete(tabId);
    this.childSessionsByTabId.delete(tabId);
    this.pendingAttachmentTabs.delete(tabId);
    this.pendingAttachmentEpochs.delete(tabId);
    this.documentEpochs.delete(tabId);
    this.internalScreencasts.get(tabId)?.cancel?.();
    // A confirmed attachment release ends its native stream. A successor
    // attachment must not inherit an old unresolved API reply, which remains
    // tracked separately until its actual Promise settles.
    this.renderingQueues.delete(tabId);
    this.clearPointerFeedback(tabId);
    this.externalScreencastTabs.delete(tabId);
    this.internalScreencasts.delete(tabId);
    this.attachedTabs.delete(tabId);
    this.attachmentEpochs.delete(tabId);
    for (const [fileChooserId, chooser] of this.fileChoosersById) {
      if (chooser.tabId === tabId) this.fileChoosersById.delete(fileChooserId);
    }
    this.cursorByTabId.delete(tabId);
  }

  async detach(params) {
    await this.requireSessionTab(params, "detach");
    const tabId = requireTabId(params, "detach");
    await this.detachTab(tabId);
  }

  async executeCdp(params) {
    const startedAt = Date.now();
    const originalEpochs = new Map(this.controlEpochs);
    const session = await this.requireSession(params);
    const target = await this.resolveCdpTarget(params);
    const attachment = this.attachmentEpochs.get(target?.tabId);
    const checkTarget = () => {
      if (target && ((this.controlEpochs.get(target.tabId) ?? 0) !== (originalEpochs.get(target.tabId) ?? 0) ||
          this.attachmentEpochs.get(target.tabId) !== attachment))
        throw new Error("OBU_TAB_CONTROL_REVOKED: native command's original tab control ended");
      this.assertAttachmentAdmission(target?.tabId, attachment);
    };
    checkTarget();
    await this.validateCdpCommandTarget(params, target);
    this.controlLedger.assertCurrent(params);
    if (Number.isInteger(target?.tabId)) {
      const owner = this.attachmentOwners.get(target.tabId);
      const current = this.controlLedger.assertCurrent(params);
      if (owner && (owner.session_id !== params.session_id || owner.control_epoch !== current.epoch)) {
        throw new Error("Browser attachment belongs to a previous control session; attach again before sending raw CDP");
      }
      this.rememberAttachmentOwner(params, target.tabId);
    }
    const timeoutMs =
      typeof params.timeoutMs === "number" && params.timeoutMs > 0
        ? params.timeoutMs
        : DEFAULT_CDP_TIMEOUT_MS;
    const downloadSetup = this.downloadWaits.byTab.get(target?.tabId);
    const setup = this.fileChooserSetupsByTabId.get(target?.tabId) ?? (downloadSetup && { sessionId: downloadSetup.params.session_id, promise: downloadSetup.ready.promise });
    if (setup?.sessionId === params.session_id) await this.withinTransferDeadline(startedAt + timeoutMs, () => setup.promise);
    if (params.method?.startsWith("Input.")) await this.withinTransferDeadline(startedAt + timeoutMs, () => this.waitForTransferTargets(target?.tabId));
    this.controlLedger.assertCurrent(params);
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) throw new Error("Timed out preparing CDP command");
    const result = await withTimeout(remaining, async () => {
      if (params.method === "Target.getTargets") {
        const tabIds = new Set((await this.getSessionTabs(session.sessionId)).map((tab) => tab.id));
        return { targetInfos: (await chrome.debugger.getTargets()).filter((info) => tabIds.has(info.tabId) && !isOwnExtensionUrl(info.url)) };
      }
      if (typeof params.method !== "string") {
        throw new Error("executeCdp requires method");
      }
      checkTarget();
      if (params.method === "Page.captureScreenshot" && target.sessionId === undefined) {
        return await this.captureScreenshot(target, params.commandParams ?? {}, remaining);
      }
      const send = () => this.inputTracker.send(target, attachment, params.method, params.commandParams ?? {}, () => {
        checkTarget();
        this.controlLedger.assertCurrent(params);
        if (Date.now() >= startedAt + timeoutMs) throw new Error("Timed out preparing CDP command before native send");
        return chrome.debugger.sendCommand(target, params.method, params.commandParams ?? {});
      });
      if (target.sessionId === undefined && ["Page.startScreencast", "Page.stopScreencast"].includes(params.method)) {
        return await this.queueRendering(target.tabId, async () => {
          const response = await send();
          // A timed-out RPC is not a completed native operation. Record a late
          // ACK only for its original live owner, before releasing the queue.
          checkTarget();
          this.controlLedger.assertCurrent(params);
          if (params.method === "Page.startScreencast") this.externalScreencastTabs.add(target.tabId);
          else this.externalScreencastTabs.delete(target.tabId);
          return response;
        });
      }
      // Frame ACKs must stay outside the queue: an external stream can need
      // them while a rendering operation holds the lease.
      return await send();
    });
    // The low-level CLI/SDK route must show the same pointer as moveMouse.
    // Feedback is optional: a restricted or unresponsive page must not turn a
    // successful input command into a failure (and cause the caller to retry it).
    this.enqueuePointerFeedback({ ...params, target });
    return result;
  }

  async captureScreenshot(target, commandParams, timeoutMs) {
    return this.withRenderingLease(target, timeoutMs, () => chrome.debugger.sendCommand(target, "Page.captureScreenshot", commandParams), "screenshot");
  }

  queueRendering(tabId, operation) {
    const previous = this.renderingQueues.get(tabId) ?? Promise.resolve();
    const queued = previous.catch(() => {}).then(operation);
    this.renderingQueues.set(tabId, queued);
    this.renderingDrains.add(queued);
    const cleanup = () => {
      this.renderingDrains.delete(queued);
      if (this.renderingQueues.get(tabId) === queued) this.renderingQueues.delete(tabId);
    };
    queued.then(cleanup, cleanup);
    return queued;
  }

  async withRenderingLease(target, timeoutMs, operation, action = "rendered action") {
    const tabId = target.tabId;
    const deadline = Date.now() + timeoutMs;
    const attachment = this.attachmentEpochs.get(tabId);
    let expired = false;
    let closeCapture;
    let phase = `waiting in rendering queue for ${action}`;
    const timeoutError = () => Object.assign(new Error(`Timed out after ${timeoutMs}ms ${phase}.`), { name: "TimeoutError" });
    const withinDeadline = (operation) => withTimeout(Math.max(1, deadline - Date.now()), operation, timeoutError);
    const ownsAttachment = () => this.attachedTabs.has(tabId) && this.attachmentEpochs.get(tabId) === attachment;
    const assertCurrent = () => {
      this.assertControlOpen();
      this.assertAttachmentAdmission(tabId, attachment);
      if (expired || Date.now() >= deadline || !ownsAttachment()) throw new Error(`Rendering request expired before ${action}`);
    };
    const queued = this.queueRendering(tabId, async () => {
      assertCurrent();
      if (this.externalScreencastTabs.has(tabId)) {
        phase = `running ${action} with caller-owned stream`;
        const result = await withinDeadline(operation);
        assertCurrent();
        return result;
      }
      let started = false;
      const stream = this.internalScreencasts.get(tabId) ?? { active: false, frameIds: [] };
      this.internalScreencasts.set(tabId, stream);
      let rejectFrame;
      let onFrame;
      let cancelCapture;
      const cancelled = new Promise((_, reject) => { cancelCapture = reject; });
      cancelled.catch(() => {});
      const frame = new Promise((resolve, reject) => {
        rejectFrame = reject;
        onFrame = (source, method, params) => {
          if (source.tabId !== tabId || source.sessionId != null || method !== "Page.screencastFrame") return;
          if (!ownsAttachment() || expired) return;
          chrome.debugger.sendCommand(target, "Page.screencastFrameAck", { sessionId: params.sessionId }).then(resolve, reject);
        };
        chrome.debugger.onEvent.addListener(onFrame);
      });
      // Attach a rejection handler before cleanup can reject an unused waiter.
      frame.catch(() => {});
      closeCapture = error => {
        expired = true;
        chrome.debugger.onEvent.removeListener(onFrame);
        rejectFrame(error);
        cancelCapture(error);
      };
      stream.cancel = () => closeCapture(new Error("Rendered action was cancelled because tab control ended"));
      try {
        phase = `waiting for background frame before ${action}`;
        // Keep the queue through real native start/stop settlement. The outer
        // deadline can stop waiting and remove listeners, but cannot grant a
        // successor permission to replace a stream whose ACK is still pending.
        await chrome.debugger.sendCommand(target, "Page.enable");
        assertCurrent();
        stream.active = true;
        await chrome.debugger.sendCommand(target, "Page.startScreencast", {
          format: "png", everyNthFrame: 1
        });
        started = true;
        assertCurrent();
        await frame;
        assertCurrent();
        phase = `running ${action}`;
        const result = await withinDeadline(() => Promise.race([operation(), cancelled]));
        assertCurrent();
        return result;
      } finally {
        closeCapture(new Error("Rendering frame waiter closed"));
        if (started && ownsAttachment()) {
          try { await chrome.debugger.sendCommand(target, "Page.stopScreencast"); }
          catch { /* Preserve the rendered operation's original result/error. */ }
        }
        stream.active = false;
        delete stream.cancel;
      }
    });
    try {
      return await withTimeout(timeoutMs, () => queued, timeoutError);
    } finally {
      expired = true;
      closeCapture?.(timeoutError());
    }
  }

  isInternalCdpEvent(source, method, params) {
    if (method !== "Page.screencastFrame" || source.sessionId != null) return false;
    if (this.externalScreencastTabs.has(source.tabId)) return false;
    const stream = this.internalScreencasts.get(source.tabId);
    if (!stream) return false;
    if (stream.active && !stream.frameIds.includes(params.sessionId)) {
      stream.frameIds.push(params.sessionId);
      if (stream.frameIds.length > 16) stream.frameIds.shift();
    }
    return stream.active || stream.frameIds.includes(params.sessionId);
  }

  async resolveCdpTarget(params) {
    const target = params.target ?? {};
    if (typeof target !== "object" || Array.isArray(target)) {
      throw new Error("executeCdp requires a debugger target object");
    }
    if (Object.keys(target).some((key) => !["tabId", "targetId", "sessionId"].includes(key))) {
      throw new Error("executeCdp target only supports tabId, targetId and sessionId");
    }
    if ("tabId" in target && (!Number.isInteger(target.tabId) || target.tabId < 0)) {
      throw new Error("executeCdp requires a non-negative integer target.tabId");
    }
    if ("targetId" in target && (typeof target.targetId !== "string" || !target.targetId)) {
      throw new Error("executeCdp requires a non-empty target.targetId");
    }
    if ("sessionId" in target && (typeof target.sessionId !== "string" || !target.sessionId)) {
      throw new Error("executeCdp requires a non-empty target.sessionId");
    }

    let tabId = target.tabId;
    if (target.targetId !== undefined) {
      const info = (await chrome.debugger.getTargets()).find((item) => item.id === target.targetId);
      if (!Number.isInteger(info?.tabId) || info.tabId < 0) {
        throw new Error("executeCdp targetId does not identify a browser tab");
      }
      assertControllableUrl(info.url);
      if (tabId !== undefined && tabId !== info.tabId) {
        throw new Error("executeCdp target.tabId and target.targetId identify different tabs");
      }
      tabId = info.tabId;
    }
    if (tabId === undefined) {
      // Global target discovery is read-only and filtered to owned tabs by the
      // caller. Every executable command needs an explicit, owned tab root.
      if (params.method === "Target.getTargets" && Object.keys(target).length === 0) return null;
      throw new Error("executeCdp requires target.tabId or target.targetId");
    }
    await this.requireSessionTab({ ...params, tabId }, "executeCdp");
    if (!this.attachedTabs.has(tabId)) throw new Error("Debugger unattached");

    // Chrome routes a child session relative to this tab's debugger attachment.
    // Never forward a second root identifier that could change the target after
    // session ownership was checked.
    return { tabId, ...(target.sessionId === undefined ? {} : { sessionId: target.sessionId }) };
  }

  async validateCdpCommandTarget(params, target) {
    const command = params.commandParams ?? {};
    if (["Page.navigate", "Target.createTarget"].includes(params.method)) assertControllableUrl(command.url);
    if (["Target.attachToTarget", "Target.attachToBrowserTarget", "Target.sendMessageToTarget"].includes(params.method)) {
      throw new Error("OBU_CDP_TARGET_UNOWNED: use an owned tab and flat child session instead of browser-wide or tunneled target control");
    }
    if (params.method?.startsWith("Target.") && command.targetId !== undefined) {
      const info = (await chrome.debugger.getTargets()).find(info => info.id === command.targetId);
      if (!Number.isInteger(info?.tabId) || info.tabId !== target?.tabId) {
        throw new Error("OBU_CDP_TARGET_UNOWNED: command targetId does not identify the owned tab root");
      }
      assertControllableUrl(info.url);
      await this.requireSessionTab({ ...params, tabId: info.tabId }, "executeCdp command target");
    }
  }

  enqueuePointerFeedback(params) {
    if (this.automationControl.inputBlocked || this.nativeRecovery) return;
    const { target, method, commandParams: event } = params;
    const tabId = target?.tabId;
    if (
      method !== "Input.dispatchMouseEvent" ||
      !Number.isInteger(tabId) ||
      target.sessionId != null ||
      !["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"].includes(event?.type) ||
      !Number.isFinite(event.x) ||
      !Number.isFinite(event.y) ||
      !this.attachedTabs.has(tabId)
    ) {
      return;
    }

    let queue = this.pointerFeedbackByTabId.get(tabId);
    if (!queue) {
      queue = { pending: [] };
      this.pointerFeedbackByTabId.set(tabId, queue);
    }
    const previous = queue.pending.at(-1);
    if (
      event.type === "mouseMoved" && previous?.commandParams.type === "mouseMoved" &&
      previous.session_id === params.session_id && previous.turn_id === params.turn_id
    ) {
      queue.pending.pop();
    }
    // Count the in-flight job as well. Overflow drops only visual feedback,
    // never input, while retaining the most recent position.
    if (queue.pending.length >= MAX_POINTER_FEEDBACK_JOBS - 1) queue.pending.shift();
    queue.pending.push({
      session_id: params.session_id, turn_id: params.turn_id,
      target: { tabId }, commandParams: { type: event.type, x: event.x, y: event.y }
    });
    if (!queue.running) {
      queue.running = this.drainPointerFeedback(tabId, queue);
    }
  }

  async drainPointerFeedback(tabId, queue) {
    while (this.pointerFeedbackByTabId.get(tabId) === queue && queue.pending.length > 0) {
      const params = queue.pending.shift();
      await this.publishPointerFeedback(params, queue).catch(() => {});
    }
    if (this.pointerFeedbackByTabId.get(tabId) === queue) this.pointerFeedbackByTabId.delete(tabId);
  }

  clearPointerFeedback(tabId) {
    const queue = this.pointerFeedbackByTabId.get(tabId);
    if (queue) queue.pending.length = 0;
    this.pointerFeedbackByTabId.delete(tabId);
  }

  async publishPointerFeedback(params, queue) {
    const tabId = params.target.tabId;
    const event = params.commandParams;

    const previous = this.cursorByTabId.get(tabId);
    const cursor = {
      moveSequence: previous?.x === event.x && previous?.y === event.y
        ? previous.moveSequence
        : this.nextCursorMoveSequence++,
      animateMovement: false,
      visible: true,
      x: event.x,
      y: event.y
    };
    this.cursorByTabId.set(tabId, cursor);
    let expired = false;
    const isCurrent = () => !expired && !this.nativeRecovery && this.attachedTabs.has(tabId) &&
      this.pointerFeedbackByTabId.get(tabId) === queue && this.cursorByTabId.get(tabId) === cursor;
    try {
      await withTimeout(POINTER_FEEDBACK_TIMEOUT_MS, async () => {
        if (!(await this.ensureCursorContentScript(params.session_id, tabId)) || !isCurrent()) {
          return;
        }
        const proof = await this.assertSiteTab(tabId);
        this.assertSiteProof(proof);
        if (!isCurrent()) return;
        const destination = this.siteMessageDestination(proof);
        await chrome.tabs.sendMessage(tabId, {
          type: "OPEN_BROWSER_USE_CURSOR",
          sessionId: params.session_id,
          turnId: params.turn_id,
          ...cursor
        }, destination);
        if (event.type === "mousePressed" && isCurrent()) {
          this.assertSiteProof(proof);
          await chrome.tabs.sendMessage(tabId, {
            type: "OPEN_BROWSER_USE_POINTER_EVENT",
            sessionId: params.session_id,
            turnId: params.turn_id,
            eventType: event.type,
            x: event.x,
            y: event.y
          }, destination);
        }
      });
    } finally {
      // Ignore a slow injection that finishes after a newer move or turn end.
      expired = true;
    }
  }

  async webmcp_list_tools(params) {
    const tabId = requireWebMcpTabId(params, "webmcp_list_tools");
    await this.requireSessionTab({ ...params, tabId }, "webmcp_list_tools");
    await this.requireWebMcpEnabled();
    const result = await this.sendWebMcpRequest(
      tabId,
      { action: "list" },
      DEFAULT_WEBMCP_LIST_TIMEOUT_MS + WEBMCP_TIMEOUT_GRACE_MS
    );
    if (!result || typeof result !== "object" || !Array.isArray(result.tools)) {
      throw new Error("WebMCP list response did not include tools");
    }
    return result;
  }

  async webmcp_invoke_tool(params) {
    const tabId = requireWebMcpTabId(params, "webmcp_invoke_tool");
    await this.requireSessionTab({ ...params, tabId }, "webmcp_invoke_tool");
    await this.requireWebMcpEnabled();
    const toolName = requireNonEmptyString(params.tool_name, "webmcp_invoke_tool requires tool_name");
    const registrationId = requireNonEmptyString(
      params.registration_id,
      "webmcp_invoke_tool requires registration_id"
    );
    if (!Object.hasOwn(params, "input")) {
      throw new Error("webmcp_invoke_tool requires input");
    }
    const timeoutMs = optionalPositiveInteger(
      params.timeout_ms,
      DEFAULT_WEBMCP_TIMEOUT_MS,
      "webmcp_invoke_tool timeout_ms"
    );
    const result = await this.sendWebMcpRequest(
      tabId,
      {
        action: "invoke",
        tool_name: toolName.trim(),
        ...(typeof params.tool_description === "string"
          ? { tool_description: params.tool_description }
          : {}),
        ...(typeof params.tool_title === "string" ? { tool_title: params.tool_title } : {}),
        registration_id: registrationId.trim(),
        input: params.input,
        timeout_ms: timeoutMs
      },
      timeoutMs + WEBMCP_TIMEOUT_GRACE_MS
    );
    if (!result || typeof result !== "object" || !Object.hasOwn(result, "result")) {
      throw new Error("WebMCP invoke response did not include result");
    }
    return result;
  }

  async moveMouse(params) {
    const session = await this.requireSession(params);
    await this.requireSessionTab(params, "moveMouse");
    const tabId = requireTabId(params, "moveMouse");
    if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) {
      throw new Error("moveMouse requires finite x and y");
    }
    this.clearPointerFeedback(tabId);
    const cursorReady = await this.ensureCursorContentScript(session.sessionId, tabId);
    if (!cursorReady) {
      throw new Error(`Cannot inject cursor content script into tab ${tabId}`);
    }
    this.controlLedger.assertCurrent(params);
    const moveSequence = this.nextCursorMoveSequence;
    this.nextCursorMoveSequence += 1;
    const cursor = {
      moveSequence,
      visible: true,
      x: params.x,
      y: params.y
    };
    this.cursorByTabId.set(tabId, cursor);
    const arrivalWaiter =
      params.waitForArrival === false
        ? null
        : this.createCursorArrivalWaiter(params.session_id, params.turn_id, moveSequence);
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "OPEN_BROWSER_USE_CURSOR",
        sessionId: params.session_id,
        turnId: params.turn_id,
        moveSequence,
        x: cursor.x,
        y: cursor.y,
        visible: cursor.visible
      });
      await arrivalWaiter?.promise;
      this.controlLedger.assertCurrent(params);
    } catch (error) {
      arrivalWaiter?.cancel();
      throw error;
    }
  }

  transferDeadline(params) {
    const timeoutMs = params.timeoutMs === undefined ? DEFAULT_CDP_TIMEOUT_MS : params.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("timeoutMs must be an integer between 1 and 120000");
    return Date.now() + timeoutMs;
  }

  async withinTransferDeadline(deadline, operation) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("OBU_TRANSFER_TIMEOUT: transfer deadline expired");
    return withTimeout(remaining, operation, () => new Error("OBU_TRANSFER_TIMEOUT: transfer deadline expired"));
  }

  rememberAttachmentOwner(params, tabId) {
    if (!this.attachedTabs.has(tabId) || !this.attachmentEpochs.has(tabId)) return;
    const record = this.controlLedger.assertCurrent(params);
    const previous = this.attachmentOwners.get(tabId);
    if (previous?.session_id === params.session_id && previous.turn_id === params.turn_id && previous.control_epoch === record.epoch && previous.attachment === this.attachmentEpochs.get(tabId)) return;
    this.attachmentOwners.set(tabId, { session_id: params.session_id, turn_id: params.turn_id,
      control_epoch: record.epoch, tabId, attachment: this.attachmentEpochs.get(tabId) });
  }

  assertTransferScope(scope) {
    this.controlLedger.assertCurrent(scope);
    if (this.siteAccess.restricted && this.siteRevokedTabs.has(scope.tabId)) throw new Error("OBU_SITE_ACCESS_DENIED: document access was revoked");
    if (!this.attachedTabs.has(scope.tabId) || this.attachmentEpochs.get(scope.tabId) !== scope.attachment) {
      throw new Error("OBU_TRANSFER_CANCELLED: browser attachment changed");
    }
  }

  async validateTransferScope(scope) {
    this.assertTransferScope(scope);
    const tabs = await this.getSessionTabs(scope.session_id, { strict: true });
    this.assertTransferScope(scope);
    const tab = tabs.find(tab => tab.id === scope.tabId);
    if (!tab) {
      throw new Error("Transfer tab is no longer owned by this session");
    }
    assertControllableTab(tab);
  }

  async transferScope(params, command, deadline) {
    await this.withinTransferDeadline(deadline, () => this.requireSessionTab(params, command));
    if (!this.attachedTabs.has(params.tabId)) await this.prepareTransferAttachment(params, deadline);
    await this.withinTransferDeadline(deadline, () => this.requireSessionTab(params, command));
    if (deadline <= Date.now()) throw new Error("OBU_TRANSFER_TIMEOUT: transfer deadline expired");
    this.rememberAttachmentOwner(params, params.tabId);
    return { ...this.attachmentOwners.get(params.tabId) };
  }

  async prepareTransferAttachment(params, deadline, options = {}) {
    let engine, generation, attaching = false, ownsPending = false;
    const timeoutError = () => new Error("OBU_TRANSFER_TIMEOUT: transfer deadline expired");
    const remainingMs = () => { const remaining = deadline - Date.now(); if (remaining <= 0) throw timeoutError(); return remaining; };
    const check = () => { remainingMs(); options.check?.(); };
    const cancelPending = () => {
      if (attaching && ownsPending && (engine.generations?.get(params.tabId) ?? 0) === generation)
        return engine.detach(params.tabId);
    };
    try {
      await this.withinTransferDeadline(deadline, async () => {
        check();
        await this.requireSessionTab(params, "transfer attachment");
        check();
        engine = await this.getBrowserEngine();
        check();
        await this.releasePreviousAttachmentOwner(params, params.tabId, check, options);
        check();
        await this.requireSessionTab(params, "transfer attachment");
        check();
        if (Date.now() >= deadline) throw new Error("OBU_TRANSFER_TIMEOUT: transfer deadline expired");
        generation = engine.generations?.get(params.tabId) ?? 0;
        attaching = true;
        const actualAttach = engine.attach(params.tabId, generation, () => { check(); ownsPending = true; }, {
          params, remainingMs, timeoutError,
          check: async () => { check(); await this.requireSessionTab(params, "transfer attachment"); check(); }
        });
        options.onAttachStarted?.(() => {
          const release = cancelPending();
          release?.catch(() => {});
          return release;
        }, actualAttach);
        await actualAttach;
        attaching = false;
        check();
        await this.requireSessionTab(params, "transfer attachment");
        check();
        this.rememberAttachmentOwner(params, params.tabId);
      });
    } catch (error) {
      // Only the pending attachment this setup initiated may be cancelled.
      // Retain the engine's release barrier without waiting indefinitely for a
      // native attachment that has already exceeded this request's deadline.
      cancelPending()?.catch(() => {});
      throw error;
    }
  }

  cancelTabTransfers(tabId, error, { attachedOnly = false } = {}) {
    this.directoryUploads.cancelWhere(record => record.identity.tabId === tabId, error);
    if (attachedOnly) void this.fileChooserWaits.invalidateAttachedTab(tabId, error).catch(() => {});
    else void this.fileChooserWaits.invalidateTab(tabId, error).catch(() => {});
    if (attachedOnly) void this.downloadWaits.invalidateAttachedTab(tabId, error).catch(() => {});
    else void this.downloadWaits.invalidateTab(tabId, error).catch(() => {});
    if (attachedOnly) void this.pageWaits.invalidateAttachedTab(tabId, error).catch(() => {});
    else void this.pageWaits.invalidateTab(tabId, error).catch(() => {});
    for (const [id, record] of this.downloadsById) if (record.scope.tabId === tabId) this.retirePageDownload(id);
    for (const [id, chooser] of this.fileChoosersById) if (chooser.scope.tabId === tabId) this.fileChoosersById.delete(id);
  }

  waitForFileChooser(params) { return this.startFileChooserWait(params, { legacy: true }); }

  async startFileChooserWait(params, { legacy = false } = {}) {
    // Reserve synchronously before controlReady. A same-connection click sees
    // this exact setup even when the engine/native attachment is still cold.
    const record = this.fileChooserWaits.reserve(params, { legacy });
    const setup = { sessionId: params.session_id, promise: record.ready.promise, reject: error => this.fileChooserWaits.fail(record, error) };
    this.fileChooserSetupsByTabId.set(params.tabId, setup);
    try {
      const ack = await this.fileChooserWaits.within(record, () => this.runControlledRequest(() => {
        this.assertSiteMethod("armFileChooserWait", record.params);
        return BrowserBackend.prototype.armFileChooserWait.call(this, record.params, record);
      }));
      if (!legacy) return ack;
      const { session_id, turn_id, control_epoch, tabId } = record.params;
      return await this.runControlledRequest(() => this.fileChooserWaits.collect({ session_id, turn_id, control_epoch, tabId, waiterId: record.waiterId }));
    } catch (error) { this.fileChooserWaits.fail(record, error); throw error; }
    finally { if (this.fileChooserSetupsByTabId.get(params.tabId) === setup) this.fileChooserSetupsByTabId.delete(params.tabId); }
  }

  async armFileChooserWait(params, record) {
    const check = () => this.fileChooserWaits.check(record);
    await this.fileChooserWaits.within(record, () => this.controlReleases.get(params.tabId));
    await this.prepareTransferAttachment(params, record.deadlineAt, { check, preserveChooserRecord: record,
      onAttachStarted: cancel => { record.cancelAdmission = cancel; } });
    check();
    const scope = await this.transferScope(params, "armFileChooserWait", record.deadlineAt);
    check();
    this.fileChooserWaits.bind(record, scope);
    return this.fileChooserWaits.arm(record, [undefined, ...this.childSessionsByTabId.get(params.tabId) ?? []]);
  }

  async collectFileChooserWait(params) {
    await this.requireSessionTab(params, "collectFileChooserWait");
    return this.fileChooserWaits.collect(params);
  }

  async cancelFileChooserWait(params) {
    await this.requireSessionTab(params, "cancelFileChooserWait");
    return this.fileChooserWaits.cancel(params);
  }

  enableFileChooserTarget(waiter, sessionId) { return this.fileChooserWaits.enable(waiter, sessionId); }

  async waitForChooserTargets(tabId) {
    const record = this.fileChooserWaitersByTabId.get(tabId);
    if (record && ["reserved", "arming", "pending"].includes(record.state)) await this.fileChooserWaits.barrier(record);
  }

  async waitForTransferTargets(tabId) {
    await this.waitForChooserTargets(tabId);
    const record = this.downloadWaits.byTab.get(tabId);
    if (record && ["reserved", "arming", "pending"].includes(record.state)) await this.downloadWaits.barrier(record);
  }

  async setFileChooserFiles(params, deadlineAt = Date.now() + 10000) {
    await this.requireSession(params);
    if (typeof params.fileChooserId !== "string" || !params.fileChooserId) throw new Error("setFileChooserFiles requires fileChooserId");
    const chooser = this.fileChoosersById.get(params.fileChooserId);
    if (!chooser || chooser.scope.session_id !== params.session_id) throw new Error("Unknown or unowned file chooser id");
    this.assertTransferScope(chooser.scope);
    await this.requireSessionTab({ ...params, tabId: chooser.scope.tabId }, "setFileChooserFiles");
    if (!Array.isArray(params.files) || params.files.some(file => typeof file !== "string" || !file)) throw new Error("setFileChooserFiles requires an array of non-empty file paths");
    if (!chooser.isMultiple && params.files.length > 1) throw new Error("File chooser does not accept multiple files");
    const checkAuthority = () => {
      this.assertControlOpen();
      this.assertAttachmentAdmission(chooser.scope.tabId, chooser.scope.attachment);
      this.assertTransferScope(chooser.scope);
    };
    const check = () => {
      if (Date.now() >= deadlineAt) throw new Error("OBU_DIRECTORY_UPLOAD_TIMEOUT: original file submission deadline expired");
      checkAuthority();
      if (this.fileChoosersById.get(params.fileChooserId) !== chooser) throw new Error("File chooser became stale");
    };
    checkAuthority();
    if (chooser.submitted) throw new Error("OBU_FILE_CHOOSER_CONSUMED: file chooser already submitted");
    check();
    // Claim before the first native await. A rejected or lost acknowledgement
    // cannot prove the file selection had no side effects, so never reopen it.
    chooser.submitted = true;
    try {
      const documents = this.fileInputDocumentsByTabId.get(chooser.scope.tabId) ?? new Map();
      if (!documents.has(chooser.frameId)) documents.set(chooser.frameId, {});
      this.fileInputDocumentsByTabId.set(chooser.scope.tabId, documents);
      return await this.submitFileInput({ chooser, files: params.files, deadlineAt, check, checkAuthority, documentToken: documents.get(chooser.frameId) });
    } finally {
      if (this.fileChoosersById.get(params.fileChooserId) === chooser) this.fileChoosersById.delete(params.fileChooserId);
    }
  }

  prepareLocatorFileInput({ params, identity, deadlineAt, check: actionCheck }) {
    // Legacy requests omit the wire epoch; freeze the already-admitted ledger
    // epoch synchronously, before any node or permission inspection can await.
    const epoch = this.controlLedger.assertCurrent(params).epoch;
    const scope = this.attachmentOwners.get(params.tabId);
    if (!scope || scope.session_id !== params.session_id || scope.turn_id !== params.turn_id || scope.control_epoch !== epoch ||
        identity.target.tabId !== params.tabId || typeof identity.check !== "function") throw new Error("OBU_FILE_INPUT_CHANGED: original attachment is unavailable");
    identity.check();
    const documents = this.fileInputDocumentsByTabId.get(params.tabId) ?? new Map();
    if (!documents.has(identity.frameId)) documents.set(identity.frameId, {});
    this.fileInputDocumentsByTabId.set(params.tabId, documents);
    // Capture before describeNode or permission inspection can await. An old
    // frame id must never be paired with a replacement document's token.
    const documentToken = documents.get(identity.frameId);
    let proof, proofReady = false, submitted = false;
    const checkAuthority = () => {
      this.assertControlOpen();
      this.assertAttachmentAdmission(params.tabId, scope.attachment);
      this.assertTransferScope(scope);
    };
    const check = () => {
      actionCheck(); checkAuthority(); identity.check();
      if (this.fileInputDocumentsByTabId.get(params.tabId)?.get(identity.frameId) !== documentToken ||
          (identity.target.sessionId && !this.childSessionsByTabId.get(params.tabId)?.has(identity.target.sessionId)))
        throw new Error("OBU_FILE_INPUT_CHANGED: original document or child attachment changed");
      if (proofReady) this.assertSiteProof(proof);
    };
    check();
    const wallDeadline = Date.now() + Math.max(0, deadlineAt - performance.now());
    return { check, submit: async (backendNodeId, files) => {
      if (submitted) throw new Error("OBU_FILE_INPUT_CONSUMED: locator input was already submitted");
      submitted = true;
      check();
      proof = await this.assertSiteTab(params.tabId);
      proofReady = true;
      check();
      return this.submitFileInput({ chooser: { scope, target: identity.target, frameId: identity.frameId, backendNodeId },
        files, deadlineAt: wallDeadline, check, checkAuthority, documentToken });
    } };
  }

  async submitFileInput({ chooser, files, deadlineAt, check, checkAuthority, documentToken }) {
    let submission;
    try {
      submission = this.directoryUploads.reserve({
        identity: { tabId: chooser.scope.tabId, attachment: chooser.scope.attachment, ...chooser.target,
          frameId: chooser.frameId, backendNodeId: chooser.backendNodeId, documentToken },
        scope: chooser.scope, deadlineAt, check,
        validate: async () => { checkAuthority(); await this.validateTransferScope(chooser.scope); checkAuthority(); }
      });
      const input = await this.directoryUploads.prepare(submission);
      check();
      if (files.length > 0 && input.directory) {
        const directory = files[0];
        if (files.length !== 1 || directory.includes("\0") ||
            !(/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(directory)))
          throw new Error("Directory upload requires exactly one absolute directory path");
        await this.directoryUploads.submit(submission, files);
      } else {
        if (files.length > 1 && !input.multiple) throw new Error("File chooser does not accept multiple files");
        await this.directoryUploads.write(submission, async () => {
          check();
          if (files.length === 0) {
            const result = await chrome.debugger.sendCommand(chooser.target, "Runtime.callFunctionOn", {
              objectId: submission.nodeObjectId,
              functionDeclaration: 'function() { if (this.tagName.toLowerCase() !== "input" || this.type !== "file") throw new Error("File chooser node is not a file input"); this.value = ""; this.dispatchEvent(new Event("input", {bubbles: true})); this.dispatchEvent(new Event("change", {bubbles: true})); return this.files.length; }',
              returnByValue: true
            });
            if (result.exceptionDetails || result.result?.value !== 0) throw new Error("Unable to clear file chooser input");
          } else {
            await chrome.debugger.sendCommand(chooser.target, "DOM.setFileInputFiles", { backendNodeId: chooser.backendNodeId, files });
          }
        });
      }
      // A successful file change can submit a form and navigate. The old node
      // need not survive an acknowledged write, but its authority must.
      checkAuthority();
      await this.validateTransferScope(chooser.scope);
      checkAuthority();
    } catch (error) {
      if (submission) this.directoryUploads.cancelWhere(record => record === submission, error);
      throw error;
    }
  }

  async startPageWait(params) {
    const record = this.pageWaits.reserve(params);
    try {
      return await this.pageWaits.within(record, () => this.runControlledRequest(() => {
        this.assertSiteMethod("armPageWait", record.params);
        return BrowserBackend.prototype.armPageWait.call(this, record.params, record);
      }));
    } catch (error) { this.pageWaits.fail(record, error); throw error; }
  }

  async armPageWait(params, record) {
    const check = () => this.pageWaits.check(record);
    await this.pageWaits.within(record, () => this.controlReleases.get(params.tabId));
    // The registry's monotonic deadline remains authoritative across the
    // existing attachment adapter's wall-clock budget and every late ACK.
    const deadline = Date.now() + Math.max(1, Math.floor(record.deadlineAt - this.pageWaits.now()));
    await this.pageWaits.within(record, () => this.prepareTransferAttachment(params, deadline, {
      check, preservePageWait: record,
      onAttachStarted: (cancel, actual) => { record.cancelAdmission = cancel; this.pageWaits.track(record, actual); }
    }));
    check();
    const scope = await this.pageWaits.within(record, () => this.transferScope(params, "armPageWait", deadline));
    check();
    this.pageWaits.bind(record, { ...scope, controlRevision: this.automationControl.revision });
    return this.pageWaits.arm(record);
  }

  async collectPageWait(params) {
    const record = this.pageWaits.lookup(params);
    await this.pageWaits.within(record, () => this.requireSessionTab(params, "collectPageWait"));
    return this.pageWaits.collect(params);
  }

  async cancelPageWait(params) {
    await this.requireSession(params);
    return this.pageWaits.cancel(params);
  }

  async validateCreatedPage(record) {
    const expected = record.pageResult;
    const check = () => this.pageWaits.check(record);
    check();
    const tab = await chrome.tabs.get(expected.tabId); check();
    assertControllableTab(tab);
    if (tab.windowId !== expected.windowId || tab.groupId !== expected.groupId || tab.pinned)
      throw new Error("OBU_PAGE_WAIT_EXPIRED: native child moved or became pinned");
    const proof = await this.assertSiteTab(tab.id, { allowBlank: true }); check();
    this.assertSiteProof(proof);
    const auxiliary = this.auxiliaryTabs.entry(tab.id);
    if (expected.claim ? this.auxiliaryTabs.owner(tab.id) !== expected.claim : auxiliary !== undefined)
      throw new Error("OBU_PAGE_WAIT_EXPIRED: native child ownership changed");
    const tabs = await this.getSessionTabs(record.params.session_id, { strict: true }); check();
    if (!tabs.some(value => value.id === tab.id)) throw new Error("OBU_PAGE_WAIT_EXPIRED: native child is no longer owned");
    return tab;
  }

  async adoptCreatedPage(scope, event, record) {
    return this.runSessionMutation(scope, () => this.admitSessionMembership(scope.session_id, async () => {
      const check = () => this.pageWaits.check(record);
      check();
      await this.auxiliaryTabs.ready; check();
      const tab = await chrome.tabs.get(event.tabId); check();
      assertControllableTab(tab);
      this.siteAccess.assertUrl(event.url, { allowBlank: true });
      if (tab.pinned) throw new Error("OBU_PAGE_WAIT_EXPIRED: native child became pinned");
      const proof = await this.assertSiteTab(tab.id, { allowBlank: true }); check(); this.assertSiteProof(proof);
      const window = await chrome.windows.get(tab.windowId); check();
      if (!["normal", "popup"].includes(window.type)) throw new Error("OBU_PAGE_WAIT_FAILED: unsupported native child window");
      const state = await this.store.getSession(scope.session_id); check();
      let claim = this.auxiliaryTabs.entry(tab.id);
      if (claim && (this.auxiliaryTabs.owner(tab.id) !== claim || claim.session_id !== scope.session_id))
        throw new Error("OBU_PAGE_WAIT_EXPIRED: native child has another or pending owner");
      if (tab.groupId !== -1) {
        if (claim || tab.groupId !== state.chromeGroupId)
          throw new Error("OBU_PAGE_WAIT_EXPIRED: native child belongs to another group");
      } else if (!claim) {
        // A separate kind preserves the grouped source and original native
        // window; ordinary fallback claims intentionally switch group mode.
        claim = this.auxiliaryTabs.reserve({ ...scope, tabId: tab.id });
        record.pageAdmission = claim;
        const validate = async () => {
          check();
          const live = await chrome.tabs.get(tab.id); check();
          assertControllableTab(live);
          if (live.windowId !== tab.windowId || live.groupId !== -1 || live.pinned)
            throw new Error("OBU_PAGE_WAIT_EXPIRED: native child moved during adoption");
          const currentProof = await this.assertSiteTab(tab.id, { allowBlank: true }); check(); this.assertSiteProof(currentProof);
          await this.validateTransferScope(scope); check();
        };
        await this.auxiliaryTabs.commit(claim, { windowId: tab.windowId, kind: "created-page",
          control_epoch: scope.control_epoch, controlRevision: scope.controlRevision, check, validate });
        check();
      }
      record.pageResult = { tabId: tab.id, windowId: tab.windowId, groupId: tab.groupId, claim };
      await this.validateCreatedPage(record); check();
      return { tabId: tab.id };
    }));
  }

  waitForDownload(params) { return this.startDownloadWait(params, { legacy: true }); }

  async startDownloadWait(params, { legacy = false } = {}) {
    const record = this.downloadWaits.reserve(params, { legacy });
    try {
      const ack = await this.downloadWaits.within(record, () => this.runControlledRequest(() => {
        this.assertSiteMethod("armDownloadWait", record.params);
        return BrowserBackend.prototype.armDownloadWait.call(this, record.params, record);
      }));
      if (!legacy) return ack;
      const { session_id, turn_id, control_epoch, tabId } = record.params;
      return await this.runControlledRequest(() => this.downloadWaits.collect({ session_id, turn_id, control_epoch, tabId, waiterId: record.waiterId }));
    } catch (error) { this.downloadWaits.fail(record, error); throw error; }
  }

  async armDownloadWait(params, record) {
    const check = () => this.downloadWaits.check(record);
    await this.downloadWaits.within(record, () => this.controlReleases.get(params.tabId));
    await this.prepareTransferAttachment(params, record.deadlineAt, { check, preserveDownloadWait: record,
      onAttachStarted: (cancel, actual) => { record.cancelAdmission = cancel; this.downloadWaits.track(record, actual); } });
    check();
    const scope = await this.transferScope(params, "armDownloadWait", record.deadlineAt);
    check(); this.downloadWaits.bind(record, scope);
    const client = this.nativePageDownloads?.();
    const status = client?.status();
    if (status?.available) {
      const targets = await this.downloadWaits.within(record, () => chrome.debugger.getTargets());
      const target = targets.find(target => target.tabId === scope.tabId && target.type === "page");
      if (!target?.id || this.nativePageDownloads?.() !== client || !client.status().available || client.status().generation !== status.generation)
        throw new Error("OBU_DOWNLOAD_PATH_UNAVAILABLE: original Browser connection changed while arming");
      record.nativeContext = Object.freeze({ client, generation: status.generation, rootTargetId: target.id });
    }
    return this.downloadWaits.arm(record, [undefined, ...this.childSessionsByTabId.get(params.tabId) ?? []]);
  }

  async collectDownloadWait(params) {
    await this.requireSessionTab(params, "collectDownloadWait");
    return this.downloadWaits.collect(params);
  }

  async cancelDownloadWait(params) {
    await this.requireSessionTab(params, "cancelDownloadWait");
    return this.downloadWaits.cancel(params);
  }

  async downloadURL(params, record) {
    this.directDownloads.check(record);
    await this.withinTransferDeadline(record.deadlineAt, () => this.controlReleases.get(params.tabId));
    this.directDownloads.check(record);
    // Establish CRX first: a later engine action must not migrate away from
    // the raw attachment that owns a newly returned download handle.
    await this.prepareTransferAttachment(params, record.deadlineAt, { preserveDirectRecord: record, check: () => this.directDownloads.check(record) });
    this.directDownloads.check(record);
    const scope = await this.transferScope(params, "downloadURL", record.deadlineAt);
    this.directDownloads.check(record);
    return this.directDownloads.start(record, scope);
  }

  assertDirectDownloadScope(scope) {
    this.assertTransferScope(scope);
    if (!scope.mediaDownload) return;
    this.assertSiteMethod("downloadMedia", scope);
    if (scope.documentRevision !== (this.exportDocumentRevisions.get(scope.tabId) ?? 0))
      throw new Error("OBU_MEDIA_DOCUMENT_CHANGED: media source document changed");
  }

  async validateDirectDownloadScope(scope) {
    if (!scope.mediaDownload) return this.validateTransferScope(scope);
    this.assertDirectDownloadScope(scope);
    const sourceURL = await this.ownedDocumentSource(scope, "MEDIA");
    this.assertDirectDownloadScope(scope);
    if (sourceURL !== scope.sourceURL) throw new Error("OBU_MEDIA_DOCUMENT_CHANGED: media source document changed");
  }

  async downloadMedia(params, record) {
    const check = () => this.directDownloads.check(record);
    check();
    await this.controlReleases.get(params.tabId);
    check();
    await this.requireSessionTab(params, "downloadMedia");
    check();
    await this.prepareTransferAttachment(params, record.deadlineAt, { preserveDirectRecord: record, check });
    check();
    const documentRevision = this.exportDocumentRevisions.get(params.tabId) ?? 0;
    const sourceURL = await this.ownedDocumentSource(params, "MEDIA");
    check();
    const scope = { ...this.attachmentOwners.get(params.tabId), mediaDownload: true, documentRevision, sourceURL };
    this.assertDirectDownloadScope(scope);
    const engine = await this.getBrowserEngine();
    check();
    return this.directDownloads.startFromSource(record, scope, options => engine.resolveMediaSource(params, {
      deadlineAt: performance.now() + Math.max(0, options.deadlineAt - Date.now()),
      onCancel: options.onCancel,
      check: async () => { options.check(); await this.directDownloads.validate(record); options.check(); }
    }));
  }

  invalidatePageExportDocument(tabId) {
    if (!this.attachedTabs.has(tabId) && !this.pendingAttachmentTabs.has(tabId)) return;
    this.exportDocumentRevisions.set(tabId, (this.exportDocumentRevisions.get(tabId) ?? 0) + 1);
    void this.directDownloads.invalidate(record => record.params.tabId === tabId && record.scope?.mediaDownload).catch(() => {});
    // Initial CRX frame discovery must not cancel an unbound reservation. Once
    // export starts, every root/child document change invalidates the artifact.
    void this.pageExports.invalidateAttachedTab(tabId,
      new Error("OBU_EXPORT_DOCUMENT_CHANGED: page documents changed during export")).catch(() => {});
    void this.clipboard.invalidateAttachedTab(tabId,
      new Error("OBU_CLIPBOARD_DOCUMENT_CHANGED: clipboard authorization document changed")).catch(() => {});
  }

  async pageExportSource(params) {
    return this.ownedDocumentSource(params, "EXPORT");
  }

  async ownedDocumentSource(params, feature) {
    await this.auxiliaryTabs.ready;
    const session = await this.store.getSession(params.session_id);
    const claim = this.auxiliaryTabs.entry(params.tabId);
    const tab = await chrome.tabs.get(params.tabId);
    this.controlLedger.assertCurrent(params);
    const unowned = () => new Error(`OBU_${feature}_CANCELLED: tab is no longer owned by this session`);
    if (!tab || this.auxiliaryTabs.entry(params.tabId) !== claim) throw unowned();
    if (claim && claim.windowId !== null) {
      if (claim.session_id !== params.session_id || this.auxiliaryTabs.owner(params.tabId) !== claim) throw unowned();
      if (tab.windowId !== claim.windowId || tab.groupId !== -1 || (["ordinary", "background-window", "created-page"].includes(claim.kind) && tab.pinned)) {
        // Never await cleanup from inside an export scope check: detach must
        // drain this same native flow. Quarantine synchronously and reject so
        // that flow can unwind, then let its exact cleanup finish independently.
        void this.releaseAuxiliaryClaim(claim).catch(() => {});
        throw unowned();
      }
    } else if (typeof session.chromeGroupId !== "number" || tab.groupId !== session.chromeGroupId) throw unowned();
    assertControllableTab(tab);
    let url;
    try { url = new URL(tab.url); } catch {}
    if (!url || !["http:", "https:"].includes(url.protocol))
      throw new Error(`OBU_${feature}_UNSUPPORTED: operation requires an owned HTTP(S) document`);
    return tab.url;
  }

  assertPageExportScope(scope) {
    this.assertTransferScope(scope);
    this.assertSiteMethod("exportPage", scope);
    if (scope.documentRevision !== (this.exportDocumentRevisions.get(scope.tabId) ?? 0))
      throw new Error("OBU_EXPORT_DOCUMENT_CHANGED: page documents changed during export");
    this.assertSiteProof(scope.siteProof);
  }

  async validatePageExportScope(scope) {
    this.assertPageExportScope(scope);
    const sourceURL = await this.pageExportSource(scope);
    this.assertPageExportScope(scope);
    if (sourceURL !== scope.sourceURL) throw new Error("OBU_EXPORT_DOCUMENT_CHANGED: export source changed");
    const proof = await this.assertSiteTab(scope.tabId);
    this.assertPageExportScope(scope);
    this.assertSiteProof(proof);
  }

  async sendPageExportCommand(scope, method, args, { cleanup = false, check = () => {} } = {}) {
    if (cleanup) {
      // Cleanup can outlive the control epoch/document, but never target a
      // replacement attachment. detachTab waits for this exact stream first.
      if (method !== "IO.close" || !this.attachedTabs.has(scope.tabId) || this.attachmentEpochs.get(scope.tabId) !== scope.attachment)
        throw new Error("OBU_EXPORT_CLEANUP_FAILED: original browser attachment is unavailable");
    } else {
      await this.validatePageExportScope(scope);
      this.assertPageExportScope(scope);
      check();
    }
    // Do not check scope after this native promise: the registry must capture
    // a late print stream before rejecting it, otherwise its handle is lost.
    return chrome.debugger.sendCommand({ tabId: scope.tabId }, method, args);
  }

  async exportPage(params, record) {
    const check = () => this.pageExports.check(record);
    check();
    await this.controlReleases.get(params.tabId);
    check();
    await this.requireSessionTab(params, "exportPage");
    check();
    await this.pageExportSource(params);
    check();
    await this.prepareTransferAttachment(params, record.deadlineAt, { preserveExportRecord: record, check });
    check();
    const owner = { ...this.attachmentOwners.get(params.tabId) };
    const documentRevision = this.exportDocumentRevisions.get(params.tabId) ?? 0;
    const sourceURL = await this.pageExportSource(params);
    check();
    const siteProof = await this.assertSiteTab(params.tabId);
    check();
    const scope = { ...owner, documentRevision, sourceURL, siteProof, format: params.format };
    this.assertPageExportScope(scope);
    return this.pageExports.run(record, scope);
  }

  async cancelDownload(params, deadline) {
    if (deadline <= Date.now()) throw new Error("OBU_DOWNLOAD_TIMEOUT: download operation deadline expired");
    await this.requireSession(params);
    if (this.downloadsById.has(params.downloadId)) {
      const record = this.downloadsById.get(params.downloadId);
      if (record.scope.session_id !== params.session_id) throw new Error("OBU_DOWNLOAD_EXPIRED: unknown or unowned download");
      if (!record.nativeContext) {
        await this.withinTransferDeadline(deadline, () => this.validateTransferScope(record.scope));
        this.assertTransferScope(record.scope);
        throw new Error("OBU_DOWNLOAD_CANCEL_UNSUPPORTED: original Browser connection was not bound when this download was armed");
      }
      return this.pageDownloadOperation(record, params, "cancel", deadline);
    }
    return this.directDownloads.cancel(params, deadline);
  }

  async downloadPath(params, deadline) {
    if (deadline <= Date.now()) throw new Error("OBU_DOWNLOAD_TIMEOUT: download operation deadline expired");
    await this.requireSession(params);
    if (this.directDownloads.has(params.downloadId)) return this.directDownloads.path(params, deadline);
    const record = this.downloadsById.get(params.downloadId);
    if (!record || record.scope.session_id !== params.session_id) throw new Error("OBU_DOWNLOAD_EXPIRED: Unknown or unowned download id");
    if (!record.nativeContext) {
      this.assertTransferScope(record.scope);
      await this.requireSessionTab({ ...params, tabId: record.scope.tabId }, "downloadPath");
      throw new Error("OBU_DOWNLOAD_PATH_UNAVAILABLE: Chrome's tab-scoped download events do not expose a proven local path");
    }
    return this.pageDownloadOperation(record, params, "path", deadline);
  }

  assertPageDownload(record, deadline) {
    if (deadline <= Date.now()) throw new Error("OBU_DOWNLOAD_TIMEOUT: download operation deadline expired");
    this.assertTransferScope(record.scope);
    if (!record.authorized || this.downloadsById.get(record.id) !== record)
      throw new Error("OBU_DOWNLOAD_EXPIRED: original Page download has been revoked");
    const native = record.nativeContext, status = native?.client.status();
    if (!native || this.nativePageDownloads?.() !== native.client || !status.available || status.generation !== native.generation)
      throw new Error("OBU_DOWNLOAD_PATH_UNAVAILABLE: original Browser connection is no longer available");
  }

  claimPageDownload(record, deadline) {
    if (!record.nativeContext) return;
    record.nativeClaim = Object.freeze({ guid: record.id, frameId: record.frameId, rootTargetId: record.nativeContext.rootTargetId,
      session_id: record.scope.session_id, turn_id: record.scope.turn_id, control_epoch: record.scope.control_epoch,
      tabId: record.scope.tabId, claimId: crypto.randomUUID() });
    record.nativeClaimPromise = Promise.resolve().then(() => {
      this.assertPageDownload(record, deadline);
      return record.nativeContext.client.request("claim", record.nativeClaim, { deadlineAt: deadline });
    });
    // The begin event remains usable even when the optional native claim fails.
    // path/cancel report that original failure without replaying a claim.
    record.nativeClaimPromise.catch(() => {});
  }

  async pageDownloadOperation(record, params, operation, deadline) {
    const check = () => this.assertPageDownload(record, deadline);
    check();
    await this.withinTransferDeadline(deadline, () => this.requireSessionTab({ ...params, tabId: record.scope.tabId }, operation === "path" ? "downloadPath" : "cancelDownload"));
    check();
    if (!record.nativeClaimPromise) throw new Error("OBU_DOWNLOAD_EXPIRED: original Page claim is absent");
    await this.withinTransferDeadline(deadline, () => record.nativeClaimPromise);
    await this.withinTransferDeadline(deadline, () => this.validateTransferScope(record.scope));
    check();
    const result = await record.nativeContext.client.request(operation, record.nativeClaim, { deadlineAt: deadline });
    await this.withinTransferDeadline(deadline, () => this.validateTransferScope(record.scope));
    check();
    return result;
  }

  retirePageDownload(id) {
    const record = this.downloadsById.get(id);
    if (!record) return;
    this.downloadsById.delete(id);
    if (!record.nativeClaimPromise) return;
    // Release follows the original claim's settlement, so an in-flight claim
    // cannot arrive after release and restore authority. No browser cancellation.
    const release = () => {
      const native = record.nativeContext, status = native.client.status();
      if (this.nativePageDownloads?.() === native.client && status.available && status.generation === native.generation)
        return native.client.request("release", record.nativeClaim, { deadlineAt: Date.now() + 10000 });
    };
    record.nativeClaimPromise.then(release, release).catch(() => {});
  }

  readClipboardText(params, record) { return this.clipboardOperation("readClipboardText", params, record); }
  writeClipboardText(params, record) { return this.clipboardOperation("writeClipboardText", params, record); }
  readClipboard(params, record) { return this.clipboardOperation("readClipboard", params, record); }
  writeClipboard(params, record) { return this.clipboardOperation("writeClipboard", params, record); }

  assertClipboardScope(scope) {
    this.assertTransferScope(scope);
    this.assertSiteMethod(scope.method, scope);
    if (scope.documentRevision !== (this.exportDocumentRevisions.get(scope.tabId) ?? 0))
      throw new Error("OBU_CLIPBOARD_DOCUMENT_CHANGED: clipboard authorization document changed");
  }

  async validateClipboardScope(scope) {
    this.assertClipboardScope(scope);
    const sourceURL = await this.ownedDocumentSource(scope, "CLIPBOARD");
    this.assertClipboardScope(scope);
    if (sourceURL !== scope.sourceURL) throw new Error("OBU_CLIPBOARD_DOCUMENT_CHANGED: clipboard authorization document changed");
  }

  async clipboardOperation(method, params, record) {
    const check = () => this.clipboard.check(record);
    check();
    await this.controlReleases.get(params.tabId);
    check();
    await this.requireSessionTab(params, method);
    check();
    await this.ownedDocumentSource(params, "CLIPBOARD");
    check();
    await this.prepareTransferAttachment(params, record.deadlineAt, { preserveClipboardRecord: record, check });
    check();
    const owner = { ...this.attachmentOwners.get(params.tabId) };
    const documentRevision = this.exportDocumentRevisions.get(params.tabId) ?? 0;
    const sourceURL = await this.ownedDocumentSource(params, "CLIPBOARD");
    check();
    const scope = { ...owner, documentRevision, sourceURL, method };
    this.assertClipboardScope(scope);
    return this.clipboard.run(record, scope);
  }

  async turnEnded(params) {
    const session = await this.requireSession(params);
    return this.endSessionControl(params, async () => {
      const tabs = await this.getSessionTabs(session.sessionId, { strict: true });
      await this.detachMany(tabs.filter(hasTabId).map((tab) => tab.id));
      this.activeTabsBySession.delete(session.sessionId);
      for (const tab of tabs) {
        if (hasTabId(tab)) {
          this.cursorByTabId.delete(tab.id);
        }
      }
      const sessionState = await this.store.getSession(session.sessionId);
      sessionState.activeTabId = null;
      await this.store.save();
      await Promise.allSettled(tabs.filter(hasTabId).map((tab) => this.publishCursorState(tab.id)));
    });
  }

  async executeUnhandledCommand(params) {
    throw new Error(`Open Browser Use Chrome does not support command "${params.type}"`);
  }

  addDownloadChangeListener(listener) {
    this.downloadChangeListeners.add(listener);
    return () => this.downloadChangeListeners.delete(listener);
  }

  // Global DownloadItem events expose no tab/frame/GUID linkage. Never guess
  // their owner from a URL, timestamp, filename, or numeric download ID.
  handleDownloadCreated() {}
  handleDownloadChanged() {}

  notifyCursorArrived(params) {
    const moveSequence = params?.moveSequence;
    if (!Number.isInteger(moveSequence)) {
      return false;
    }
    const waiter = this.cursorArrivalWaitersByKey.get(cursorArrivalKey(params.sessionId, params.turnId, moveSequence));
    waiter?.();
    return Boolean(waiter);
  }

  handleCdpEvent(source, method, params = {}) {
    const tabId = source?.tabId;
    if (!Number.isInteger(tabId) || (!this.attachedTabs.has(tabId) && !this.pendingAttachmentTabs.has(tabId))) return;
    if (["Page.frameNavigated", "Page.documentOpened", "Page.frameAttached", "Page.frameDetached"].includes(method) ||
        (method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe") ||
        (method === "Target.detachedFromTarget" && this.childSessionsByTabId.get(tabId)?.has(params.sessionId)))
      this.invalidatePageExportDocument(tabId);
    if (this.siteAccess.restricted) {
      const url = method === "Page.frameNavigated" ? params.frame?.url : method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe" ? params.targetInfo.url : undefined;
      if (url && !["about:blank", "about:srcdoc"].includes(url) && !this.siteAccess.allowsUrl(url)) this.revokeSiteTab(tabId);
    }
    const chooserWait = this.fileChooserWaitersByTabId.get(tabId);
    const joining = chooserWait?.scope && !chooserWait.invalid && ["arming", "pending"].includes(chooserWait.state);
    if (joining && method === "Page.frameAttached" && typeof params.frameId === "string" && typeof params.parentFrameId === "string" && !chooserWait.newFrames.has(params.frameId))
      chooserWait.newFrames.set(params.frameId, { parentFrameId: params.parentFrameId, parentSessionId: source.sessionId, navigated: false, swapped: false });
    if (method === "Target.attachedToTarget" && typeof params.sessionId === "string" && params.targetInfo?.type === "iframe") {
      const sessions = this.childSessionsByTabId.get(tabId) ?? new Set();
      sessions.add(params.sessionId); this.childSessionsByTabId.set(tabId, sessions);
      const frame = joining && chooserWait.newFrames.get(params.targetInfo.targetId);
      if (frame && !frame.navigated && !frame.childSessionId && frame.parentSessionId === source.sessionId && frame.parentFrameId === params.targetInfo.parentFrameId)
        frame.childSessionId = params.sessionId;
      if (chooserWait) void this.enableFileChooserTarget(chooserWait, params.sessionId).catch(() => {});
      const downloadWait = this.downloadWaits.byTab.get(tabId);
      if (downloadWait) void this.downloadWaits.enable(downloadWait, params.sessionId).catch(() => {});
    }
    if (method === "Target.detachedFromTarget") {
      if (typeof params.sessionId === "string") this.directoryUploads.invalidate({ tabId, sessionId: params.sessionId }, new Error("OBU_TRANSFER_CANCELLED: file input child attachment detached"));
      this.childSessionsByTabId.get(tabId)?.delete(params.sessionId);
      if (this.fileChooserWaitersByTabId.get(tabId)?.targets.has(params.sessionId))
        void this.fileChooserWaits.invalidateAttachedTab(tabId).catch(() => {});
      for (const [id, chooser] of this.fileChoosersById) if (chooser.target.sessionId === params.sessionId && chooser.scope.tabId === tabId) this.fileChoosersById.delete(id);
    }
    const swappingFrame = joining && method === "Page.frameDetached" && chooserWait.newFrames.get(params.frameId);
    const initialSwap = swappingFrame && params.reason === "swap" && !swappingFrame.swapped && swappingFrame.parentSessionId === source.sessionId;
    if (initialSwap) swappingFrame.swapped = true;
    if (["Page.documentOpened", "Page.frameDetached"].includes(method) && !initialSwap) {
      const frameId = params.frameId ?? params.frame?.id;
      const destroyed = method === "Page.documentOpened" || params.reason === "remove";
      if (destroyed) {
        if (typeof frameId === "string") this.fileInputDocumentsByTabId.get(tabId)?.delete(frameId);
        else if (!source.sessionId) this.fileInputDocumentsByTabId.delete(tabId);
      }
      this.directoryUploads.invalidate({ tabId,
        ...(source.sessionId ? { sessionId: source.sessionId } : {}),
        ...(typeof frameId === "string" ? { frameId } : {})
      }, new Error("OBU_TRANSFER_CANCELLED: file input document changed"), { document: destroyed });
      if (chooserWait?.scope) void this.fileChooserWaits.invalidateAttachedTab(tabId).catch(() => {});
      for (const [id, chooser] of this.fileChoosersById) if (chooser.scope.tabId === tabId) this.fileChoosersById.delete(id);
    }
    if (method === "Page.frameNavigated") {
      const wholeTab = !source.sessionId && !params.frame?.parentId;
      if (wholeTab) this.fileInputDocumentsByTabId.delete(tabId);
      else if (typeof params.frame?.id === "string") this.fileInputDocumentsByTabId.get(tabId)?.delete(params.frame.id);
      this.directoryUploads.invalidate({ tabId,
        ...(source.sessionId ? { sessionId: source.sessionId } : {}),
        ...(!wholeTab && typeof params.frame?.id === "string" ? { frameId: params.frame.id } : {})
      }, new Error("OBU_TRANSFER_CANCELLED: file input document navigated"), { document: true });
      // A new OOPIF may commit its first child document before the parent emits
      // its first swap. Consume these independently, retaining exact identities.
      const frame = joining && chooserWait.newFrames.get(params.frame?.id);
      const initialDocument = frame && !frame.navigated && frame.parentFrameId === params.frame?.parentId &&
        source.sessionId === (frame.childSessionId ?? frame.parentSessionId);
      if (initialDocument) frame.navigated = true;
      if (chooserWait?.scope && !initialDocument)
        void this.fileChooserWaits.invalidateAttachedTab(tabId).catch(() => {});
      this.documentEpochs.set(tabId, (this.documentEpochs.get(tabId) ?? 0) + 1);
      for (const [id, chooser] of this.fileChoosersById) if (chooser.scope.tabId === tabId) this.fileChoosersById.delete(id);
    }
    if (method === "Page.fileChooserOpened") void this.handleFileChooserOpened(source, params).catch(() => {});
    if (method === "Page.downloadWillBegin") void this.handleOwnedDownload(source, params).catch(() => {});
    if (method === "Page.downloadProgress") void this.handleOwnedDownloadProgress(source, params).catch(() => {});
  }

  async handleOwnedDownloadProgress(source, params) {
    const record = this.downloadsById.get(params.guid);
    if (!record || record.scope.tabId !== source.tabId || record.targetSessionId !== source.sessionId) return;
    const revision = record.progressRevision = (record.progressRevision ?? 0) + 1;
    const status = params.state === "completed" ? "complete" : params.state === "canceled" ? "canceled" : "in_progress";
    try {
      await this.validateTransferScope(record.scope);
      this.assertTransferScope(record.scope);
      if (this.downloadsById.get(params.guid) !== record || record.progressRevision !== revision) return;
      record.status = status;
      if (record.authorized) this.emitDownloadChange(record);
    } catch { if (this.downloadsById.get(params.guid) === record) this.retirePageDownload(params.guid); }
  }

  async handleFileChooserOpened(source, params) {
      const tabId = source.tabId;
      const waiter = this.fileChooserWaitersByTabId.get(tabId);
      const documentEpoch = this.documentEpochs.get(tabId);
      if (waiter && ["arming", "pending"].includes(waiter.state)) waiter.selectedDocumentEpoch = documentEpoch ?? 0;
      this.fileChooserWaits.observe(waiter, source.sessionId, check => {
        check();
        if (this.fileChooserWaitersByTabId.get(tabId) !== waiter || this.documentEpochs.get(tabId) !== documentEpoch) throw new Error("File chooser became stale");
        if (source.sessionId && !this.childSessionsByTabId.get(tabId)?.has(source.sessionId)) throw new Error("Unowned file chooser child session");
        if (!Number.isInteger(params.backendNodeId)) throw new Error("File chooser event did not include backendNodeId");
        if (this.fileChoosersById.size >= 128) throw new Error("File chooser capacity reached");
        const fileChooserId = crypto.randomUUID(), isMultiple = params.mode === "selectMultiple";
        this.fileChoosersById.set(fileChooserId, { scope: waiter.scope, target: { tabId, ...(source.sessionId ? { sessionId: source.sessionId } : {}) },
          frameId: params.frameId, backendNodeId: params.backendNodeId, isMultiple });
        return { fileChooserId, isMultiple };
      });
  }

  async handleOwnedDownload(source, params) {
    const waiter = this.downloadWaits.byTab.get(source.tabId);
    if (typeof params.guid !== "string" || !params.guid || new TextEncoder().encode(params.guid).length > 256 || this.downloadsById.has(params.guid)) return;
    this.downloadWaits.observe(waiter, source.sessionId, record => {
      if (this.downloadsById.size >= 128) {
        const completed = [...this.downloadsById].find(([, item]) => item.delivered && ["complete", "canceled"].includes(item.status));
        if (completed) this.retirePageDownload(completed[0]);
        else throw new Error("Download tracking capacity reached");
      }
      this.downloadsById.set(params.guid, { id: params.guid, scope: record.scope, targetSessionId: source.sessionId, frameId: params.frameId,
        nativeContext: record.nativeContext,
        waiterId: record.waiterId, url: typeof params.url === "string" ? params.url.slice(0, 8192) : undefined,
        suggestedFilename: typeof params.suggestedFilename === "string" ? params.suggestedFilename.slice(0, 1024) : undefined,
        status: "started", authorized: false });
      return { downloadId: params.guid };
    });
  }

  readCursorOverlayState(tabId) {
    if (this.automationControl.inputBlocked || (this.siteAccess.restricted && this.siteRevokedTabs.has(tabId))) return { cursor: null, isVisible: false, sessionId: null, turnId: null };
    for (const [sessionId, activeTabId] of this.activeTabsBySession) {
      if (activeTabId === tabId) {
        return {
          cursor: this.cursorByTabId.get(tabId) ?? null,
          isVisible: true,
          sessionId,
          turnId: null
        };
      }
    }
    return {
      cursor: null,
      isVisible: false,
      sessionId: null,
      turnId: null
    };
  }

  isBrowserControlActive() {
    return this.activeTabsBySession.size > 0;
  }

  createCursorArrivalWaiter(sessionId, turnId, moveSequence) {
    const key = cursorArrivalKey(sessionId, turnId, moveSequence);
    let timeoutId;
    let resolvePromise;
    const resolve = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      this.cursorArrivalWaitersByKey.delete(key);
      resolvePromise?.();
    };
    const promise = new Promise((resolveInner) => {
      resolvePromise = resolveInner;
      timeoutId = setTimeout(resolve, CURSOR_ARRIVAL_TIMEOUT_MS);
      this.cursorArrivalWaitersByKey.set(key, resolve);
    });
    return { promise, cancel: resolve };
  }

  emitDownloadChange(record) {
    const { session_id, turn_id, control_epoch, tabId } = record.scope;
    const change = { id: record.id, url: record.url, status: record.status, suggestedFilename: record.suggestedFilename, session_id, turn_id, control_epoch, tabId };
    for (const listener of this.downloadChangeListeners) listener(change);
  }

  async cdpEventMetadata(source) {
    // Raw events may describe workers, network bodies or origins outside the
    // live frame tree. Restricted modes expose only audited action results.
    if (this.siteAccess.restricted) return null;
    const scope = this.attachmentOwners.get(source?.tabId);
    if (!scope) return null;
    try {
      this.assertTransferScope(scope);
      await this.validateTransferScope(scope);
      if (this.attachmentOwners.get(scope.tabId) !== scope) return null;
      this.assertTransferScope(scope);
      const { session_id, turn_id, control_epoch, tabId } = scope;
      return { session_id, turn_id, control_epoch, tabId };
    } catch { return null; }
  }

  async evaluateJavascript(tabId, expression, awaitPromise) {
    this.assertControlOpen();
    const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "JavaScript evaluation failed");
    }
    return result.result?.value;
  }

  async ensureSessionGroup(sessionId, tabId, origin, check = () => this.assertControlOpen(), observer) {
    const group = async options => {
      observer?.before(options);
      try {
        const groupId = await chrome.tabs.group(options);
        observer?.after(groupId);
        return groupId;
      } catch (error) { observer?.failed(); throw error; }
    };
    const session = await this.store.getSession(sessionId);
    check();
    let groupId = session.chromeGroupId;
    if (typeof groupId === "number") {
      try {
        await chrome.tabGroups.get(groupId);
        check();
        await group({ groupId, tabIds: [tabId] });
        check();
      } catch {
        check();
        groupId = null;
      }
    }
    check();
    if (typeof groupId !== "number") {
      groupId = await group({ tabIds: [tabId] });
      check();
      session.chromeGroupId = groupId;
    }
    session.tabOrigins[String(tabId)] = origin;
    await this.store.save();
    check();
    await chrome.tabGroups.update(groupId, {
      title: session.title,
      color: "blue",
      collapsed: false
    });
    check();
  }

  async setSessionActiveTab(sessionId, tabId, check = () => this.assertControlOpen()) {
    const session = await this.store.getSession(sessionId);
    check();
    session.activeTabId = tabId;
    this.activeTabsBySession.set(sessionId, tabId);
    await this.store.save();
    check();
    await this.publishCursorState(tabId);
    check();
  }

  async getSessionTabs(sessionId, { strict = false } = {}) {
    await this.auxiliaryTabs.ready;
    const session = await this.store.getSession(sessionId);
    const auxiliary = [];
    for (const record of this.auxiliaryTabs.list(sessionId)) {
      const tab = await this.liveAuxiliaryTab(record, { strict });
      if (tab) auxiliary.push([record, tab]);
    }
    let grouped = [];
    const groupId = session.chromeGroupId;
    if (typeof groupId === "number" && !auxiliary.some(([record]) => record.kind === "ordinary")) {
      try {
        grouped = await chrome.tabs.query({ groupId });
        if (session.chromeGroupId !== groupId) grouped = [];
      } catch (error) {
        if (strict) throw error;
        // An inventory failure does not prove that the group or an auxiliary
        // popup disappeared. Preserve ownership for a later explicit retry.
      }
    }
    const tabs = new Map();
    for (const tab of grouped) {
      const claim = this.auxiliaryTabs.entry(tab.id);
      if (!hasTabId(tab) || (claim && claim.windowId !== null)) continue;
      tabs.set(tab.id, tab);
    }
    for (const [record, tab] of auxiliary)
      if (this.auxiliaryTabs.owner(tab.id) === record) tabs.set(tab.id, tab);
    return [...tabs.values()].filter(tab => !tab.url?.startsWith("chrome://"));
  }

  async liveAuxiliaryTab(record, { strict = false } = {}) {
    if (this.auxiliaryTabs.owner(record.tabId) !== record) return null;
    let tab;
    try { tab = await chrome.tabs.get(record.tabId); }
    catch (error) {
      if (/no tab with (given )?id|invalid tab id/i.test(String(error?.message ?? error))) {
        await this.releaseAuxiliaryClaim(record, { destroyed: true });
      } else if (strict) throw error;
      return null;
    }
    if (this.auxiliaryTabs.owner(record.tabId) !== record) return null;
    if (tab.windowId !== record.windowId || tab.groupId !== -1 || (["ordinary", "background-window", "created-page"].includes(record.kind) && tab.pinned)) {
      await this.releaseAuxiliaryClaim(record);
      return null;
    }
    return tab;
  }

  invalidateAuxiliaryTab(tabId) {
    const record = this.auxiliaryTabs.entry(tabId);
    const creation = this.creationTransactions.get(record);
    if (creation && !creation.finished) return;
    // An ordinary claim also reserves the tab while it is grouped. Its own
    // group operation must not be mistaken for an auxiliary window transfer.
    if (record && record.windowId !== null)
      void this.releaseAuxiliaryClaim(record).catch(() => {});
  }

  releaseAuxiliaryClaim(record, { destroyed = false, disposition = false, pageWaitRelease = null } = {}) {
    if (this.auxiliaryTabs.entry(record.tabId) !== record) return Promise.resolve();
    const creation = this.creationTransactions.get(record);
    if (creation?.finished && creation.cleanupFailed) {
      if (destroyed) creation.destroyed = true;
      if (this.auxiliaryReleases.has(record)) return this.auxiliaryReleases.get(record);
      const retry = this.cleanupCreatedTab(creation).then(() => { this.creationTransactions.delete(record); });
      this.auxiliaryReleases.set(record, retry);
      retry.finally(() => { if (this.auxiliaryReleases.get(record) === retry) this.auxiliaryReleases.delete(record); }).catch(() => {});
      return retry;
    }
    if (creation && !creation.finished) {
      if (destroyed) { creation.destroyed = true; creation.invalid = true; }
      this.auxiliaryTabs.quarantine(record);
      return creation.done;
    }
    if (this.auxiliaryReleases.has(record)) return this.auxiliaryReleases.get(record);
    if (record.kind === "background-window" && !disposition) {
      // Deny synchronously, before detaching or reading Chrome. A detached tab
      // may reappear in a task group while these promises are pending.
      this.auxiliaryTabs.quarantine(record);
      const release = (async () => {
        const owner = this.attachmentOwners.get(record.tabId);
        if (!destroyed && (!owner || owner.session_id === record.session_id)) await this.detachTab(record.tabId);
        let tab;
        if (!destroyed) try { tab = await chrome.tabs.get(record.tabId); }
        catch (error) { if (!/No tab with (given )?id|Invalid tab id/i.test(String(error?.message))) throw error; }
        if (tab) {
          await this.auxiliaryTabs.excludeBackground(record);
          const state = this.store.state.sessions[record.session_id];
          if (state?.tabOrigins[String(record.tabId)] === "agent") { delete state.tabOrigins[String(record.tabId)]; await this.store.save(); }
        } else await this.auxiliaryTabs.remove(record, { releaseExcluded: true });
      })();
      this.auxiliaryReleases.set(record, release);
      release.finally(() => { if (this.auxiliaryReleases.get(record) === release) this.auxiliaryReleases.delete(record); }).catch(() => {});
      return release;
    }
    if (record.phase === "excluded" || (record.kind === "ordinary" && record.origin === "agent" && record.phase === "quarantined")) {
      // Recovery cannot reconstruct safe deletion eligibility for an unfinished
      // create. Keep an exact denial while its original task group still owns
      // the native position; Pause/end must not re-authorize it by enumeration.
      const release = (async () => {
        const owner = this.attachmentOwners.get(record.tabId);
        if (!destroyed && (!owner || owner.session_id === record.session_id)) await this.detachTab(record.tabId);
        let tab;
        if (!destroyed) try { tab = await chrome.tabs.get(record.tabId); }
        catch (error) { if (!/No tab with (given )?id|Invalid tab id/i.test(String(error?.message))) throw error; }
        const state = this.store.state.sessions[record.session_id];
        const groupId = record.phase === "excluded" ? record.excludedGroupId : state?.chromeGroupId;
        if (tab && Number.isSafeInteger(groupId) && tab.windowId === record.windowId && tab.groupId === groupId) {
          await this.auxiliaryTabs.exclude(record, groupId);
          if (state?.tabOrigins[String(record.tabId)] === "agent") { delete state.tabOrigins[String(record.tabId)]; await this.store.save(); }
          return;
        }
        await this.auxiliaryTabs.remove(record, { releaseExcluded: true });
      })();
      this.auxiliaryReleases.set(record, release);
      release.finally(() => { if (this.auxiliaryReleases.get(record) === release) this.auxiliaryReleases.delete(record); }).catch(() => {});
      return release;
    }
    this.auxiliaryTabs.quarantine(record);
    const owner = this.attachmentOwners.get(record.tabId);
    // Revoke old engine/input admission immediately, before queued storage
    // work. A surviving foreign attachment must never be torn down by this ID.
    const controlsTab = owner ? owner.session_id === record.session_id : record.windowId !== null;
    let cleanup = Promise.resolve();
    if (!destroyed && controlsTab) {
      const existingNative = pageWaitRelease && this.pageWaitNativeReleases.get(record.tabId);
      if (existingNative) cleanup = existingNative;
      else {
        const fullRelease = this.detachTab(record.tabId, { releasePageWait: pageWaitRelease });
        fullRelease.catch(() => {});
        // A created-page rollback is itself part of the page wait's drain.
        // Await all actual non-page-wait cleanup, not the aggregate containing
        // that same rollback. The full barrier remains in controlReleases.
        cleanup = record.kind === "created-page" ? this.pageWaitNativeReleases.get(record.tabId) : fullRelease;
      }
    }
    cleanup.catch(() => {});
    const release = this.auxiliaryTabs.remove(record, { cleanup: () => cleanup });
    this.auxiliaryReleases.set(record, release);
    release.finally(() => { if (this.auxiliaryReleases.get(record) === release) this.auxiliaryReleases.delete(record); }).catch(() => {});
    return release;
  }

  async requireSession(params) {
    if (!params || typeof params !== "object") {
      throw new Error("Missing browser session params");
    }
    if (typeof params.session_id !== "string" || !params.session_id || params.session_id.length > 256) {
      throw new Error("Missing required browser session_id");
    }
    if (typeof params.turn_id !== "string" || !params.turn_id || params.turn_id.length > 256) {
      throw new Error("Missing required browser turn_id");
    }
    await this.controlReady;
    this.assertControlOpen();
    await this.controlLedger.admit(params);
    await this.store.getSession(params.session_id);
    this.controlLedger.assertCurrent(params);
    return { sessionId: params.session_id, turnId: params.turn_id };
  }

  async getControlState(params) {
    if (typeof params?.session_id !== "string" || !params.session_id || params.session_id.length > 256) throw new Error("Missing required browser session_id");
    await this.controlReady;
    this.automationControl.assertOpen();
    if (this.nativeRecovery) {
      const recovery = this.nativeRecovery.pending ? this.nativeRecovery.promise : this.startNativeRecovery({ retryPageCleanup: true });
      await withTimeout(this.automationCleanupTimeoutMs, () => recovery,
        () => new Error("OBU_NATIVE_RECOVERY_PENDING: native control cleanup is still pending; no browser action was replayed"));
    }
    const record = this.controlLedger.records.get(params.session_id);
    if (record?.status === "closing" && !this.endingSessions.has(params.session_id)) {
      await this.recoverEndedSession(params.session_id, record);
    }
    if (!record) await this.releaseRecoveredCreatedPages(params.session_id);
    return this.controlLedger.bootstrap(params.session_id);
  }

  async runSessionMutation(params, operation, onFailure) {
    await this.requireSession(params);
    this.controlLedger.assertCurrent(params);
    const sessionId = params.session_id;
    const operations = this.sessionMutations.get(sessionId) ?? new Set();
    this.sessionMutations.set(sessionId, operations);
    const pending = Promise.resolve().then(operation);
    operations.add(pending);
    try {
      const result = await pending;
      this.controlLedger.assertCurrent(params);
      return result;
    } catch (error) {
      if (onFailure) {
        try { await onFailure(error); }
        catch (cleanupError) { throw new Error(`OBU_TAB_CREATION_CLEANUP_FAILED: ${error.message}; ${cleanupError.message}`, { cause: error }); }
      }
      throw error;
    } finally {
      operations.delete(pending);
      if (!operations.size && this.sessionMutations.get(sessionId) === operations) this.sessionMutations.delete(sessionId);
    }
  }

  async releaseSessionControl(sessionId) {
    this.directoryUploads.cancelWhere(record => record.scope.session_id === sessionId, new Error("OBU_TRANSFER_CANCELLED: session control ended"));
    for (const marker of this.freshBlankTabs.values()) if (marker.session_id === sessionId) this.retireFreshBlankTab(marker);
    const choosersReleased = this.fileChooserWaits.invalidateSession(sessionId);
    const downloadWaitsReleased = this.downloadWaits.invalidateSession(sessionId);
    const pageWaitsReleased = this.pageWaits.invalidateSession(sessionId);
    const downloadsReleased = this.directDownloads.invalidateSession(sessionId);
    const exportsReleased = this.pageExports.invalidateSession(sessionId);
    exportsReleased.catch(() => {});
    const clipboardReleased = this.clipboard.invalidateSession(sessionId);
    clipboardReleased.catch(() => {});
    const brokerReleased = this.clipboardBroker.waitForSession(sessionId);
    brokerReleased.catch(() => {});
    this.networkWaits.invalidateSession(sessionId);
    this.navigationWaits.invalidateSession(sessionId);
    this.auxiliaryTabs.cancelPending(sessionId);
    // An inventory failure is not proof that control was released. Keep the
    // session record so explicit recovery can retry the same owned group.
    const tabs = await this.getSessionTabs(sessionId, { strict: true });
    const tabIds = new Set(tabs.filter(hasTabId).map(tab => tab.id));
    // A reservation can still be awaiting ordinary-tab ownership validation.
    // It cannot authorize detaching another session's unpublished attachment.
    for (const claim of this.auxiliaryTabs.entries(sessionId)) {
      if (claim.windowId !== null) tabIds.add(claim.tabId);
    }
    for (const owner of this.attachmentOwners.values()) if (owner.session_id === sessionId) tabIds.add(owner.tabId);
    const releases = [...tabIds].filter(tabId => {
      const owner = this.attachmentOwners.get(tabId);
      return !owner || owner.session_id === sessionId;
    }).map(tabId => this.detachTab(tabId));
    for (const claim of this.auxiliaryTabs.entries(sessionId)) {
      if (claim.phase !== "committed") releases.push(this.releaseAuxiliaryClaim(claim));
    }
    const outcomes = await Promise.allSettled([choosersReleased, downloadWaitsReleased, pageWaitsReleased, downloadsReleased, exportsReleased, clipboardReleased, brokerReleased, ...releases]);
    const failures = outcomes.filter(result => result.status === "rejected");
    if (failures.length) throw new Error(`OBU_CONTROL_RELEASE_FAILED: ${failures.map(result => String(result.reason?.message ?? result.reason)).join("; ")}`);
  }

  async endSessionControl(params, finish) {
    if (this.endingSessions.has(params.session_id)) throw new Error("OBU_CONTROL_ENDING: browser control is still being released");
    const ending = {};
    this.endingSessions.set(params.session_id, ending);
    try {
      this.controlLedger.assertCurrent(params);
      this.directoryUploads.cancelWhere(record => record.scope.session_id === params.session_id, new Error("OBU_TRANSFER_CANCELLED: session control ended"));
      void this.fileChooserWaits.invalidateSession(params.session_id).catch(() => {});
      void this.downloadWaits.invalidateSession(params.session_id).catch(() => {});
      void this.pageWaits.invalidateSession(params.session_id).catch(() => {});
      void this.directDownloads.invalidateSession(params.session_id);
      void this.pageExports.invalidateSession(params.session_id).catch(() => {});
      void this.clipboard.invalidateSession(params.session_id).catch(() => {});
      this.networkWaits.invalidateSession(params.session_id);
      this.navigationWaits.invalidateSession(params.session_id);
      this.auxiliaryTabs.cancelPending(params.session_id);
      const record = await this.controlLedger.beginEnd(params);
      const release = this.releaseSessionControl(params.session_id);
      release.catch(() => {});
      // Cancel engine waits before draining finite Chrome state mutations. A raw
      // attach/create/claim already accepted must settle before the final detach
      // and tab disposition, so it cannot resurrect control after this response.
      await Promise.allSettled([...this.sessionMutations.get(params.session_id) ?? []]);
      await release;
      await this.releaseSessionControl(params.session_id);
      try {
        this.assertControlOpen();
        await finish();
      } catch (error) {
        await this.clearSessionActivity(params.session_id);
        await this.controlLedger.finishEnd(record);
        throw error;
      }
      await this.clearSessionActivity(params.session_id);
      this.assertControlOpen();
      const result = await this.controlLedger.finishEnd(record);
      this.assertControlOpen();
      return result;
    } finally {
      if (this.endingSessions.get(params.session_id) === ending) this.endingSessions.delete(params.session_id);
    }
  }

  async recoverControlState() {
    await Promise.all([this.store.ready, this.controlLedger.ready, this.automationControl.ready, this.auxiliaryTabs.ready, this.siteAccess.ready]);
    // The journal has already durably imported legacy Pause IDs. They cannot be
    // rebound to numbers in a replacement browser and must not enter detach.
    this.automationControl.recoveredPendingTabs.clear();
    this.automationControl.pendingTabIds.clear();
    this.automationControl.incarnation = this.browserLifetime.incarnation;
    try { this.browserLifetime.assertInputRecoveryClear(); }
    catch (error) {
      this.automationControl.fail(error);
      await this.controlLedger.invalidateAll("input-recovery-unknown");
      await this.automationControl.persist(true);
      return;
    }
    try { await this.clipboardBroker.recover(); }
    catch (error) {
      // Keep admission blocked and old epochs invalid, but do not poison the
      // ready Promise forever after a recoverable clipboard cleanup failure.
      // The user can retry Pause, then explicitly Resume and begin a new turn.
      this.automationControl.fail(error);
      await this.controlLedger.invalidateAll();
      await this.automationControl.persist(true);
      return;
    }
    if (this.automationControl.inputBlocked) {
      // Startup recovery shares the popup transition queue. A Pause accepted
      // while storage was loading already owns that recovery operation.
      if (!this.automationControl.requestedPause) {
        this.automationTransitions = this.automationTransitions.catch(() => {}).then(() => this.finishAutomationPause());
      }
      await this.automationTransitions.catch(() => {});
      return;
    }
    const recovering = [];
    for (const [sessionId, record] of this.controlLedger.records) {
      // Handoff/end can leave a created-page claim in an idle session. Its
      // worker-bound authority was quarantined on load; use the same closing
      // barrier so failed exact cleanup can be retried by explicit bootstrap.
      const idleCreatedPage = record.status === "idle" && this.auxiliaryTabs.entries(sessionId)
        .some(claim => claim.kind === "created-page" && claim.phase === "quarantined");
      if (record.status === "active" || idleCreatedPage) this.controlLedger.invalidate(record, "worker-restart");
      if (record.status === "closing") recovering.push([sessionId, record]);
    }
    if (recovering.length) await this.controlLedger.save();
    for (const [sessionId, record] of recovering) {
      // Leave a failed release fenced. Explicit bootstrap may retry cleanup;
      // unrelated sessions must still be able to recover.
      await this.recoverEndedSession(sessionId, record).catch(() => {});
    }
    // Idle ledger eviction does not erase auxiliary identities. Retire those
    // exact quarantines without recreating control records or evicting others.
    const orphaned = new Set(this.auxiliaryTabs.entries().filter(claim => claim.kind === "created-page" &&
      claim.phase === "quarantined" && !this.controlLedger.records.has(claim.session_id)).map(claim => claim.session_id));
    for (const sessionId of orphaned) await this.releaseRecoveredCreatedPages(sessionId).catch(() => {});
  }

  async releaseRecoveredCreatedPages(sessionId) {
    for (const claim of this.auxiliaryTabs.entries(sessionId)) {
      if (claim.kind === "created-page" && claim.phase === "quarantined") await this.releaseAuxiliaryClaim(claim);
    }
  }

  async recoverEndedSession(sessionId, record) {
    if (this.endingSessions.has(sessionId)) return;
    const recovery = {};
    this.endingSessions.set(sessionId, recovery);
    try {
      await this.releaseSessionControl(sessionId);
      await this.clearSessionActivity(sessionId);
      await this.controlLedger.finishEnd(record);
    } finally {
      if (this.endingSessions.get(sessionId) === recovery) this.endingSessions.delete(sessionId);
    }
  }

  async clearSessionActivity(sessionId) {
    this.activeTabsBySession.delete(sessionId);
    const state = Object.hasOwn(this.store.state.sessions, sessionId) ? this.store.state.sessions[sessionId] : undefined;
    if (state) state.activeTabId = null;
    await this.store.save();
  }

  async requireSessionTab(params, command) {
    const session = await this.requireSession(params);
    const tabId = requireTabId(params, command);
    const tabs = await this.getSessionTabs(session.sessionId);
    const tab = tabs.find(tab => tab.id === tabId);
    if (!tab) {
      throw new Error(`Tab ${tabId} is not part of browser session ${session.sessionId}`);
    }
    assertControllableTab(tab);
    if (command !== "detach") await this.assertSiteTab(tabId, { recover: true, allowBlank: params.action === "goto" });
    if (command !== "detach") this.assertAttachmentAdmission(tabId);
    this.controlLedger.assertCurrent(params);
  }

  async withLogicalActive(sessionId, tabs) {
    if (tabs.length === 0) {
      return tabs;
    }
    const session = await this.store.getSession(sessionId);
    let activeTabId = this.activeTabsBySession.get(sessionId) ?? session.activeTabId;
    if (!tabs.some((tab) => tab.id === activeTabId)) {
      activeTabId = tabs.find((tab) => tab.active)?.id ?? tabs[0].id;
      await this.setSessionActiveTab(sessionId, activeTabId);
    } else if (!this.activeTabsBySession.has(sessionId)) {
      this.activeTabsBySession.set(sessionId, activeTabId);
    }
    return tabs.map((tab) => ({ ...tab, active: tab.id === activeTabId }));
  }

  async moveToDeliverables(tabIds) {
    if (!Array.isArray(tabIds) || tabIds.length === 0) {
      return;
    }

    const tabRecords = await Promise.all(
      tabIds.map((id) => chrome.tabs.get(id).catch(() => null))
    );
    const tabsByWindow = new Map();
    for (const tab of tabRecords) {
      if (!tab || typeof tab.id !== "number" || typeof tab.windowId !== "number") continue;
      const arr = tabsByWindow.get(tab.windowId) ?? [];
      arr.push(tab.id);
      tabsByWindow.set(tab.windowId, arr);
    }
    if (tabsByWindow.size === 0) {
      return;
    }

    let lastGroupId = null;
    this.store.state.deliverableGroups ??= {};

    for (const [windowId, windowTabIds] of tabsByWindow) {
      const ownedGroupId = this.store.state.deliverableGroups[windowId];
      let primaryGroupId = null;
      if (Number.isSafeInteger(ownedGroupId)) {
        const group = await chrome.tabGroups.get(ownedGroupId).catch(() => null);
        if (group?.windowId === windowId) primaryGroupId = ownedGroupId;
      }
      // Names are presentation, never ownership. A restored or user-created
      // group with the delivery title must not absorb these tabs.

      if (typeof primaryGroupId === "number") {
        this.assertControlOpen();
        try {
          await chrome.tabs.group({ groupId: primaryGroupId, tabIds: windowTabIds });
        } catch {
          primaryGroupId = null;
        }
      }

      if (typeof primaryGroupId !== "number") {
        this.assertControlOpen();
        primaryGroupId = await chrome.tabs.group({ tabIds: windowTabIds });
      }

      this.assertControlOpen();
      await chrome.tabGroups
        .update(primaryGroupId, {
          title: DELIVERABLE_GROUP_TITLE,
          color: "green",
          collapsed: false
        })
        .catch(() => {});

      this.store.state.deliverableGroups[windowId] = primaryGroupId;
      lastGroupId = primaryGroupId;
    }

    if (typeof lastGroupId === "number") {
      this.store.state.deliverableGroupId = lastGroupId;
      await this.store.save();
    }
  }

  async detachMany(tabIds) {
    await Promise.allSettled(tabIds.map((tabId) => this.detachTab(tabId)));
  }

  detachTab(tabId, { preserveNetworkArming = false, preserveNavigationArming = false, preserveChooserRecord = null, preserveDownloadWait = null, preservePageWait = null, releasePageWait = null, preserveDirectRecord = null, preserveExportRecord = null, preserveClipboardRecord = null } = {}) {
    this.directoryUploads.cancelWhere(record => record.identity.tabId === tabId, new Error("OBU_TRANSFER_CANCELLED: tab control ended"));
    this.retireFreshBlankTab(this.freshBlankTabs.get(tabId));
    const attachment = this.attachmentEpochs.get(tabId);
    this.browserEngine?.invalidate?.(tabId);
    if (preserveNetworkArming) this.networkWaits.invalidateAttachedTab(tabId);
    else this.networkWaits.invalidateTab(tabId);
    if (preserveNavigationArming) this.navigationWaits.invalidateAttachedTab(tabId);
    else this.navigationWaits.invalidateTab(tabId);
    this.controlEpochs.set(tabId, (this.controlEpochs.get(tabId) ?? 0) + 1);
    // Input release may fail and deliberately retain the native attachment.
    // End the rendering lease immediately even in that case.
    this.internalScreencasts.get(tabId)?.cancel?.();
    const downloadsReleased = this.directDownloads.invalidateTab(tabId, preserveDirectRecord);
    const mediaReleased = this.directDownloads.invalidate(record => record.params.tabId === tabId && record.scope?.mediaDownload);
    const exportsReleased = this.pageExports.invalidateTab(tabId, preserveExportRecord);
    const clipboardReleased = this.clipboard.invalidateTab(tabId, preserveClipboardRecord);
    const choosersReleased = this.fileChooserWaits.invalidateTab(tabId, undefined, preserveChooserRecord);
    const downloadWaitsReleased = this.downloadWaits.invalidateTab(tabId, undefined, preserveDownloadWait);
    const pageWaitsReleased = this.pageWaits.invalidateTab(tabId, undefined, preservePageWait, releasePageWait);
    // A repeated explicit detach must also cancel a reservation intentionally
    // preserved by an earlier owner migration. Reuse the actual native release,
    // but keep the barrier until both it and this new cleanup have settled.
    const previousRelease = this.controlReleases.get(tabId);
    const previousNative = this.pageWaitNativeReleases.get(tabId);
    const nativeRelease = Promise.allSettled([choosersReleased, downloadWaitsReleased, mediaReleased, exportsReleased, clipboardReleased, this.clipboardBroker.waitForTab(tabId), previousNative ?? previousRelease]).then(results => {
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
      return previousRelease ? undefined : this.releaseTabControl(tabId, attachment);
    });
    const nativePhase = Promise.allSettled([downloadsReleased, nativeRelease]).then(results => {
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
    });
    this.pageWaitNativeReleases.set(tabId, nativePhase);
    const release = Promise.allSettled([pageWaitsReleased, nativePhase, previousRelease]).then(results => {
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
    });
    this.controlReleases.set(tabId, release);
    const cleanup = () => {
      if (this.controlReleases.get(tabId) === release) this.controlReleases.delete(tabId);
      if (this.pageWaitNativeReleases.get(tabId) === nativePhase) this.pageWaitNativeReleases.delete(tabId);
    };
    release.then(cleanup, cleanup);
    return release;
  }

  async releaseTabControl(tabId, attachment = this.attachmentEpochs.get(tabId)) {
    const destroyed = () => Boolean(attachment) && this.destroyedAttachmentTokens.has(attachment);
    const assertOriginal = () => {
      if (attachment && this.attachmentEpochs.get(tabId) && this.attachmentEpochs.get(tabId) !== attachment)
        throw new Error("OBU_INPUT_ATTACHMENT_CHANGED: original attachment changed during cleanup");
    };
    // Only the original native tab/target destruction proves that its held
    // input, contexts and remote handles no longer exist. A late Playwright
    // detach rejection is then expected; an error string alone proves nothing.
    if (destroyed()) return;
    this.clearPointerFeedback(tabId);
    this.externalScreencastTabs.delete(tabId);
    let engineError;
    try {
      await this.browserEngine?.detach(tabId);
    } catch (error) {
      engineError = error;
    }
    if (destroyed()) return;
    assertOriginal();
    // A debugger detach does not release renderer-held pointer/key state. Keep
    // the original native target and token if normal input cleanup is uncertain.
    try {
      await this.releaseTrackedInput(tabId);
      if (destroyed()) return;
      assertOriginal();
      await chrome.debugger.detach({ tabId }).catch((error) => {
        if (!/not attached|no tab with given id/i.test(String(error?.message ?? error))) throw error;
      });
      if (destroyed()) return;
      assertOriginal();
      this.releaseEngineAttachment(tabId);
    } catch (error) {
      if (!destroyed()) throw error;
      return;
    }
    if (engineError) throw engineError;
  }

  releaseTrackedInput(tabId) {
    return this.prepareInputRelease(tabId).release();
  }

  prepareInputRelease(tabId) {
    const token = this.attachmentEpochs.get(tabId);
    const isCurrent = () => Boolean(token) && this.attachmentEpochs.get(tabId) === token;
    return {
      isCurrent,
      release: async () => {
        if (!isCurrent()) return;
        // CRX also detaches on action timeout. Its captured release hook must
        // close exports on this exact attachment before native detach, without
        // cancelling an unbound reservation or a later attachment's work.
        const releases = [this.directDownloads.invalidate(record => record.params.tabId === tabId && record.scope?.mediaDownload && record.scope.attachment === token),
          this.pageExports.invalidateAttachment(tabId, token), this.clipboard.invalidateAttachment(tabId, token), this.clipboardBroker.waitForTab(tabId)];
        const results = await Promise.allSettled(releases);
        const failure = results.find(result => result.status === "rejected");
        if (failure) throw failure.reason;
        if (isCurrent()) await this.inputTracker.release(tabId, token, (target, method, params) => {
          if (this.destroyedAttachmentTokens.has(token)) return Promise.resolve();
          if (!isCurrent()) throw new Error("OBU_INPUT_ATTACHMENT_CHANGED: original attachment changed during input release");
          return chrome.debugger.sendCommand(target, method, params);
        });
      },
      detach: () => isCurrent() ? chrome.debugger.detach({ tabId }) : Promise.resolve()
    };
  }

  prepareMediaCleanup(target, contextId) {
    if (!target || !Number.isSafeInteger(target.tabId) || target.tabId < 1 || Object.keys(target).some(key => !["tabId", "sessionId"].includes(key)))
      throw new Error("OBU_MEDIA_CLEANUP_FAILED: invalid native media target");
    const token = this.attachmentEpochs.get(target.tabId);
    const original = Object.freeze({ ...target });
    const check = () => {
      if (!token || this.attachmentEpochs.get(original.tabId) !== token || !this.attachedTabs.has(original.tabId) ||
          (original.sessionId !== undefined && !this.childSessionsByTabId.get(original.tabId)?.has(original.sessionId)))
        throw new Error("OBU_MEDIA_CLEANUP_FAILED: original native media target is unavailable");
    };
    check();
    this.mediaContextLifetimes ??= new MediaContextLifetimes({
      onEvent: chrome.debugger.onEvent, onDetach: chrome.debugger.onDetach, onTabRemoved: chrome.tabs.onRemoved
    });
    const lifetime = this.mediaContextLifetimes.capture(original, contextId);
    let closed = false;
    const exceptionalObjects = new Set();
    const validObjectId = objectId => typeof objectId === "string" && objectId && objectId.length <= 4096;
    const command = (method, args, checkCleanup) => {
      if (closed) throw new Error("OBU_MEDIA_CLEANUP_FAILED: native media cleanup is closed");
      if (lifetime.isGone()) return Promise.resolve();
      check();
      checkCleanup?.();
      return chrome.debugger.sendCommand(original, method, args).catch(error => {
        if (!lifetime.isGone()) throw error;
      });
    };
    const releaseExceptionalObjects = async checkCleanup => {
      for (const objectId of exceptionalObjects) {
        await command("Runtime.releaseObject", { objectId }, checkCleanup);
        // Keep the actual ACK even if the budget expired while it was pending.
        // The next command checks again; this release must never be replayed.
        exceptionalObjects.delete(objectId);
      }
    };
    const send = (objectId, method, args, checkCleanup) => {
      if (closed || !validObjectId(objectId))
        throw new Error("OBU_MEDIA_CLEANUP_FAILED: invalid native media object");
      if (checkCleanup !== undefined && typeof checkCleanup !== "function")
        throw new TypeError("Native media cleanup checkpoint must be a function");
      // A native context-destruction event also destroys its remote objects.
      // Local Playwright cancellation or a replaced attachment is not evidence.
      if (lifetime.isGone()) { exceptionalObjects.clear(); return Promise.resolve(); }
      check();
      // Only the private, fixed runtime adapter obtains this closure. The exact
      // target and attachment remain captured when Pause closes normal commands.
      return (async () => {
        if (exceptionalObjects.size) await releaseExceptionalObjects(checkCleanup);
        const result = await command(method, args, checkCleanup);
        if (method !== "Runtime.callFunctionOn" || lifetime.isGone()) return;
        // Normal cancellation returns a boolean by value. Keep unexpected
        // native exception/result handles owned until their exact release is
        // confirmed; a rejected cancellation must not leak remote objects.
        for (const remote of [result?.result, result?.exceptionDetails?.exception]) {
          if (remote?.objectId === undefined) continue;
          if (!validObjectId(remote.objectId)) throw new Error("OBU_MEDIA_CLEANUP_FAILED: invalid native cancellation object");
          exceptionalObjects.add(remote.objectId);
        }
        const malformed = exceptionalObjects.size > 0;
        if (exceptionalObjects.size) await releaseExceptionalObjects(checkCleanup);
        if (malformed || result?.exceptionDetails || result?.result?.value !== true)
          throw new Error("OBU_MEDIA_CLEANUP_FAILED: native media cancellation failed");
      })();
    };
    return Object.freeze({
      release: (objectId, checkCleanup) => send(objectId, "Runtime.releaseObject", { objectId }, checkCleanup),
      cancel: (objectId, checkCleanup) => send(objectId, "Runtime.callFunctionOn", {
        objectId, functionDeclaration: MEDIA_CANCEL_FUNCTION, returnByValue: true, awaitPromise: true, userGesture: false
      }, checkCleanup),
      close: () => {
        if (closed) return;
        if (exceptionalObjects.size && !lifetime.isGone()) throw new Error("OBU_MEDIA_CLEANUP_FAILED: native cancellation objects remain");
        exceptionalObjects.clear();
        closed = true;
        lifetime.close();
      }
    });
  }

  async ensureCursorContentScript(sessionId, tabId) {
    let proof;
    try {
      proof = await this.assertSiteTab(tabId);
      this.assertSiteProof(proof);
    } catch { return false; }
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "OPEN_BROWSER_USE_PING" }, this.siteMessageDestination(proof));
      if (response?.ok) {
        return true;
      }
    } catch {}
    if (this.automationControl.inputBlocked || this.nativeRecovery) return false;
    try {
      this.assertSiteProof(proof);
      const destination = this.siteMessageDestination(proof);
      await chrome.scripting.executeScript({
        target: { tabId, ...(destination.documentId ? { documentIds: [destination.documentId] } : {}) },
        files: ["content-cursor.js"]
      });
      return true;
    } catch {
      return false;
    }
  }

  siteMessageDestination(proof) {
    if (!this.siteAccess.restricted) return {};
    if (typeof proof?.documentId !== "string" || !proof.documentId) throw new Error("OBU_SITE_ACCESS_UNVERIFIED: cursor document identity is unavailable");
    return { documentId: proof.documentId };
  }

  async requireWebMcpEnabled() {
    if ((await this.webMcpGate?.enabled?.()) !== true) {
      throw new Error("WebMCP capability is disabled");
    }
  }

  async sendWebMcpRequest(tabId, request, timeoutMs) {
    await this.ensureWebMcpContentScripts(tabId);
    this.assertControlOpen();
    const response = await withWebMcpTimeout(timeoutMs, async () => {
      return await chrome.tabs.sendMessage(tabId, {
        type: "OPEN_BROWSER_USE_WEBMCP_REQUEST",
        ...request
      });
    });
    if (response?.ok !== true) {
      throw new Error(
        typeof response?.error === "string" ? response.error : "WebMCP page bridge request failed"
      );
    }
    return response.result;
  }

  async ensureWebMcpContentScripts(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "OPEN_BROWSER_USE_WEBMCP_PING"
      });
      if (response?.ok === true) {
        return;
      }
    } catch {}

    try {
      this.assertControlOpen();
      await chrome.scripting.executeScript({
        files: ["content-webmcp-main.js"],
        target: { tabId },
        world: "MAIN"
      });
      this.assertControlOpen();
      await chrome.scripting.executeScript({
        files: ["content-webmcp-bridge.js"],
        target: { tabId },
        world: "ISOLATED"
      });
    } catch (error) {
      throw new Error(
        `Cannot inject WebMCP bridge into tab ${tabId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "OPEN_BROWSER_USE_WEBMCP_PING"
      });
      if (response?.ok === true) {
        return;
      }
    } catch {}
    throw new Error(`WebMCP bridge is unavailable in tab ${tabId}`);
  }

  async publishCursorState(tabId) {
    if ((this.siteAccess.restricted || this.nativeRecovery) && !this.readCursorOverlayState(tabId).isVisible) {
      // Cleanup may hide an existing overlay on a revoked page, but must never
      // inject a new script or publish a new visible cursor there.
      return chrome.tabs.sendMessage(tabId, { type: "OPEN_BROWSER_USE_CURSOR_STATE", state: { isVisible: false } }).then(response => response?.ok === true, () => false);
    }
    if (!(await this.ensureCursorContentScript(null, tabId))) {
      return false;
    }
    try {
      const proof = await this.assertSiteTab(tabId);
      this.assertSiteProof(proof);
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "OPEN_BROWSER_USE_CURSOR_STATE",
        state: this.readCursorOverlayState(tabId)
      }, this.siteMessageDestination(proof));
      return response?.ok === true;
    } catch {
      return false;
    }
  }
}

function isOwnExtensionUrl(value) {
  if (typeof value !== "string" || typeof chrome.runtime?.id !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "chrome-extension:" && url.hostname === chrome.runtime.id;
  } catch { return false; }
}

function assertControllableUrl(value) {
  if (isOwnExtensionUrl(value)) throw new Error("OBU_EXTENSION_UI_PROTECTED: automation cannot control this extension's own pages");
}

function assertControllableTab(tab) {
  assertControllableUrl(tab?.url);
  assertControllableUrl(tab?.pendingUrl);
}

function hasTabId(tab) {
  return typeof tab?.id === "number";
}

function toBrowserTab(tab) {
  return {
    id: tab.id,
    title: tab.title,
    active: tab.active,
    url: tab.url
  };
}

function toUserTab(tab, groupTitles) {
  const lastAccessed =
    typeof tab.lastAccessed === "number" && Number.isFinite(tab.lastAccessed)
      ? new Date(tab.lastAccessed).toISOString()
      : undefined;
  const groupTitle =
    typeof tab.groupId === "number" && tab.groupId !== -1 ? groupTitles.get(tab.groupId) : undefined;
  return {
    id: tab.id,
    ...(tab.title ? { title: tab.title } : {}),
    ...(tab.url ? { url: tab.url } : {}),
    ...(lastAccessed ? { lastOpened: lastAccessed } : {}),
    ...(groupTitle ? { tabGroup: groupTitle } : {})
  };
}

function requireTabId(params, command) {
  if (!Number.isInteger(params.tabId)) {
    throw new Error(`${command} requires an integer tabId`);
  }
  return params.tabId;
}

function requireWebMcpTabId(params, command) {
  const candidate = params?.tabId ?? params?.tab_id;
  if (Number.isInteger(candidate) && candidate >= 0) {
    return candidate;
  }
  if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
    const parsed = Number(candidate);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  throw new Error(`${command} requires integer tabId`);
}

function requireNonEmptyString(value, message) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
  return value;
}

function optionalPositiveInteger(value, fallback, field) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

async function createBackgroundTab(assertAdmission = () => {}, createdWindow = () => {}, separateWindow = false) {
  const windowId = separateWindow ? null : await chooseWindowId();
  assertAdmission();
  if (typeof windowId === "number") {
    const tab = await chrome.tabs.create({ active: false, url: "about:blank", windowId });
    if (hasTabId(tab)) {
      return tab;
    }
    throw new Error("Created Chrome tab has no id; creation outcome is unknown");
  }
  assertAdmission();
  const win = await chrome.windows.create({
    focused: false,
    type: "normal",
    url: "about:blank"
  });
  const tab = win.tabs?.find(hasTabId);
  if (!tab) {
    throw new Error("Created Chrome window has no tab");
  }
  createdWindow(win.id);
  return tab;
}

async function chooseWindowId() {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const focused = windows.find((win) => win.focused && typeof win.id === "number");
  return focused?.id ?? windows.find((win) => typeof win.id === "number")?.id ?? null;
}

async function readGroupTitles(tabs) {
  const ids = new Set(
    tabs
      .map((tab) => tab.groupId)
      .filter((groupId) => typeof groupId === "number" && groupId !== -1)
  );
  const entries = await Promise.all(
    [...ids].map(async (groupId) => {
      try {
        const group = await chrome.tabGroups.get(groupId);
        return group.title ? [groupId, group.title] : null;
      } catch {
        return null;
      }
    })
  );
  return new Map(entries.filter(Boolean));
}

function compareLastAccessed(left, right) {
  const byLastAccessed = (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0);
  if (byLastAccessed !== 0) {
    return byLastAccessed;
  }
  const byWindow = (left.windowId ?? 0) - (right.windowId ?? 0);
  return byWindow !== 0 ? byWindow : (left.index ?? 0) - (right.index ?? 0);
}

function parseDate(value, field) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`getUserHistory requires ${field} to be a valid date`);
  }
  return timestamp;
}

function downloadStatus(delta) {
  switch (delta.state?.current) {
    case "complete":
      return "complete";
    case "interrupted":
      return delta.error?.current === "USER_CANCELED" ? "canceled" : "failed";
    case "in_progress":
      return "in_progress";
    default:
      return undefined;
  }
}

function cursorArrivalKey(sessionId, turnId, moveSequence) {
  return `${sessionId}:${turnId}:${moveSequence}`;
}

async function withTimeout(timeoutMs, fn, timeoutError = () => new Error(`Timed out after ${timeoutMs}ms waiting for CDP command.`)) {
  let timeout;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(timeoutError());
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function withWebMcpTimeout(timeoutMs, fn) {
  let timeout;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for WebMCP page bridge.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function startHeartbeat(peer, backend) {
  chrome.alarms.create(HEARTBEAT_ALARM_NAME, { periodInMinutes: 0.5 }).catch(() => {});
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === HEARTBEAT_ALARM_NAME) {
      safeSendNotification(peer, "heartbeat", { at: new Date().toISOString() });
      void backend.getInfo().catch(() => {});
    }
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await getExtensionInstanceId();
});

const webMcpGate = new WebMcpGate();
const backend = new BrowserBackend({ webMcpGate });
const transport = new NativeTransport(NATIVE_HOST_NAME, { onDisconnect: () => { void backend.nativeDisconnected().catch(() => {}); } });
backend.nativePageDownloads = () => transport.pageDownloads;
const peer = new JsonRpcPeer(transport, backend);
async function handleAutomationControlMessage(message, sender) {
  if (sender?.id !== chrome.runtime.id || sender?.url !== chrome.runtime.getURL("popup.html")) {
    throw new Error("OBU_CONTROL_FORBIDDEN: user control is only available from the extension popup");
  }
  if (message.type === "GET_AUTOMATION_CONTROL_STATUS") return backend.getAutomationControlStatus();
  if (sender.tab || typeof chrome.runtime.getContexts !== "function") {
    throw new Error("OBU_CONTROL_FORBIDDEN: a real extension action popup is required");
  }
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["POPUP"], ...(typeof sender.documentId === "string" ? { documentIds: [sender.documentId] } : {}) });
  if (!contexts.some(context => context.contextType === "POPUP" && (sender.documentId === undefined || context.documentId === sender.documentId) && context.documentUrl === chrome.runtime.getURL("popup.html"))) {
    throw new Error("OBU_CONTROL_FORBIDDEN: the sending popup is no longer open");
  }
  if (message.type === "PAUSE_AUTOMATION") return backend.pauseAutomation();
  return backend.resumeAutomation(message.expectedRevision);
}
async function handleSiteAccessMessage(message, sender) {
  if (sender?.id !== chrome.runtime.id || sender?.url !== chrome.runtime.getURL("popup.html"))
    throw new Error("OBU_CONTROL_FORBIDDEN: website settings are only available from the extension popup");
  if (message.type === "GET_SITE_ACCESS_POLICY") return backend.getSiteAccessPolicy();
  if (sender.tab || typeof chrome.runtime.getContexts !== "function")
    throw new Error("OBU_CONTROL_FORBIDDEN: a real extension action popup is required");
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["POPUP"], ...(typeof sender.documentId === "string" ? { documentIds: [sender.documentId] } : {}) });
  if (!contexts.some(context => context.contextType === "POPUP" && (sender.documentId === undefined || context.documentId === sender.documentId) && context.documentUrl === sender.url))
    throw new Error("OBU_CONTROL_FORBIDDEN: the sending popup is no longer open");
  return backend.setSiteAccessPolicy(message.policy, message.expectedRevision);
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (["GET_SITE_ACCESS_POLICY", "SET_SITE_ACCESS_POLICY"].includes(message?.type)) {
    void handleSiteAccessMessage(message, sender).then(policy => sendResponse({ ok: true, policy }), error => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }
  if (["GET_AUTOMATION_CONTROL_STATUS", "PAUSE_AUTOMATION", "RESUME_AUTOMATION"].includes(message?.type)) {
    void handleAutomationControlMessage(message, sender).then(status => sendResponse({ ok: true, status }), async error => sendResponse({ ok: false, status: await backend.getAutomationControlStatus(), error: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === "GET_NATIVE_HOST_STATUS") {
    const status = transport.getStatus();
    sendResponse({ ok: status.state === "connected", status, error: status.error });
    return true;
  }
  if (message?.type === "GET_OPEN_BROWSER_USE_CURSOR_STATE") {
    const tabId = typeof sender.tab?.id === "number" ? sender.tab.id : -1;
    sendResponse({ ok: true, state: backend.readCursorOverlayState(tabId) });
    return true;
  }
  if (message?.type === "OPEN_BROWSER_USE_CURSOR_ARRIVED") {
    sendResponse({ ok: backend.notifyCursorArrived(message) });
    return true;
  }
  return false;
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  backend.handleCdpEvent(source, method, params);
  if (backend.isInternalCdpEvent(source, method, params)) return;
  const owner = backend.attachmentOwners.get(source?.tabId);
  void backend.cdpEventMetadata(source).then(metadata => {
    if (!metadata || backend.attachmentOwners.get(source?.tabId) !== owner) return;
    // Metadata validation and this reaction are separate microtasks. Pause,
    // epoch retirement, or attachment replacement may have happened between.
    backend.assertTransferScope(owner);
    safeSendNotification(peer, "onCDPEvent", { source, method, params, ...metadata });
  }).catch(() => {});
});
backend.addDownloadChangeListener((change) => {
  safeSendNotification(peer, "onDownloadChange", change);
});
chrome.downloads.onCreated.addListener((item) => {
  backend.handleDownloadCreated(item);
});
chrome.downloads.onChanged.addListener((delta) => {
  backend.handleDownloadChanged(delta);
});
startHeartbeat(peer, backend);

function safeSendNotification(peer, method, params) {
  try {
    peer.sendNotification(method, params);
  } catch {}
}
