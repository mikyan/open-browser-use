import { createBrowserActionEngine } from "./browser-runtime.js";

const NATIVE_HOST_NAME = "com.ifuryst.open_browser_use.extension";
const NATIVE_HOST_STATUS_KEY = "OPEN_BROWSER_USE_NATIVE_HOST_STATUS";
const SESSION_STATE_KEY = "OPEN_BROWSER_USE_SESSION_STATE";
const CONTROL_STATE_KEY = "OPEN_BROWSER_USE_CONTROL_STATE";
const MAX_CONTROL_SESSIONS = 64;
const MAX_LEGACY_TURNS = 256;
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
  "waitForFileChooser", "setFileChooserFiles", "waitForDownload", "downloadPath", "readClipboardText", "writeClipboardText",
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
  constructor() {
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
    const record = { epoch: this.nextEpoch(), status: "idle", legacyTurns: [], legacyBlocked: false };
    this.records.set(sessionId, record);
    return record;
  }

  describe(record) {
    return { controlEpoch: record.epoch, closing: record.status === "closing", nextTurnId: `turn-${record.epoch}`, lifecycleVersion: 1 };
  }

  async bootstrap(sessionId) {
    await this.ready;
    const record = this.records.get(sessionId) ?? this.create(sessionId);
    await this.save();
    return this.describe(record);
  }

  assertCurrent(params) {
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

  async finishEnd(record) {
    record.status = "idle";
    await this.save();
    const { closing, ...state } = this.describe(record);
    return { ...state, endedTurnId: record.endedTurnId };
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
  constructor({ webMcpGate = null, browserEngine = null } = {}) {
    this.store = new SessionStore();
    this.controlLedger = new ControlLedger();
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
        this.controlEpochs.set(source.tabId, (this.controlEpochs.get(source.tabId) ?? 0) + 1);
        this.browserEngine?.forget(source.tabId);
        this.releaseEngineAttachment(source.tabId);
      }
    });
    this.controlReady = this.recoverControlState();
    this.controlReady.catch(() => {});
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
        turnLifecycleVersion: 1
      }
    };
  }

  async createTab(params) {
    return this.runSessionMutation(params, () => this.createTabInTurn(params));
  }

  async createTabInTurn(params) {
    const session = await this.requireSession(params);
    const chromeTab = await createBackgroundTab();
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

  async claimUserTab(params) {
    return this.runSessionMutation(params, () => this.claimUserTabInTurn(params));
  }

  async claimUserTabInTurn(params) {
    const session = await this.requireSession(params);
    const tabId = requireTabId(params, "claimUserTab");
    const tab = await chrome.tabs.get(tabId);
    if (!hasTabId(tab)) {
      throw new Error(`Chrome tab ${tabId} has no id`);
    }
    if (tab.url?.startsWith("chrome://")) {
      throw new Error(`Chrome internal tab ${tabId} cannot be claimed`);
    }
    if (typeof tab.groupId === "number" && tab.groupId !== -1) {
      const owner = await this.store.findSessionByGroup(tab.groupId);
      if (owner && owner.sessionId !== session.sessionId) {
        throw new Error(`Tab ${tabId} is already part of browser session ${owner.sessionId}`);
      }
    }
    await this.ensureSessionGroup(session.sessionId, tab.id, "user");
    await this.setSessionActiveTab(session.sessionId, tab.id);
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
      keep.set(tabId, status);
    }
    return this.endSessionControl(params, async () => {
      tabs = await this.getSessionTabs(session.sessionId, { strict: true });
      const sessionState = await this.store.getSession(session.sessionId);
      const agentTabsToClose = [];
      const userTabsToRelease = [];
      const deliverableTabs = [];
      const handoffTabs = [];
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
        if (sessionState.tabOrigins[String(tab.id)] === "agent") {
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
        ...handoffTabs
      ]);
      if (agentTabsToClose.length > 0) {
        await chrome.tabs.remove(agentTabsToClose.length === 1 ? agentTabsToClose[0] : agentTabsToClose);
      }
      if (userTabsToRelease.length > 0 && chrome.tabs.ungroup) {
        await chrome.tabs.ungroup(userTabsToRelease.length === 1 ? userTabsToRelease[0] : userTabsToRelease);
      }
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
    if (this.browserEngine) {
      await this.browserEngine.attach(tabId);
      this.rememberAttachmentOwner(params, tabId);
      return;
    }
    if (!this.attachedTabs.has(tabId)) {
      let attachedHere = false;
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
        attachedHere = true;
      } catch (error) {
        if (!String(error?.message ?? error).includes("Another debugger")) {
          throw error;
        }
      }
      try {
        await this.registerEngineAttachment(tabId);
      } catch (error) {
        // Do not leave a half-initialized debugger attached, or detach another
        // debugger when Chrome rejected our original attachment.
        if (attachedHere) await chrome.debugger.detach({ tabId }).catch(() => {});
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
      onCommand: ({ target, method, commandParams, metadata }) => {
        this.enqueuePointerFeedback({ ...metadata, target, method, commandParams });
      }
    });
    return this.browserEngine;
  }

  async browserAction(params) {
    const startedAt = Date.now();
    const tabId = requireTabId(params, "browserAction");
    let epoch = this.controlEpochs.get(tabId) ?? 0;
    await this.controlReleases.get(tabId)?.catch(() => {});
    await this.requireSessionTab(params, "browserAction");
    if (await this.releasePreviousAttachmentOwner(params, tabId)) epoch = this.controlEpochs.get(tabId) ?? 0;
    const engine = await this.getBrowserEngine();
    const setup = this.fileChooserSetupsByTabId.get(tabId);
    if (setup?.sessionId !== params.session_id && (this.controlEpochs.get(tabId) ?? 0) !== epoch) {
      throw new Error("Browser action was cancelled while loading the engine");
    }
    if (setup?.sessionId === params.session_id) {
      const timeoutMs = params.timeoutMs === undefined ? DEFAULT_CDP_TIMEOUT_MS : params.timeoutMs;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("timeoutMs must be an integer between 1 and 120000");
      await this.withinTransferDeadline(startedAt + timeoutMs, () => setup.promise);
      await this.requireSessionTab(params, "browserAction");
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining < 1) throw new Error("Browser action timed out while preparing file chooser interception");
      params = { ...params, timeoutMs: remaining };
    }
    return await engine.dispatch(params);
  }

  async releasePreviousAttachmentOwner(params, tabId) {
    const owner = this.attachmentOwners.get(tabId);
    const current = this.controlLedger.assertCurrent(params);
    if (!owner || (owner.session_id === params.session_id && owner.control_epoch === current.epoch)) return false;
    // Prove the new owner before releasing the exact old attachment. The tab
    // may have been regrouped by the user while its old Page was still alive.
    await this.requireSessionTab({ ...params, tabId }, "attachment transfer");
    if (this.attachmentOwners.get(tabId) === owner && this.attachmentEpochs.get(tabId) === owner.attachment) {
      await this.detachTab(tabId);
      await this.requireSessionTab({ ...params, tabId }, "attachment transfer");
      return true;
    }
    return false;
  }

  async prepareEngineAttachment(tabId) {
    // CRX must establish its own protocol state. Release only a raw attachment
    // that this backend actually owns; never detach a competing debugger.
    if (this.attachedTabs.has(tabId)) {
      await chrome.debugger.detach({ tabId });
      this.releaseEngineAttachment(tabId);
    }
    this.pendingAttachmentTabs.add(tabId);
  }

  async registerEngineAttachment(tabId) {
    // Shared with the action engine after it owns the native attachment. Keep
    // background pages responsive without activating their tab or window.
    // Chrome resets this renderer override when the debugger detaches.
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
    if (!this.attachedTabs.has(tabId)) this.attachmentEpochs.set(tabId, {});
    this.attachedTabs.add(tabId);
    this.pendingAttachmentTabs.delete(tabId);
  }

  releaseEngineAttachment(tabId) {
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
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) throw new Error("Timed out preparing CDP command");
    const result = await withTimeout(remaining, async () => {
      if (params.method === "Target.getTargets") {
        const tabIds = new Set((await this.getSessionTabs(session.sessionId)).map((tab) => tab.id));
        return { targetInfos: (await chrome.debugger.getTargets()).filter((info) => tabIds.has(info.tabId)) };
      }
      if (typeof params.method !== "string") {
        throw new Error("executeCdp requires method");
      }
      if (params.method === "Page.captureScreenshot" && target.sessionId === undefined) {
        return await this.captureScreenshot(target, params.commandParams ?? {}, remaining);
      }
      const response = await chrome.debugger.sendCommand(target, params.method, params.commandParams ?? {});
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

  enqueuePointerFeedback(params) {
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
    const session = Object.hasOwn(this.store.state.sessions, scope.session_id) ? this.store.state.sessions[scope.session_id] : null;
    const groupId = session?.chromeGroupId;
    if (!Number.isInteger(groupId)) throw new Error("Transfer tab is no longer owned by this session");
    const tabs = await chrome.tabs.query({ groupId });
    this.assertTransferScope(scope);
    if (this.store.state.sessions[scope.session_id] !== session || session.chromeGroupId !== groupId || !tabs.some(tab => tab.id === scope.tabId)) {
      throw new Error("Transfer tab is no longer owned by this session");
    }
  }

  async transferScope(params, command, deadline) {
    await this.withinTransferDeadline(deadline, () => this.requireSessionTab(params, command));
    if (!this.attachedTabs.has(params.tabId)) await this.prepareTransferAttachment(params, deadline);
    await this.withinTransferDeadline(deadline, () => this.requireSessionTab(params, command));
    if (deadline <= Date.now()) throw new Error("OBU_TRANSFER_TIMEOUT: transfer deadline expired");
    this.rememberAttachmentOwner(params, params.tabId);
    return { ...this.attachmentOwners.get(params.tabId) };
  }

  async prepareTransferAttachment(params, deadline) {
    let engine, generation, attaching = false, ownsPending = false;
    try {
      await this.withinTransferDeadline(deadline, async () => {
        await this.requireSessionTab(params, "transfer attachment");
        engine = await this.getBrowserEngine();
        await this.releasePreviousAttachmentOwner(params, params.tabId);
        await this.requireSessionTab(params, "transfer attachment");
        if (Date.now() >= deadline) throw new Error("OBU_TRANSFER_TIMEOUT: transfer deadline expired");
        generation = engine.generations?.get(params.tabId) ?? 0;
        ownsPending = !engine.pages?.has(params.tabId);
        attaching = true;
        await engine.attach(params.tabId);
        attaching = false;
        await this.requireSessionTab(params, "transfer attachment");
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

  async downloadPath(params) {
    await this.requireSession(params);
    const record = this.downloadsById.get(params.downloadId);
    if (!record || record.scope.session_id !== params.session_id) throw new Error("Unknown or unowned download id");
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
    if (method === "Page.downloadProgress") {
      const record = this.downloadsById.get(params.guid);
      if (!record || record.scope.tabId !== tabId || record.targetSessionId !== source.sessionId) return;
      try { this.assertTransferScope(record.scope); } catch { this.downloadsById.delete(params.guid); return; }
      record.status = params.state === "completed" ? "complete" : params.state === "canceled" ? "canceled" : "in_progress";
      if (record.authorized) this.emitDownloadChange(record);
    }
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

  async ensureSessionGroup(sessionId, tabId, origin) {
    const session = await this.store.getSession(sessionId);
    let groupId = session.chromeGroupId;
    if (typeof groupId === "number") {
      try {
        await chrome.tabGroups.get(groupId);
        await chrome.tabs.group({ groupId, tabIds: [tabId] });
      } catch {
        groupId = null;
      }
    }
    if (typeof groupId !== "number") {
      groupId = await chrome.tabs.group({ tabIds: [tabId] });
      session.chromeGroupId = groupId;
    }
    session.tabOrigins[String(tabId)] = origin;
    await this.store.save();
    await chrome.tabGroups.update(groupId, {
      title: session.title,
      color: "blue",
      collapsed: false
    });
  }

  async setSessionActiveTab(sessionId, tabId) {
    const session = await this.store.getSession(sessionId);
    session.activeTabId = tabId;
    this.activeTabsBySession.set(sessionId, tabId);
    await this.store.save();
    await this.publishCursorState(tabId);
  }

  async getSessionTabs(sessionId, { strict = false } = {}) {
    const session = await this.store.getSession(sessionId);
    if (typeof session.chromeGroupId !== "number") {
      return [];
    }
    try {
      return (await chrome.tabs.query({ groupId: session.chromeGroupId })).filter(
        (tab) => hasTabId(tab) && !tab.url?.startsWith("chrome://")
      );
    } catch (error) {
      if (strict) throw error;
      await this.store.removeSession(sessionId);
      return [];
    }
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
    await this.controlLedger.admit(params);
    await this.store.getSession(params.session_id);
    this.controlLedger.assertCurrent(params);
    return { sessionId: params.session_id, turnId: params.turn_id };
  }

  async getControlState(params) {
    if (typeof params?.session_id !== "string" || !params.session_id || params.session_id.length > 256) throw new Error("Missing required browser session_id");
    await this.controlReady;
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
    // An inventory failure is not proof that control was released. Keep the
    // session record so explicit recovery can retry the same owned group.
    const tabs = await this.getSessionTabs(sessionId, { strict: true });
    const outcomes = await Promise.allSettled(tabs.filter(hasTabId).map(tab => this.detachTab(tab.id)));
    const failures = outcomes.filter(result => result.status === "rejected");
    if (failures.length) throw new Error(`OBU_CONTROL_RELEASE_FAILED: ${failures.map(result => String(result.reason?.message ?? result.reason)).join("; ")}`);
  }

  async endSessionControl(params, finish) {
    if (this.endingSessions.has(params.session_id)) throw new Error("OBU_CONTROL_ENDING: browser control is still being released");
    const ending = {};
    this.endingSessions.set(params.session_id, ending);
    try {
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
        await finish();
      } catch (error) {
        await this.clearSessionActivity(params.session_id);
        await this.controlLedger.finishEnd(record);
        throw error;
      }
      await this.clearSessionActivity(params.session_id);
      return this.controlLedger.finishEnd(record);
    } finally {
      if (this.endingSessions.get(params.session_id) === ending) this.endingSessions.delete(params.session_id);
    }
  }

  async recoverControlState() {
    await Promise.all([this.store.ready, this.controlLedger.ready]);
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
    if (!tabs.some((tab) => tab.id === tabId)) {
      throw new Error(`Tab ${tabId} is not part of browser session ${session.sessionId}`);
    }
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
            await chrome.tabs
              .group({ groupId: primaryGroupId, tabIds: dupTabIds })
              .catch(() => {});
          }
        }
      }

      if (typeof primaryGroupId === "number") {
        try {
          await chrome.tabs.group({ groupId: primaryGroupId, tabIds: windowTabIds });
        } catch {
          primaryGroupId = null;
        }
      }

      if (typeof primaryGroupId !== "number") {
        primaryGroupId = await chrome.tabs.group({ tabIds: windowTabIds });
      }

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

  detachTab(tabId) {
    this.controlEpochs.set(tabId, (this.controlEpochs.get(tabId) ?? 0) + 1);
    if (this.controlReleases.has(tabId)) return this.controlReleases.get(tabId);
    const release = this.releaseTabControl(tabId);
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
    try {
      let engineError;
      try {
        await this.browserEngine?.detach(tabId);
      } catch (error) {
        engineError = error;
      }
      await chrome.debugger.detach({ tabId }).catch((error) => {
        // The action engine may already have detached the same attachment.
        if (!/not attached|no tab with given id/i.test(String(error?.message ?? error))) throw error;
      });
      if (engineError) throw engineError;
    } finally {
      this.releaseEngineAttachment(tabId);
    }
  }

  async ensureCursorContentScript(sessionId, tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "OPEN_BROWSER_USE_PING" });
      if (response?.ok) {
        return true;
      }
    } catch {}
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
      await chrome.scripting.executeScript({
        files: ["content-webmcp-main.js"],
        target: { tabId },
        world: "MAIN"
      });
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

async function createBackgroundTab() {
  const windowId = await chooseWindowId();
  if (typeof windowId === "number") {
    const tab = await chrome.tabs.create({ active: false, url: "about:blank", windowId });
    if (hasTabId(tab)) {
      return tab;
    }
  }
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
  void backend.cdpEventMetadata(source).then(metadata => {
    if (metadata) safeSendNotification(peer, "onCDPEvent", { source, method, params, ...metadata });
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
