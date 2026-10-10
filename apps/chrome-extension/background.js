import { createBrowserActionEngine } from "./browser-runtime.js";
import { NativeInputTracker } from "./browser-input-adapter.js";
import { BrowserNetworkWaits } from "./browser-network-waits.js";
import { BrowserNavigationWaits } from "./browser-navigation-waits.js";
import { BrowserDownloads, downloadDeadline } from "./browser-downloads.js";
import { BROWSER_ENGINE_INFO, validateBrowserAction } from "./browser-action-engine.js";
import { AuxiliaryTabOwnership } from "./auxiliary-tab-ownership.js";

const NATIVE_HOST_NAME = "com.ifuryst.open_browser_use.extension";
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
  "waitForFileChooser", "setFileChooserFiles", "waitForDownload", "downloadURL", "downloadPath", "cancelDownload", "readClipboardText", "writeClipboardText",
  "armNetworkWait", "collectNetworkWait", "cancelNetworkWait",
  "armNavigationWait", "collectNavigationWait", "cancelNavigationWait",
  "readClipboard", "writeClipboard", "turnEnded", "executeUnhandledCommand"
]);

class JsonRpcPeer {
  constructor(transport, handlers) {
    this.transport = transport;
    this.handlers = handlers;
    this.transport.setMessageCallback((message) => {
      void this.handleMessage(message);
    });
  }

  async handleMessage(message) {
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
        this.transport.sendMessage({ jsonrpc: "2.0", id, result: result ?? {} });
      }
    } catch (error) {
      if (id !== undefined) {
        this.transport.sendMessage({
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
  constructor(hostName) {
    this.hostName = hostName;
    this.port = null;
    this.messageCallback = null;
    this.reconnectAttempt = 0;
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
    try {
      const port = chrome.runtime.connectNative(this.hostName);
      this.port = port;
      this.reconnectAttempt = 0;
      this.setStatus({ state: "connected" });
      port.onMessage.addListener((message) => {
        this.messageCallback?.(message);
      });
      port.onDisconnect.addListener(() => {
        this.port = null;
        this.scheduleReconnect(chrome.runtime.lastError?.message ?? "native host disconnected");
      });
    } catch (error) {
      this.port = null;
      this.scheduleReconnect(error instanceof Error ? error.message : String(error));
    }
  }

  scheduleReconnect(error) {
    this.reconnectAttempt += 1;
    this.setStatus({
      state: "reconnecting",
      error,
      nextRetryMs: 5000,
      reconnectAttempt: this.reconnectAttempt
    });
    chrome.alarms.create(RECONNECT_ALARM_NAME, { periodInMinutes: 0.1 }).catch(() => {});
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
  constructor() {
    this.state = { sessions: {}, deliverableGroupId: null };
    this.ready = this.load();
  }

  async load() {
    const stored = await chrome.storage.local.get(SESSION_STATE_KEY);
    const value = stored[SESSION_STATE_KEY];
    if (value && typeof value === "object") {
      this.state = {
        sessions: value.sessions && typeof value.sessions === "object" ? value.sessions : {},
        deliverableGroupId:
          typeof value.deliverableGroupId === "number" ? value.deliverableGroupId : null
      };
      let migrated = false;
      for (const session of Object.values(this.state.sessions)) {
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
      if (typeof this.state.deliverableGroupId === "number") {
        await chrome.tabGroups
          .update(this.state.deliverableGroupId, { title: DELIVERABLE_GROUP_TITLE })
          .catch(() => {});
      }
    }
  }

  async save() {
    await chrome.storage.local.set({ [SESSION_STATE_KEY]: this.state });
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
  constructor(assertAdmission = () => {}) {
    this.assertAdmission = assertAdmission;
    this.records = new Map();
    this.counter = 0;
    this.noNewLegacy = false;
    this.writes = Promise.resolve();
    this.ready = this.load();
  }

  async load() {
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
  }

  save() {
    const state = JSON.parse(JSON.stringify({ version: 1, counter: this.counter, noNewLegacy: this.noNewLegacy, records: [...this.records] }));
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

  async invalidateAll() {
    await this.ready;
    this.noNewLegacy = true;
    for (const record of this.records.values()) {
      this.invalidate(record, "user-pause");
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
    const value = { version: 1, paused, revision: this.revision, pendingTabIds: [...this.pendingTabIds] };
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
    this.store = new SessionStore();
    this.controlLedger = new ControlLedger(() => this.automationControl.assertOpen());
    this.acceptedRequests = new Set();
    this.automationTransitions = Promise.resolve();
    this.pauseReleaseFailures = new Map();
    this.inputTracker = new NativeInputTracker();
    this.networkWaits = new BrowserNetworkWaits();
    this.navigationWaits = new BrowserNavigationWaits();
    this.directDownloads = new BrowserDownloads({ downloads: chrome.downloads, extensionId: chrome.runtime?.id,
      validateScope: scope => this.validateTransferScope(scope), assertScope: scope => this.assertTransferScope(scope) });
    this.navigationSetups = new Map();
    this.auxiliaryTabs = new AuxiliaryTabOwnership({ storage: chrome.storage.session });
    this.auxiliaryReleases = new Map();
    this.sessionMutations = new Map();
    this.endingSessions = new Map();
    this.webMcpGate = webMcpGate;
    this.browserEngine = browserEngine;
    this.controlEpochs = new Map();
    this.controlReleases = new Map();
    this.attachedTabs = new Set();
    this.attachmentEpochs = new Map();
    this.attachmentOwners = new Map();
    this.childSessionsByTabId = new Map();
    this.pendingAttachmentTabs = new Set();
    this.documentEpochs = new Map();
    this.activeTabsBySession = new Map();
    this.cursorByTabId = new Map();
    this.pointerFeedbackByTabId = new Map();
    this.renderingQueues = new Map();
    this.externalScreencastTabs = new Set();
    this.internalScreencasts = new Map();
    this.downloadsById = new Map();
    this.downloadWaiters = new Set();
    this.downloadChangeListeners = new Set();
    this.cursorArrivalWaitersByKey = new Map();
    this.fileChoosersById = new Map();
    this.fileChooserWaitersByTabId = new Map();
    this.fileChooserSetupsByTabId = new Map();
    this.nextDownloadSequence = 0;
    this.nextCursorMoveSequence = 1;
    chrome.debugger.onDetach.addListener((source) => {
      if (typeof source.tabId === "number") {
        this.networkWaits.invalidateTab(source.tabId);
        this.navigationWaits.invalidateTab(source.tabId);
        void this.directDownloads.invalidateTab(source.tabId);
        this.controlEpochs.set(source.tabId, (this.controlEpochs.get(source.tabId) ?? 0) + 1);
        this.browserEngine?.forget(source.tabId);
        try { this.releaseEngineAttachment(source.tabId); }
        catch (error) { this.pauseReleaseFailures.set(source.tabId, error); void this.pauseAutomation().catch(() => {}); }
      }
    });
    chrome.tabs?.onRemoved?.addListener(tabId => {
      this.networkWaits.invalidateTab(tabId);
      this.navigationWaits.invalidateTab(tabId);
      void this.directDownloads.invalidateTab(tabId);
      this.inputTracker.forget(tabId, this.attachmentEpochs.get(tabId), { destroyed: true });
      this.pauseReleaseFailures.delete(tabId);
      this.automationControl.recoveredPendingTabs?.delete(tabId);
      this.releaseEngineAttachment(tabId);
      const claim = this.auxiliaryTabs.entry(tabId);
      if (claim) void this.releaseAuxiliaryClaim(claim, { destroyed: true }).catch(() => {});
    });
    chrome.tabs?.onUpdated?.addListener((tabId, change) => {
      if (Object.hasOwn(change, "groupId")) this.networkWaits.invalidateTab(tabId);
      if (Object.hasOwn(change, "groupId")) this.navigationWaits.invalidateTab(tabId);
      if (Object.hasOwn(change, "groupId")) {
        this.cancelTabTransfers(tabId, new Error("OBU_TRANSFER_CANCELLED: tab ownership changed"));
        void this.directDownloads.invalidateTab(tabId);
        this.invalidateAuxiliaryTab(tabId);
      }
    });
    chrome.tabs?.onDetached?.addListener(tabId => { this.networkWaits.invalidateTab(tabId); this.navigationWaits.invalidateTab(tabId); this.cancelTabTransfers(tabId, new Error("OBU_TRANSFER_CANCELLED: tab moved")); void this.directDownloads.invalidateTab(tabId); this.invalidateAuxiliaryTab(tabId); });
    chrome.tabs?.onReplaced?.addListener((_added, removed) => { this.networkWaits.invalidateTab(removed); this.navigationWaits.invalidateTab(removed); this.cancelTabTransfers(removed, new Error("OBU_TRANSFER_CANCELLED: tab replaced")); void this.directDownloads.invalidateTab(removed); this.invalidateAuxiliaryTab(removed); });
    this.controlReady = this.recoverControlState();
    this.controlReady.catch(error => this.automationControl.fail(error));
    for (const method of PUBLIC_BROWSER_METHODS) {
      if (["ping", "getInfo"].includes(method) || typeof this[method] !== "function") continue;
      const handler = this[method].bind(this);
      if (method === "downloadURL") {
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
      } else if (method === "armNavigationWait") {
        this[method] = params => this.startNavigationWait(params);
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
          const reservation = this.auxiliaryTabs.reserve(params);
          try {
            return await withTimeout(DEFAULT_CDP_TIMEOUT_MS,
              () => this.runControlledRequest(() => handler(params, reservation)),
              () => new Error("OBU_AUXILIARY_CLAIM_TIMEOUT: tab claim deadline expired"));
          } catch (error) {
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
      } else this[method] = (...args) => this.runControlledRequest(() => handler(...args));
    }
  }

  async runControlledRequest(operation) {
    await this.controlReady;
    this.automationControl.assertOpen();
    const pending = Promise.resolve().then(() => {
      this.automationControl.assertOpen();
      return operation();
    });
    this.acceptedRequests.add(pending);
    try { return await pending; }
    finally { this.acceptedRequests.delete(pending); }
  }

  async getAutomationControlStatus() {
    // A timed-out storage read must not make the failed Pause response wait on
    // that same unresolved read a second time merely to display its status.
    if (this.automationControl.state !== "error") {
      try { await this.automationDeadline().within(() => this.automationControl.ready); }
      catch (error) { this.automationControl.fail(error); }
    }
    return this.automationControl.status();
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
    const auxiliary = this.auxiliaryTabs.controlSnapshot();
    const downloads = this.directDownloads.controlSnapshot();
    const tabIds = new Set([...this.attachedTabs, ...this.pendingAttachmentTabs, ...this.controlReleases.keys(), ...this.attachmentOwners.keys(), ...this.fileChooserSetupsByTabId.keys(), ...this.fileChooserWaitersByTabId.keys(), ...this.cursorByTabId.keys(), ...this.pointerFeedbackByTabId.keys(), ...engine.tabIds, ...input.tabIds, ...network.tabIds, ...navigation.tabIds, ...auxiliary.tabIds, ...downloads.tabIds]);
    for (const waiter of this.downloadWaiters) tabIds.add(waiter.scope.tabId);
    return { tabIds, pending: [...this.acceptedRequests, ...this.controlReleases.values(), ...this.auxiliaryReleases.values(), ...this.navigationSetups.values(), ...this.renderingQueues.values(), ...engine.pending, ...input.pending, ...network.pending, ...navigation.pending, ...auxiliary.pending, ...downloads.pending, ...[...this.sessionMutations.values()].flatMap(values => [...values])] };
  }

  cancelGlobalControl() {
    const snapshot = this.globalControlSnapshot();
    const error = new Error("OBU_AUTOMATION_PAUSED: browser automation was paused by the user");
    this.networkWaits.invalidateAll();
    this.navigationWaits.invalidateAll();
    this.auxiliaryTabs.cancelPending();
    for (const setup of this.fileChooserSetupsByTabId.values()) setup.reject(error);
    for (const resolve of this.cursorArrivalWaitersByKey.values()) resolve();
    this.cursorArrivalWaitersByKey.clear();
    this.cursorByTabId.clear();
    for (const tabId of snapshot.tabIds) void this.publishCursorState(tabId).catch(() => {});
    const releases = [this.directDownloads.invalidateAll(), ...[...snapshot.tabIds].map(tabId => {
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
    for (const tabId of gate.recoveredPendingTabs) {
      try {
        await within(() => chrome.tabs.get(tabId));
        errors.push(new Error("OBU_INPUT_RELEASE_UNCONFIRMED: cannot confirm previous input release after worker restart; close the previously controlled pages, then retry Pause"));
      } catch (error) {
        if (/no tab with (given )?id|invalid tab id/i.test(String(error?.message ?? error))) {
          gate.recoveredPendingTabs.delete(tabId);
          gate.pendingTabIds.delete(tabId);
        } else errors.push(error);
      }
    }
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
    let { extensionInstanceId } = await chrome.storage.local.get("extensionInstanceId");
    if (typeof extensionInstanceId !== "string") {
      extensionInstanceId = crypto.randomUUID();
      await chrome.storage.local.set({ extensionInstanceId });
    }
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
        auxiliaryTabsVersion: 1,
        directDownloadsVersion: 1,
        automationControl: await this.getAutomationControlStatus()
      }
    };
  }

  async createTab(params) {
    return this.runSessionMutation(params, () => this.createTabInTurn(params));
  }

  async createTabInTurn(params) {
    const session = await this.requireSession(params);
    this.automationControl.assertOpen();
    const chromeTab = await createBackgroundTab(() => this.automationControl.assertOpen());
    await this.ensureSessionGroup(session.sessionId, chromeTab.id, "agent");
    await this.setSessionActiveTab(session.sessionId, chromeTab.id);
    return { ...toBrowserTab(chromeTab), active: true };
  }

  async getTabs(params) {
    return this.runSessionMutation(params, () => this.getTabsInTurn(params));
  }

  async getTabsInTurn(params) {
    const session = await this.requireSession(params);
    const tabs = await this.getSessionTabs(session.sessionId);
    return await this.withLogicalActive(session.sessionId, tabs.map(toBrowserTab));
  }

  async getUserTabs(params) {
    await this.requireSession(params);
    const tabs = (await chrome.tabs.query({}))
      .filter(hasTabId)
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

  async claimUserTab(params, reservation) {
    reservation = this.auxiliaryTabs.check(reservation);
    return this.runSessionMutation(params, () => this.claimUserTabInTurn(params, reservation));
  }

  async claimUserTabInTurn(params, reservation) {
    const session = await this.requireSession(params);
    const tabId = requireTabId(params, "claimUserTab");
    const epoch = this.controlLedger.assertCurrent(params).epoch;
    const revision = this.automationControl.revision;
    const check = () => {
      this.auxiliaryTabs.check(reservation);
      if (this.controlLedger.assertCurrent(params).epoch !== epoch || this.automationControl.revision !== revision)
        throw new Error("OBU_AUXILIARY_CLAIM_CANCELLED: browser control changed");
    };
    check();
    await this.auxiliaryTabs.settled(tabId);
    check();
    const tab = await chrome.tabs.get(tabId);
    check();
    if (!hasTabId(tab)) {
      throw new Error(`Chrome tab ${tabId} has no id`);
    }
    assertControllableTab(tab);
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
    if (window.type === "popup") {
      const validate = async () => {
        const live = await chrome.tabs.get(tabId);
        check();
        assertControllableTab(live);
        if (live.windowId !== tab.windowId || live.groupId !== -1 || live.url?.startsWith("chrome://"))
          throw new Error("OBU_AUXILIARY_CLAIM_CANCELLED: popup moved or became uncontrollable");
      };
      reservation = await this.auxiliaryTabs.commit(reservation, {
        windowId: tab.windowId, control_epoch: epoch, controlRevision: revision, check, validate
      });
      check();
      await this.setSessionActiveTab(session.sessionId, tab.id, check);
      check();
    } else {
      if (this.auxiliaryTabs.owner(tabId)) {
        await this.releaseAuxiliaryClaim(reservation);
        throw new Error("OBU_AUXILIARY_CLAIM_CANCELLED: popup moved; explicitly claim it again");
      }
      await this.ensureSessionGroup(session.sessionId, tab.id, "user", check);
      check();
      await this.setSessionActiveTab(session.sessionId, tab.id, check);
      check();
      await this.auxiliaryTabs.remove(reservation);
    }
    return { ...toBrowserTab(tab), active: true };
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
      if (status === "deliverable" && this.auxiliaryTabs.owner(tabId)?.session_id === session.sessionId) {
        throw new Error("OBU_AUXILIARY_DELIVERABLE_UNSUPPORTED: use handoff to preserve the popup window");
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
      for (const tab of tabs) {
        if (!hasTabId(tab)) {
          continue;
        }
        const keptStatus = keep.get(tab.id);
        if (keptStatus === "handoff") {
          handoffTabs.push(tab.id);
          continue;
        }
        if (keptStatus === "deliverable") {
          deliverableTabs.push(tab.id);
          continue;
        }
        const auxiliary = this.auxiliaryTabs.owner(tab.id);
        if (auxiliary?.session_id === session.sessionId) {
          auxiliaryToRelease.push(auxiliary);
        } else if (sessionState.tabOrigins[String(tab.id)] === "agent") {
          agentTabsToClose.push(tab.id);
        } else {
          userTabsToRelease.push(tab.id);
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
      for (const record of auxiliaryToRelease) await this.releaseAuxiliaryClaim(record);
      this.automationControl.assertOpen();
      if (agentTabsToClose.length > 0) {
        await chrome.tabs.remove(agentTabsToClose.length === 1 ? agentTabsToClose[0] : agentTabsToClose);
      }
      this.automationControl.assertOpen();
      if (userTabsToRelease.length > 0 && chrome.tabs.ungroup) {
        await chrome.tabs.ungroup(userTabsToRelease.length === 1 ? userTabsToRelease[0] : userTabsToRelease);
      }
      this.automationControl.assertOpen();
      if (deliverableTabs.length > 0) {
        await this.moveToDeliverables(deliverableTabs);
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
    this.automationControl.assertOpen();
    if (typeof sessionState.chromeGroupId === "number") {
      await chrome.tabGroups.update(sessionState.chromeGroupId, { title: name }).catch(() => {});
    }
  }

  async attach(params) {
    return this.runSessionMutation(params, () => this.attachInTurn(params));
  }

  async attachInTurn(params) {
    const tabId = requireTabId(params, "attach");
    const epoch = this.controlEpochs.get(tabId) ?? 0;
    await this.requireSessionTab(params, "attach");
    await this.controlReleases.get(tabId)?.catch(() => {});
    await this.requireSessionTab(params, "attach");
    if ((this.controlEpochs.get(tabId) ?? 0) !== epoch) throw new Error("Browser attachment was cancelled because tab control ended");
    await this.releasePreviousAttachmentOwner(params, tabId);
    this.automationControl.assertOpen();
    if (this.browserEngine) {
      await this.browserEngine.attach(tabId);
      this.rememberAttachmentOwner(params, tabId);
      return;
    }
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
        await this.registerEngineAttachment(tabId);
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
      authorize: async (params) => {
        await this.requireSessionTab(params, "browserAction");
        this.rememberAttachmentOwner(params, params.tabId);
      },
      onBeforeAttach: (tabId) => this.prepareEngineAttachment(tabId),
      onAttached: (tabId) => this.registerEngineAttachment(tabId),
      onDetached: (tabId) => this.releaseEngineAttachment(tabId),
      aroundAction: ({ params, timeoutMs, run }) => this.withRenderingLease({ tabId: params.tabId }, timeoutMs, run, params.action),
      isInternalEvent: (source, method, params) => this.isInternalCdpEvent(source, method, params),
      inputHooks: {
        send: (target, method, params, operation) => {
          this.automationControl.assertOpen();
          const token = this.attachmentEpochs.get(target.tabId);
          this.inputTracker.assertSend(target.tabId, token);
          return this.inputTracker.send(target, token, method, params, operation);
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
    const startedAt = Date.now();
    const timeoutMs = params.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("timeoutMs must be between 1 and 120000");
    const deadlineAt = performance.now() + timeoutMs;
    const remaining = () => {
      const value = deadlineAt - performance.now();
      if (value < 1) throw new Error("Browser action timed out during admission");
      return value;
    };
    if (params.action === "goto") assertControllableUrl(params.args?.url);
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
    const setup = this.fileChooserSetupsByTabId.get(tabId);
    if (setup?.sessionId !== params.session_id && (this.controlEpochs.get(tabId) ?? 0) !== epoch) {
      throw new Error("Browser action was cancelled while loading the engine");
    }
    if (setup?.sessionId === params.session_id) {
      await this.withinTransferDeadline(startedAt + timeoutMs, () => setup.promise);
      await this.requireSessionTab(params, "browserAction");
    }
    return await engine.dispatch({ ...params, timeoutMs: remaining() });
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
    return [...this.navigationSetups].filter(([record]) => {
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

  async prepareEngineAttachment(tabId) {
    this.automationControl.assertOpen();
    // CRX must establish its own protocol state. Release only a raw attachment
    // that this backend actually owns; never detach a competing debugger.
    if (this.attachedTabs.has(tabId)) {
      await this.releaseTrackedInput(tabId);
      await chrome.debugger.detach({ tabId });
      this.releaseEngineAttachment(tabId);
    }
    this.automationControl.assertOpen();
    const token = {};
    this.inputTracker.register(tabId, token);
    this.attachmentEpochs.set(tabId, token);
    this.pendingAttachmentTabs.add(tabId);
  }

  async registerEngineAttachment(tabId) {
    // Shared with the action engine after it owns the native attachment. Keep
    // background pages responsive without activating their tab or window.
    // Chrome resets this renderer override when the debugger detaches.
    this.automationControl.assertOpen();
    if (!this.attachmentEpochs.has(tabId)) this.attachmentEpochs.set(tabId, {});
    this.inputTracker.register(tabId, this.attachmentEpochs.get(tabId));
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
    this.automationControl.assertOpen();
    this.attachedTabs.add(tabId);
    this.pendingAttachmentTabs.delete(tabId);
  }

  releaseEngineAttachment(tabId) {
    // A cold network arm reserves capacity before the raw-to-CRX migration.
    // Release only waits bound to the retiring Page here. External detach,
    // explicit cancellation and ownership events also retire unbound setups.
    this.networkWaits.invalidateAttachedTab(tabId);
    this.navigationWaits.invalidateAttachedTab(tabId);
    void this.directDownloads.invalidateAttachedTab(tabId);
    this.inputTracker.forget(tabId, this.attachmentEpochs.get(tabId));
    this.cancelTabTransfers(tabId, new Error("OBU_TRANSFER_CANCELLED: tab control ended"));
    this.attachmentOwners.delete(tabId);
    this.childSessionsByTabId.delete(tabId);
    this.pendingAttachmentTabs.delete(tabId);
    this.documentEpochs.delete(tabId);
    this.internalScreencasts.get(tabId)?.cancel?.();
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
    const session = await this.requireSession(params);
    const target = await this.resolveCdpTarget(params);
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
    const setup = this.fileChooserSetupsByTabId.get(target?.tabId);
    if (setup?.sessionId === params.session_id) await this.withinTransferDeadline(startedAt + timeoutMs, () => setup.promise);
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
      if (params.method === "Page.captureScreenshot" && target.sessionId === undefined) {
        return await this.captureScreenshot(target, params.commandParams ?? {}, remaining);
      }
      const response = await this.inputTracker.send(target, this.attachmentEpochs.get(target.tabId), params.method, params.commandParams ?? {}, () => chrome.debugger.sendCommand(target, params.method, params.commandParams ?? {}));
      if (target.sessionId === undefined && params.method === "Page.startScreencast") {
        this.externalScreencastTabs.add(target.tabId);
      } else if (target.sessionId === undefined && params.method === "Page.stopScreencast") {
        this.externalScreencastTabs.delete(target.tabId);
      }
      return response;
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

  async withRenderingLease(target, timeoutMs, operation, action = "rendered action") {
    const tabId = target.tabId;
    const previous = this.renderingQueues.get(tabId) ?? Promise.resolve();
    const deadline = Date.now() + timeoutMs;
    const attachment = this.attachmentEpochs.get(tabId);
    let expired = false;
    let phase = `waiting in rendering queue for ${action}`;
    const timeoutError = () => Object.assign(new Error(`Timed out after ${timeoutMs}ms ${phase}.`), { name: "TimeoutError" });
    const withinDeadline = (operation) => withTimeout(Math.max(1, deadline - Date.now()), operation, timeoutError);
    const ownsAttachment = () => this.attachedTabs.has(tabId) && this.attachmentEpochs.get(tabId) === attachment;
    const assertCurrent = () => {
      this.automationControl.assertOpen();
      if (expired || Date.now() >= deadline || !ownsAttachment()) throw new Error(`Rendering request expired before ${action}`);
    };
    const queued = previous.catch(() => {}).then(async () => {
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
      stream.cancel = () => {
        expired = true;
        chrome.debugger.onEvent.removeListener(onFrame);
        const error = new Error("Rendered action was cancelled because tab control ended");
        rejectFrame(error);
        cancelCapture(error);
      };
      try {
        return await withinDeadline(async () => {
          phase = `waiting for background frame before ${action}`;
          // Keep rendering active throughout a screenshot or pointer action.
          // Stopping after a warm-up frame lets hidden renderers stall again
          // during capture, or leaves a new iframe's hit-test surface stale.
          await chrome.debugger.sendCommand(target, "Page.enable");
          assertCurrent();
          stream.active = true;
          await chrome.debugger.sendCommand(target, "Page.startScreencast", {
            format: "png", everyNthFrame: 1
          }).then(async () => {
            started = true;
            if (expired && ownsAttachment()) await chrome.debugger.sendCommand(target, "Page.stopScreencast").catch(() => {});
          });
          assertCurrent();
          await frame;
          assertCurrent();
          phase = `running ${action}`;
          const result = await Promise.race([operation(), cancelled]);
          assertCurrent();
          return result;
        });
      } finally {
        expired = true;
        chrome.debugger.onEvent.removeListener(onFrame);
        rejectFrame(new Error("Rendering frame waiter closed"));
        if (started && ownsAttachment()) {
          await withTimeout(1_000, () => chrome.debugger.sendCommand(target, "Page.stopScreencast")).catch(() => {});
        }
        stream.active = false;
        delete stream.cancel;
      }
    });
    this.renderingQueues.set(tabId, queued);
    const cleanup = () => {
      if (this.renderingQueues.get(tabId) === queued) this.renderingQueues.delete(tabId);
    };
    queued.then(cleanup, cleanup);
    try {
      return await withTimeout(timeoutMs, () => queued, timeoutError);
    } finally {
      expired = true;
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
    if (this.automationControl.inputBlocked) return;
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
    const isCurrent = () => !expired && this.attachedTabs.has(tabId) &&
      this.pointerFeedbackByTabId.get(tabId) === queue && this.cursorByTabId.get(tabId) === cursor;
    try {
      await withTimeout(POINTER_FEEDBACK_TIMEOUT_MS, async () => {
        if (!(await this.ensureCursorContentScript(params.session_id, tabId)) || !isCurrent()) {
          return;
        }
        await chrome.tabs.sendMessage(tabId, {
          type: "OPEN_BROWSER_USE_CURSOR",
          sessionId: params.session_id,
          turnId: params.turn_id,
          ...cursor
        });
        if (event.type === "mousePressed" && isCurrent()) {
          await chrome.tabs.sendMessage(tabId, {
            type: "OPEN_BROWSER_USE_POINTER_EVENT",
            sessionId: params.session_id,
            turnId: params.turn_id,
            eventType: event.type,
            x: event.x,
            y: event.y
          });
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
    const check = options.check ?? (() => {});
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
        ownsPending = !engine.pages?.has(params.tabId);
        attaching = true;
        await engine.attach(params.tabId);
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
      if (attaching && ownsPending && (engine.generations?.get(params.tabId) ?? 0) === generation) {
        engine.detach(params.tabId).catch(() => {});
      }
      throw error;
    }
  }

  cancelTabTransfers(tabId, error) {
    this.fileChooserWaitersByTabId.get(tabId)?.reject(error);
    for (const waiter of [...this.downloadWaiters]) if (waiter.scope.tabId === tabId) waiter.reject(error);
    for (const [id, record] of this.downloadsById) if (record.scope.tabId === tabId) this.downloadsById.delete(id);
    for (const [id, chooser] of this.fileChoosersById) if (chooser.scope.tabId === tabId) this.fileChoosersById.delete(id);
  }

  async waitForFileChooser(params) {
    const deadline = this.transferDeadline(params);
    const tabId = requireTabId(params, "waitForFileChooser");
    if (this.fileChooserSetupsByTabId.has(tabId)) throw new Error(`Already waiting for file chooser in tab ${tabId}`);
    if (this.fileChooserSetupsByTabId.size >= 128) throw new Error("File chooser setup capacity reached");
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    promise.catch(() => {});
    const setup = { sessionId: params.session_id, promise, resolve, reject };
    this.fileChooserSetupsByTabId.set(tabId, setup);
    try {
      // Establish the same CRX attachment that a following browserAction uses.
      // Otherwise its first raw-to-engine migration would tear down interception.
      await this.prepareTransferAttachment(params, deadline);
      return await this.waitForFileChooserInTurn(params, deadline, setup);
    } catch (error) {
      setup.reject(error);
      throw error;
    } finally {
      if (this.fileChooserSetupsByTabId.get(tabId) === setup) this.fileChooserSetupsByTabId.delete(tabId);
    }
  }

  async waitForFileChooserInTurn(params, deadline, setup) {
    const scope = await this.transferScope(params, "waitForFileChooser", deadline);
    const tabId = scope.tabId;
    if (this.fileChooserWaitersByTabId.has(tabId)) throw new Error(`Already waiting for file chooser in tab ${tabId}`);
    if (this.fileChooserWaitersByTabId.size >= 128) throw new Error("File chooser wait capacity reached");
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    promise.catch(() => {});
    const waiter = { scope, resolve, reject, targets: new Map(), deadline };
    this.fileChooserWaitersByTabId.set(tabId, waiter);
    try {
      const sessions = [undefined, ...this.childSessionsByTabId.get(tabId) ?? []];
      await Promise.race([Promise.all(sessions.map(sessionId => this.enableFileChooserTarget(waiter, sessionId))), promise]);
      this.assertTransferScope(scope);
      setup.resolve();
      return await this.withinTransferDeadline(deadline, () => promise);
    } finally {
      waiter.closed = true;
      // Keep this identity through cleanup so an old waiter cannot disable its
      // successor's interception on the same attachment.
      if (this.attachmentEpochs.get(tabId) === scope.attachment) {
        await Promise.allSettled([...waiter.targets.values()]);
        await Promise.allSettled([...waiter.targets.keys()].map(sessionId => withTimeout(300, () =>
          chrome.debugger.sendCommand({ tabId, ...(sessionId ? { sessionId } : {}) }, "Page.setInterceptFileChooserDialog", { enabled: false }))));
      }
      if (this.fileChooserWaitersByTabId.get(tabId) === waiter) this.fileChooserWaitersByTabId.delete(tabId);
    }
  }

  enableFileChooserTarget(waiter, sessionId) {
    if (waiter.targets.has(sessionId)) return waiter.targets.get(sessionId);
    const pending = this.withinTransferDeadline(waiter.deadline, async () => {
      this.assertTransferScope(waiter.scope);
      await chrome.debugger.sendCommand({ tabId: waiter.scope.tabId, ...(sessionId ? { sessionId } : {}) }, "Page.setInterceptFileChooserDialog", { enabled: true });
      this.assertTransferScope(waiter.scope);
    });
    waiter.targets.set(sessionId, pending);
    pending.catch(waiter.reject);
    return pending;
  }

  async setFileChooserFiles(params) {
    await this.requireSession(params);
    if (typeof params.fileChooserId !== "string" || !params.fileChooserId) throw new Error("setFileChooserFiles requires fileChooserId");
    const chooser = this.fileChoosersById.get(params.fileChooserId);
    if (!chooser || chooser.scope.session_id !== params.session_id) throw new Error("Unknown or unowned file chooser id");
    this.assertTransferScope(chooser.scope);
    await this.requireSessionTab({ ...params, tabId: chooser.scope.tabId }, "setFileChooserFiles");
    if (!Array.isArray(params.files) || params.files.some(file => typeof file !== "string" || !file)) throw new Error("setFileChooserFiles requires an array of non-empty file paths");
    if (!chooser.isMultiple && params.files.length > 1) throw new Error("File chooser does not accept multiple files");
    this.assertTransferScope(chooser.scope);
    if (this.fileChoosersById.get(params.fileChooserId) !== chooser) throw new Error("File chooser became stale");
    if (params.files.length === 0) {
      const node = await chrome.debugger.sendCommand(chooser.target, "DOM.resolveNode", { backendNodeId: chooser.backendNodeId });
      const objectId = node.object?.objectId;
      if (!objectId) throw new Error("File chooser node is no longer available");
      try {
        this.assertTransferScope(chooser.scope);
        if (this.fileChoosersById.get(params.fileChooserId) !== chooser) throw new Error("File chooser became stale");
        const result = await chrome.debugger.sendCommand(chooser.target, "Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: 'function() { if (this.tagName !== "INPUT" || this.type !== "file") throw new Error("File chooser node is not a file input"); this.value = ""; this.dispatchEvent(new Event("input", {bubbles: true})); this.dispatchEvent(new Event("change", {bubbles: true})); return this.files.length; }',
          returnByValue: true
        });
        if (result.exceptionDetails || result.result?.value !== 0) throw new Error("Unable to clear file chooser input");
      } finally {
        await chrome.debugger.sendCommand(chooser.target, "Runtime.releaseObject", { objectId }).catch(() => {});
      }
    } else {
      await chrome.debugger.sendCommand(chooser.target, "DOM.setFileInputFiles", { backendNodeId: chooser.backendNodeId, files: params.files });
    }
    this.fileChoosersById.delete(params.fileChooserId);
  }

  async waitForDownload(params) {
    const deadline = this.transferDeadline(params);
    const scope = await this.transferScope(params, "waitForDownload", deadline);
    if ([...this.downloadWaiters].some(waiter => waiter.scope.tabId === scope.tabId)) throw new Error(`Already waiting for download in tab ${scope.tabId}`);
    if (this.downloadWaiters.size >= 128) throw new Error("Download wait capacity reached");
    const since = this.nextDownloadSequence;
    const waiting = this.waitForDownloadChange(scope, record => record.sequence > since, deadline);
    waiting.catch(() => {});
    try {
      await this.withinTransferDeadline(deadline, () => chrome.debugger.sendCommand({ tabId: scope.tabId }, "Page.enable"));
      const download = await waiting;
      this.assertTransferScope(scope);
      await this.requireSessionTab(scope, "waitForDownload");
      return { downloadId: download.id };
    } catch (error) {
      for (const waiter of [...this.downloadWaiters]) if (waiter.scope === scope) waiter.reject(error);
      throw error;
    }
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

  async cancelDownload(params, deadline) {
    if (deadline <= Date.now()) throw new Error("OBU_DOWNLOAD_TIMEOUT: download operation deadline expired");
    await this.requireSession(params);
    if (this.downloadsById.has(params.downloadId)) {
      const record = this.downloadsById.get(params.downloadId);
      if (record.scope.session_id !== params.session_id) throw new Error("OBU_DOWNLOAD_EXPIRED: unknown or unowned download");
      await this.validateTransferScope(record.scope);
      this.assertTransferScope(record.scope);
      throw new Error("OBU_DOWNLOAD_CANCEL_UNSUPPORTED: webpage GUIDs cannot be cancelled by the direct download API");
    }
    return this.directDownloads.cancel(params, deadline);
  }

  async downloadPath(params, deadline) {
    if (deadline <= Date.now()) throw new Error("OBU_DOWNLOAD_TIMEOUT: download operation deadline expired");
    await this.requireSession(params);
    if (this.directDownloads.has(params.downloadId)) return this.directDownloads.path(params, deadline);
    const record = this.downloadsById.get(params.downloadId);
    if (!record || record.scope.session_id !== params.session_id) throw new Error("OBU_DOWNLOAD_EXPIRED: Unknown or unowned download id");
    this.assertTransferScope(record.scope);
    await this.requireSessionTab({ ...params, tabId: record.scope.tabId }, "downloadPath");
    throw new Error("OBU_DOWNLOAD_PATH_UNAVAILABLE: Chrome's tab-scoped download events do not expose a proven local path");
  }

  async readClipboardText(params) {
    await this.requireSessionTab(params, "readClipboardText");
    const tabId = requireTabId(params, "readClipboardText");
    if (!this.attachedTabs.has(tabId)) {
      await this.attach(params);
    }
    const text = await this.evaluateJavascript(tabId, "navigator.clipboard.readText()", true);
    return { text: typeof text === "string" ? text : "" };
  }

  async writeClipboardText(params) {
    await this.requireSessionTab(params, "writeClipboardText");
    const tabId = requireTabId(params, "writeClipboardText");
    if (typeof params.text !== "string") {
      throw new Error("writeClipboardText requires text");
    }
    if (!this.attachedTabs.has(tabId)) {
      await this.attach(params);
    }
    await this.evaluateJavascript(tabId, `navigator.clipboard.writeText(${JSON.stringify(params.text)})`, true);
  }

  async readClipboard(params) {
    await this.requireSessionTab(params, "readClipboard");
    const tabId = requireTabId(params, "readClipboard");
    if (!this.attachedTabs.has(tabId)) {
      await this.attach(params);
    }
    const items = await this.evaluateJavascript(
      tabId,
      `((async () => {
        const clipboardItems = await navigator.clipboard.read();
        return await Promise.all(clipboardItems.map(async (item) => {
          const entries = await Promise.all(item.types.map(async (type) => {
            const blob = await item.getType(type);
            if (type.startsWith("text/")) {
              return { mime_type: type, text: await blob.text() };
            }
            const base64 = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () => reject(reader.error);
              reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
              reader.readAsDataURL(blob);
            });
            return { mime_type: type, base64 };
          }));
          return { entries, presentation_style: item.presentationStyle ?? "unspecified" };
        }));
      })())`,
      true
    );
    return { items: Array.isArray(items) ? items : [] };
  }

  async writeClipboard(params) {
    await this.requireSessionTab(params, "writeClipboard");
    const tabId = requireTabId(params, "writeClipboard");
    if (!Array.isArray(params.items)) {
      throw new Error("writeClipboard requires items");
    }
    if (!this.attachedTabs.has(tabId)) {
      await this.attach(params);
    }
    await this.evaluateJavascript(
      tabId,
      `((async (items) => {
        const clipboardItems = items.map((item) => {
          const entries = {};
          for (const entry of item.entries ?? []) {
            const mime = entry.mime_type;
            if (!mime) continue;
            if (entry.text !== undefined) {
              entries[mime] = new Blob([entry.text], { type: mime });
            } else if (entry.base64 !== undefined) {
              const binary = atob(entry.base64);
              const bytes = new Uint8Array(binary.length);
              for (let index = 0; index < binary.length; index += 1) {
                bytes[index] = binary.charCodeAt(index);
              }
              entries[mime] = new Blob([bytes], { type: mime });
            }
          }
          return new ClipboardItem(entries, { presentationStyle: item.presentation_style ?? "unspecified" });
        });
        await navigator.clipboard.write(clipboardItems);
      })(${JSON.stringify(params.items)}))`,
      true
    );
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
    if (method === "Target.attachedToTarget" && typeof params.sessionId === "string" && params.targetInfo?.type === "iframe") {
      const sessions = this.childSessionsByTabId.get(tabId) ?? new Set();
      sessions.add(params.sessionId); this.childSessionsByTabId.set(tabId, sessions);
      const waiter = this.fileChooserWaitersByTabId.get(tabId);
      if (waiter) void this.enableFileChooserTarget(waiter, params.sessionId).catch(() => {});
    }
    if (method === "Target.detachedFromTarget") {
      this.childSessionsByTabId.get(tabId)?.delete(params.sessionId);
      for (const [id, chooser] of this.fileChoosersById) if (chooser.target.sessionId === params.sessionId && chooser.scope.tabId === tabId) this.fileChoosersById.delete(id);
    }
    if (method === "Page.frameNavigated") {
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
    } catch { if (this.downloadsById.get(params.guid) === record) this.downloadsById.delete(params.guid); }
  }

  async handleFileChooserOpened(source, params) {
      const tabId = source.tabId;
      const waiter = this.fileChooserWaitersByTabId.get(tabId);
      if (!waiter || waiter.opened || waiter.closed) return;
      waiter.opened = true;
      const documentEpoch = this.documentEpochs.get(tabId);
      try {
        await this.validateTransferScope(waiter.scope);
        this.assertTransferScope(waiter.scope);
        if (this.fileChooserWaitersByTabId.get(tabId) !== waiter || this.documentEpochs.get(tabId) !== documentEpoch) throw new Error("File chooser became stale");
        if (source.sessionId && !this.childSessionsByTabId.get(tabId)?.has(source.sessionId)) throw new Error("Unowned file chooser child session");
        if (!Number.isInteger(params.backendNodeId)) throw new Error("File chooser event did not include backendNodeId");
        if (this.fileChoosersById.size >= 128) throw new Error("File chooser capacity reached");
        const fileChooserId = crypto.randomUUID(), isMultiple = params.mode === "selectMultiple";
        this.fileChoosersById.set(fileChooserId, { scope: waiter.scope, target: { tabId, ...(source.sessionId ? { sessionId: source.sessionId } : {}) },
          frameId: params.frameId, backendNodeId: params.backendNodeId, isMultiple });
        waiter.resolve({ fileChooserId, isMultiple });
      } catch (error) { waiter.reject(error); }
  }

  async handleOwnedDownload(source, params) {
    const waiter = [...this.downloadWaiters].find(item => item.scope.tabId === source.tabId);
    if (!waiter || typeof params.guid !== "string" || this.downloadsById.has(params.guid)) return;
    this.assertTransferScope(waiter.scope);
    if (this.downloadsById.size >= 128) {
      const completed = [...this.downloadsById].find(([, item]) => ["complete", "canceled"].includes(item.status));
      if (completed) this.downloadsById.delete(completed[0]);
      else { waiter.reject(new Error("Download tracking capacity reached")); return; }
    }
    const record = { id: params.guid, scope: waiter.scope, targetSessionId: source.sessionId, sequence: ++this.nextDownloadSequence,
      url: params.url, suggestedFilename: params.suggestedFilename, status: "started", authorized: false };
    this.downloadsById.set(params.guid, record);
    try {
      await this.validateTransferScope(waiter.scope);
      this.assertTransferScope(waiter.scope);
      if (this.downloadsById.get(params.guid) !== record) return;
      record.authorized = true;
      this.emitDownloadChange(record);
    } catch { if (this.downloadsById.get(params.guid) === record) this.downloadsById.delete(params.guid); }
  }

  readCursorOverlayState(tabId) {
    if (this.automationControl.inputBlocked) return { cursor: null, isVisible: false, sessionId: null, turnId: null };
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
    for (const waiter of [...this.downloadWaiters]) {
      if (waiter.scope.session_id === record.scope.session_id && waiter.scope.control_epoch === record.scope.control_epoch && waiter.scope.tabId === record.scope.tabId && waiter.predicate(record)) waiter.resolve(record);
    }
    const { session_id, turn_id, control_epoch, tabId } = record.scope;
    const change = { id: record.id, url: record.url, status: record.status, suggestedFilename: record.suggestedFilename, session_id, turn_id, control_epoch, tabId };
    for (const listener of this.downloadChangeListeners) listener(change);
  }

  waitForDownloadChange(scope, predicate, deadline) {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.downloadWaiters.delete(waiter); };
      const waiter = { scope, predicate, resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } };
      const timer = setTimeout(() => waiter.reject(new Error("OBU_TRANSFER_TIMEOUT: transfer deadline expired")), Math.max(0, deadline - Date.now()));
      this.downloadWaiters.add(waiter);
    });
  }

  async cdpEventMetadata(source) {
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
    this.automationControl.assertOpen();
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

  async ensureSessionGroup(sessionId, tabId, origin, check = () => this.automationControl.assertOpen()) {
    const session = await this.store.getSession(sessionId);
    check();
    let groupId = session.chromeGroupId;
    if (typeof groupId === "number") {
      try {
        await chrome.tabGroups.get(groupId);
        check();
        await chrome.tabs.group({ groupId, tabIds: [tabId] });
        check();
      } catch {
        check();
        groupId = null;
      }
    }
    check();
    if (typeof groupId !== "number") {
      groupId = await chrome.tabs.group({ tabIds: [tabId] });
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

  async setSessionActiveTab(sessionId, tabId, check = () => this.automationControl.assertOpen()) {
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
    if (typeof groupId === "number") {
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
    if (tab.windowId !== record.windowId || tab.groupId !== -1) {
      await this.releaseAuxiliaryClaim(record);
      return null;
    }
    return tab;
  }

  invalidateAuxiliaryTab(tabId) {
    const record = this.auxiliaryTabs.entry(tabId);
    // An ordinary claim also reserves the tab while it is grouped. Its own
    // group operation must not be mistaken for an auxiliary window transfer.
    if (record && record.windowId !== null)
      void this.releaseAuxiliaryClaim(record).catch(() => {});
  }

  releaseAuxiliaryClaim(record, { destroyed = false } = {}) {
    if (this.auxiliaryTabs.entry(record.tabId) !== record) return Promise.resolve();
    if (this.auxiliaryReleases.has(record)) return this.auxiliaryReleases.get(record);
    this.auxiliaryTabs.quarantine(record);
    const owner = this.attachmentOwners.get(record.tabId);
    // Revoke old engine/input admission immediately, before queued storage
    // work. A surviving foreign attachment must never be torn down by this ID.
    const controlsTab = owner ? owner.session_id === record.session_id : record.windowId !== null;
    const cleanup = destroyed || !controlsTab ? Promise.resolve() : this.detachTab(record.tabId);
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
    this.automationControl.assertOpen();
    await this.controlLedger.admit(params);
    await this.store.getSession(params.session_id);
    this.controlLedger.assertCurrent(params);
    return { sessionId: params.session_id, turnId: params.turn_id };
  }

  async getControlState(params) {
    if (typeof params?.session_id !== "string" || !params.session_id || params.session_id.length > 256) throw new Error("Missing required browser session_id");
    await this.controlReady;
    this.automationControl.assertOpen();
    const record = this.controlLedger.records.get(params.session_id);
    if (record?.status === "closing" && !this.endingSessions.has(params.session_id)) {
      await this.recoverEndedSession(params.session_id, record);
    }
    return this.controlLedger.bootstrap(params.session_id);
  }

  async runSessionMutation(params, operation) {
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
    } finally {
      operations.delete(pending);
      if (!operations.size && this.sessionMutations.get(sessionId) === operations) this.sessionMutations.delete(sessionId);
    }
  }

  async releaseSessionControl(sessionId) {
    const downloadsReleased = this.directDownloads.invalidateSession(sessionId);
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
    const outcomes = await Promise.allSettled([downloadsReleased, ...releases]);
    const failures = outcomes.filter(result => result.status === "rejected");
    if (failures.length) throw new Error(`OBU_CONTROL_RELEASE_FAILED: ${failures.map(result => String(result.reason?.message ?? result.reason)).join("; ")}`);
  }

  async endSessionControl(params, finish) {
    if (this.endingSessions.has(params.session_id)) throw new Error("OBU_CONTROL_ENDING: browser control is still being released");
    const ending = {};
    this.endingSessions.set(params.session_id, ending);
    try {
      this.controlLedger.assertCurrent(params);
      void this.directDownloads.invalidateSession(params.session_id);
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
        this.automationControl.assertOpen();
        await finish();
      } catch (error) {
        await this.clearSessionActivity(params.session_id);
        await this.controlLedger.finishEnd(record);
        throw error;
      }
      await this.clearSessionActivity(params.session_id);
      this.automationControl.assertOpen();
      const result = await this.controlLedger.finishEnd(record);
      this.automationControl.assertOpen();
      return result;
    } finally {
      if (this.endingSessions.get(params.session_id) === ending) this.endingSessions.delete(params.session_id);
    }
  }

  async recoverControlState() {
    await Promise.all([this.store.ready, this.controlLedger.ready, this.automationControl.ready, this.auxiliaryTabs.ready]);
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
      if (record.status === "active") this.controlLedger.invalidate(record, "worker-restart");
      if (record.status === "closing") recovering.push([sessionId, record]);
    }
    if (!recovering.length) return;
    await this.controlLedger.save();
    for (const [sessionId, record] of recovering) {
      // Leave a failed release fenced. Explicit bootstrap may retry cleanup;
      // unrelated sessions must still be able to recover.
      await this.recoverEndedSession(sessionId, record).catch(() => {});
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

    const storedGroupId = this.store.state.deliverableGroupId;
    let lastGroupId = null;

    for (const [windowId, windowTabIds] of tabsByWindow) {
      const existingGroups = await chrome.tabGroups
        .query({ windowId, title: DELIVERABLE_GROUP_TITLE })
        .catch(() => []);

      let primaryGroupId = null;
      if (existingGroups.length > 0) {
        const preferred =
          existingGroups.find((g) => g.id === storedGroupId) ??
          existingGroups.reduce((min, g) => (g.id < min.id ? g : min), existingGroups[0]);
        primaryGroupId = preferred.id;

        for (const group of existingGroups) {
          if (group.id === primaryGroupId) continue;
          const dupTabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
          const dupTabIds = dupTabs
            .map((t) => t.id)
            .filter((id) => typeof id === "number");
          if (dupTabIds.length > 0) {
            this.automationControl.assertOpen();
            await chrome.tabs
              .group({ groupId: primaryGroupId, tabIds: dupTabIds })
              .catch(() => {});
          }
        }
      }

      if (typeof primaryGroupId === "number") {
        this.automationControl.assertOpen();
        try {
          await chrome.tabs.group({ groupId: primaryGroupId, tabIds: windowTabIds });
        } catch {
          primaryGroupId = null;
        }
      }

      if (typeof primaryGroupId !== "number") {
        this.automationControl.assertOpen();
        primaryGroupId = await chrome.tabs.group({ tabIds: windowTabIds });
      }

      this.automationControl.assertOpen();
      await chrome.tabGroups
        .update(primaryGroupId, {
          title: DELIVERABLE_GROUP_TITLE,
          color: "green",
          collapsed: false
        })
        .catch(() => {});

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

  detachTab(tabId, { preserveNetworkArming = false, preserveNavigationArming = false, preserveDirectRecord = null } = {}) {
    if (preserveNetworkArming) this.networkWaits.invalidateAttachedTab(tabId);
    else this.networkWaits.invalidateTab(tabId);
    if (preserveNavigationArming) this.navigationWaits.invalidateAttachedTab(tabId);
    else this.navigationWaits.invalidateTab(tabId);
    this.controlEpochs.set(tabId, (this.controlEpochs.get(tabId) ?? 0) + 1);
    // Input release may fail and deliberately retain the native attachment.
    // End the rendering lease immediately even in that case.
    this.internalScreencasts.get(tabId)?.cancel?.();
    const downloadsReleased = this.directDownloads.invalidateTab(tabId, preserveDirectRecord);
    // A repeated explicit detach must also cancel a reservation intentionally
    // preserved by an earlier owner migration. Reuse the actual native release,
    // but keep the barrier until both it and this new cleanup have settled.
    const nativeRelease = this.controlReleases.get(tabId) ?? this.releaseTabControl(tabId);
    const release = Promise.allSettled([downloadsReleased, nativeRelease]).then(results => {
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
    });
    this.controlReleases.set(tabId, release);
    const cleanup = () => {
      if (this.controlReleases.get(tabId) === release) this.controlReleases.delete(tabId);
    };
    release.then(cleanup, cleanup);
    return release;
  }

  async releaseTabControl(tabId) {
    this.clearPointerFeedback(tabId);
    this.externalScreencastTabs.delete(tabId);
    let engineError;
    try {
      await this.browserEngine?.detach(tabId);
    } catch (error) {
      engineError = error;
    }
    // A debugger detach does not release renderer-held pointer/key state. Keep
    // the original native target and token if normal input cleanup is uncertain.
    await this.releaseTrackedInput(tabId);
    await chrome.debugger.detach({ tabId }).catch((error) => {
      if (!/not attached|no tab with given id/i.test(String(error?.message ?? error))) throw error;
    });
    this.releaseEngineAttachment(tabId);
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
      release: () => isCurrent()
        ? this.inputTracker.release(tabId, token, (target, method, params) => chrome.debugger.sendCommand(target, method, params))
        : Promise.resolve(),
      detach: () => isCurrent() ? chrome.debugger.detach({ tabId }) : Promise.resolve()
    };
  }

  async ensureCursorContentScript(sessionId, tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "OPEN_BROWSER_USE_PING" });
      if (response?.ok) {
        return true;
      }
    } catch {}
    if (this.automationControl.inputBlocked) return false;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content-cursor.js"]
      });
      return true;
    } catch {
      return false;
    }
  }

  async requireWebMcpEnabled() {
    if ((await this.webMcpGate?.enabled?.()) !== true) {
      throw new Error("WebMCP capability is disabled");
    }
  }

  async sendWebMcpRequest(tabId, request, timeoutMs) {
    await this.ensureWebMcpContentScripts(tabId);
    this.automationControl.assertOpen();
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
      this.automationControl.assertOpen();
      await chrome.scripting.executeScript({
        files: ["content-webmcp-main.js"],
        target: { tabId },
        world: "MAIN"
      });
      this.automationControl.assertOpen();
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
    if (!(await this.ensureCursorContentScript(null, tabId))) {
      return false;
    }
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "OPEN_BROWSER_USE_CURSOR_STATE",
        state: this.readCursorOverlayState(tabId)
      });
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

async function createBackgroundTab(assertAdmission = () => {}) {
  const windowId = await chooseWindowId();
  assertAdmission();
  if (typeof windowId === "number") {
    const tab = await chrome.tabs.create({ active: false, url: "about:blank", windowId });
    if (hasTabId(tab)) {
      return tab;
    }
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
  const { extensionInstanceId } = await chrome.storage.local.get("extensionInstanceId");
  if (typeof extensionInstanceId !== "string") {
    await chrome.storage.local.set({ extensionInstanceId: crypto.randomUUID() });
  }
});

const webMcpGate = new WebMcpGate();
const backend = new BrowserBackend({ webMcpGate });
const transport = new NativeTransport(NATIVE_HOST_NAME);
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
