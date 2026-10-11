var _a;
import { OpenBrowserUseDownloadWait, downloadWaitMethods, downloadWaitParams, downloadWaitTimeout, downloadWaitAck, downloadWaitCancelled, assertDownloadWaitDeadline } from "./download-waits.js";
export { OpenBrowserUseDownloadWait } from "./download-waits.js";
import { clipboardMethods, clipboardParams, validateClipboardResult, OpenBrowserUseClipboard } from "./clipboard.js";
import { OpenBrowserUseFileChooserWait, fileChooserWaitMethods, fileChooserWaitParams, fileChooserWaitTimeout, fileChooserWaitAck, fileChooserWaitResult, fileChooserWaitCancelled, assertFileChooserWaitDeadline } from "./file-chooser-waits.js";
export { OpenBrowserUseFileChooserWait } from "./file-chooser-waits.js";
export { OpenBrowserUseClipboard } from "./clipboard.js";
import { OpenBrowserUseDownload, downloadID, downloadTimeout, downloadURLParams, downloadFileParams } from "./downloads.js";
import { pageExportParams, validatePageExport } from "./page-exports.js";
export { OpenBrowserUseDownload } from "./downloads.js";
import { OpenBrowserUseNavigationWait, navigationWaitAck, navigationWaitParams } from "./navigation-waits.js";
export { OpenBrowserUseNavigationWait } from "./navigation-waits.js";
import { createConnection } from "node:net";
import { endianness } from "node:os";
import { randomUUID } from "node:crypto";
import { copyLocatorSteps, relativeLocatorSteps, assertCombinedLocatorBudget } from "./locator-composition.js";
import { OpenBrowserUseNetworkWait, networkWaitAck, networkWaitMatch, networkWaitTimeout } from "./network-waits.js";
export { OpenBrowserUseNetworkWait } from "./network-waits.js";
const headerBytes = 4;
const maxFrameBytes = 64 * 1024 * 1024;
const defaultNavigationTimeoutMs = 10_000;
const controlExemptMethods = new Set(["ping", "getInfo", "getControlState"]);
const eventWaitMethods = new Set(["waitForFileChooser", "waitForDownload", "armDownloadWait", "armFileChooserWait", "armNetworkWait", "armNavigationWait", "downloadURL", "downloadMedia", "downloadPath", "cancelDownload", "exportPage", ...clipboardMethods]);
const networkWaitMethods = new Set(["armNetworkWait", "collectNetworkWait", "cancelNetworkWait"]);
const navigationWaitMethods = new Set(["armNavigationWait", "collectNavigationWait", "cancelNavigationWait"]);
const downloadSymbol = Symbol("download");
const downloadWaitSymbol = Symbol("downloadWait");
const navigationWaitSymbol = Symbol("navigationWait");
const networkWaitSymbol = Symbol("networkWait");
const fileChooserWaitSymbol = Symbol("fileChooserWait");
const controlScopeSymbol = Symbol("controlScope");
export class OpenBrowserUseClient {
    socketPath;
    sessionId;
    timeoutMs;
    #turnId;
    #control = null;
    #controlInitialization = null;
    #controlRevision = 0;
    #directDownloadsVersion = undefined;
    #mediaDownloadsVersion = undefined;
    #pageExportVersion = undefined;
    #clipboardVersion = undefined;
    #navigationWaitVersion = undefined;
    #networkWaitVersion = undefined;
    #fileChooserWaitVersion = undefined;
    #downloadWaitVersion = undefined;
    #socket = null;
    #connecting = null;
    #pendingData = Buffer.alloc(0);
    #nextId = 1;
    #pending = new Map();
    #notificationHandlers = new Set();
    constructor(options) {
        this.socketPath = options.socketPath;
        this.sessionId = options.sessionId ?? "open-browser-use-js";
        this.#turnId = options.turnId ?? `turn-${randomUUID()}`;
        this.timeoutMs = options.timeoutMs ?? 10_000;
        assertTimeout(this.timeoutMs);
    }
    get turnId() { return this.#turnId; }
    get controlEpoch() { return this.#control?.controlEpoch ?? null; }
    async connect() {
        if (this.#connecting) {
            await this.#connecting;
            return this;
        }
        if (this.#socket) {
            return this;
        }
        const socket = createConnection(this.socketPath);
        this.#socket = socket;
        this.#pendingData = Buffer.alloc(0);
        socket.on("data", (chunk) => {
            if (this.#socket !== socket)
                return;
            try {
                this.#handleData(Buffer.from(chunk));
            }
            catch (error) {
                this.#disconnect(socket, error instanceof Error ? error : new Error(String(error)));
            }
        });
        socket.on("end", () => this.#disconnect(socket, new Error(this.#pendingData.length ? "Open Browser Use socket closed with an incomplete frame" : "Open Browser Use socket closed")));
        socket.on("close", () => this.#disconnect(socket, new Error("Open Browser Use socket closed")));
        socket.on("error", (error) => this.#disconnect(socket, error));
        const connecting = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const error = new Error("Open Browser Use connection timed out");
                this.#disconnect(socket, error);
                reject(error);
            }, this.timeoutMs);
            socket.once("connect", () => { clearTimeout(timer); resolve(); });
            socket.once("error", error => { clearTimeout(timer); reject(error); });
            socket.once("close", () => { clearTimeout(timer); reject(new Error("Open Browser Use socket closed before connecting")); });
        });
        this.#connecting = connecting;
        try {
            await connecting;
        }
        finally {
            if (this.#connecting === connecting)
                this.#connecting = null;
        }
        return this;
    }
    close() {
        if (this.#socket)
            this.#disconnect(this.#socket, new Error("Open Browser Use client closed"));
    }
    onNotification(handler) {
        this.#notificationHandlers.add(handler);
        return () => {
            this.#notificationHandlers.delete(handler);
        };
    }
    async request(method, params = {}, options = {}) {
        return this.#request(method, params, options);
    }
    async #request(method, params, options, capture) {
        if (fileChooserWaitMethods.has(method))
            fileChooserWaitParams(method, params);
        if (downloadWaitMethods.has(method))
            downloadWaitParams(method, params);
        assertTimeout(options.timeoutMs ?? this.timeoutMs);
        const submittedAt = Date.now();
        let deadline = submittedAt + (options.timeoutMs ?? this.timeoutMs);
        // Capture before the first await. A concurrent end must never rebind work
        // already submitted by the caller to its newly issued turn or epoch.
        const turnId = this.#turnId;
        const captured = JSON.parse(JSON.stringify(params));
        if (method === "browserAction" || eventWaitMethods.has(method)) {
            const requested = captured.timeoutMs ?? 10_000;
            if (typeof requested === "number" && Number.isFinite(requested) && requested >= 1 && requested <= 120_000)
                deadline = Math.min(deadline, submittedAt + requested + 1000);
        }
        const merged = { session_id: this.sessionId, turn_id: turnId, ...captured };
        if (downloadWaitMethods.has(method))
            downloadWaitParams(method, merged);
        if (controlExemptMethods.has(method))
            return this.#sendRequest(method, merged, deadline);
        const explicitEpoch = Object.hasOwn(captured, "control_epoch");
        let binding;
        if (explicitEpoch) {
            if (!Number.isSafeInteger(captured.control_epoch) || captured.control_epoch < 0)
                throw new Error("control_epoch must be a non-negative safe integer");
        }
        else {
            if (merged.session_id !== this.sessionId || merged.turn_id !== turnId)
                throw new Error("Use a separate client or an explicit control_epoch when overriding session_id or turn_id");
            binding = this.#control ?? await beforeDeadline(this.#initializeControl(turnId, deadline), deadline, method);
            if (binding.closing)
                throw new Error("OBU_CONTROL_ENDING: call beginTurn() explicitly after control has ended");
            if (binding.controlEpoch !== null)
                merged.control_epoch = binding.controlEpoch;
        }
        if (networkWaitMethods.has(method)) {
            if (this.#networkWaitVersion === undefined)
                await this.#sendRequest("getInfo", { session_id: merged.session_id, turn_id: merged.turn_id }, deadline);
            if (this.#networkWaitVersion !== 1)
                throw new Error("OBU_NETWORK_WAIT_UNSUPPORTED: extension does not advertise networkWaitVersion 1");
        }
        if (fileChooserWaitMethods.has(method)) {
            if (this.#fileChooserWaitVersion === undefined)
                await this.#sendRequest("getInfo", { session_id: merged.session_id, turn_id: merged.turn_id }, deadline);
            if (this.#fileChooserWaitVersion !== 1)
                throw new Error("OBU_FILE_CHOOSER_WAIT_UNSUPPORTED: extension does not advertise fileChooserWaitVersion 1");
            if (!Number.isSafeInteger(merged.control_epoch) || merged.control_epoch < 1)
                throw new Error("File chooser waits require an explicit control epoch");
        }
        if (downloadWaitMethods.has(method)) {
            if (this.#downloadWaitVersion === undefined)
                await this.#sendRequest("getInfo", { session_id: merged.session_id, turn_id: merged.turn_id }, deadline);
            if (this.#downloadWaitVersion !== 1)
                throw new Error("OBU_DOWNLOAD_WAIT_UNSUPPORTED: extension does not advertise downloadWaitVersion 1");
            if (!Number.isSafeInteger(merged.control_epoch) || merged.control_epoch < 1)
                throw new Error("Download waits require an explicit control epoch");
        }
        if (navigationWaitMethods.has(method)) {
            if (this.#navigationWaitVersion === undefined)
                await this.#sendRequest("getInfo", { session_id: merged.session_id, turn_id: merged.turn_id }, deadline);
            if (this.#navigationWaitVersion !== 1)
                throw new Error("OBU_NAVIGATION_WAIT_UNSUPPORTED: extension does not advertise navigationWaitVersion 1");
        }
        if (method === "downloadURL" || method === "cancelDownload") {
            if (this.#directDownloadsVersion === undefined)
                await this.#sendRequest("getInfo", { session_id: merged.session_id, turn_id: merged.turn_id }, deadline);
            if (this.#directDownloadsVersion !== 1)
                throw new Error("OBU_DIRECT_DOWNLOADS_UNSUPPORTED: extension does not advertise directDownloadsVersion 1");
        }
        if (method === "downloadMedia") {
            if (this.#mediaDownloadsVersion === undefined)
                await this.#sendRequest("getInfo", { session_id: merged.session_id, turn_id: merged.turn_id }, deadline);
            if (this.#mediaDownloadsVersion !== 1)
                throw new Error("OBU_MEDIA_DOWNLOADS_UNSUPPORTED: extension does not advertise mediaDownloadsVersion 1");
        }
        if (method === "exportPage") {
            if (this.#pageExportVersion === undefined)
                await this.#sendRequest("getInfo", { session_id: merged.session_id, turn_id: merged.turn_id }, deadline);
            if (this.#pageExportVersion !== 1)
                throw new Error("OBU_PAGE_EXPORT_UNSUPPORTED: extension does not advertise pageExportVersion 1");
        }
        if (clipboardMethods.has(method)) {
            if (this.#clipboardVersion === undefined)
                await this.#sendRequest("getInfo", { session_id: merged.session_id, turn_id: merged.turn_id }, deadline);
            if (this.#clipboardVersion !== 1)
                throw new Error("OBU_CLIPBOARD_UNSUPPORTED: extension does not advertise clipboardVersion 1");
        }
        capture?.({ session_id: merged.session_id, turn_id: merged.turn_id, ...(merged.control_epoch === undefined ? {} : { control_epoch: merged.control_epoch }) });
        const result = await this.#sendRequest(method, merged, deadline, 0, options.startBefore);
        if (!explicitEpoch && binding && (method === "turnEnded" || method === "finalizeTabs")) {
            const next = binding.controlEpoch === null ? { controlEpoch: null, closing: false, nextTurnId: `turn-${randomUUID()}` } : parseEndedControl(result);
            if (binding.controlEpoch !== null && (next.controlEpoch <= binding.controlEpoch || !isObject(result) || result.endedTurnId !== turnId))
                throw new Error("Invalid control-end acknowledgement; call beginTurn() explicitly to recover");
            if (this.#control === binding && this.#turnId === turnId) {
                this.#controlRevision++;
                this.#control = next;
                this.#turnId = next.nextTurnId;
            }
        }
        return result;
    }
    async [downloadSymbol](tabId, method, params) {
        const timeoutMs = params.timeoutMs;
        let binding;
        const value = await this.#request(method, { ...params, tabId }, { timeoutMs: timeoutMs + 1000 }, metadata => {
            if (!Number.isSafeInteger(metadata.control_epoch) || metadata.control_epoch < 1)
                throw new Error("Download handles require an explicit control epoch");
            binding = metadata;
        });
        const id = downloadID(value), captured = { ...binding, downloadId: id };
        return new OpenBrowserUseDownload(id, (operation, timeout) => this.request(operation, { ...captured, timeoutMs: timeout }, { timeoutMs: timeout + 1000 }));
    }
    async [networkWaitSymbol](tabId, event, match, options = {}) {
        const timeoutMs = networkWaitTimeout(options), frozen = networkWaitMatch(event, match);
        let binding;
        const value = await this.#request("armNetworkWait", { tabId, event, match: frozen, timeoutMs }, { timeoutMs: timeoutMs + 1000 }, metadata => {
            if (!Number.isSafeInteger(metadata.control_epoch) || metadata.control_epoch < 1)
                throw new Error("Network waits require an explicit control epoch");
            binding = metadata;
        });
        const ack = networkWaitAck(value, timeoutMs);
        if (!binding || !Number.isSafeInteger(binding.control_epoch) || binding.control_epoch < 1)
            throw new Error("Network waits require an explicit control epoch");
        const params = { ...binding, tabId, waiterId: ack.waiterId };
        return new OpenBrowserUseNetworkWait(ack, event, (method, timeout) => this.request(method, params, { timeoutMs: timeout }));
    }
    async [navigationWaitSymbol](tabId, params) {
        const timeoutMs = params.timeoutMs;
        let binding;
        const value = await this.#request("armNavigationWait", { ...params, tabId }, { timeoutMs: timeoutMs + 1000 }, metadata => {
            if (!Number.isSafeInteger(metadata.control_epoch) || metadata.control_epoch < 1)
                throw new Error("Navigation waits require an explicit control epoch");
            binding = metadata;
        });
        const ack = navigationWaitAck(value, timeoutMs);
        const captured = { ...binding, tabId, waiterId: ack.waiterId };
        return new OpenBrowserUseNavigationWait(ack, (method, timeout) => this.request(method, captured, { timeoutMs: timeout }));
    }
    async [downloadWaitSymbol](tabId, options = {}) {
        const timeoutMs = downloadWaitTimeout(options), deadline = Date.now() + timeoutMs;
        let binding;
        const value = await this.#request("armDownloadWait", { tabId, timeoutMs }, { timeoutMs: timeoutMs + 1000, startBefore: deadline }, metadata => { binding = metadata; });
        const ack = downloadWaitAck(value, timeoutMs);
        const expires = Math.min(deadline, Date.now() + ack.remainingMs);
        assertDownloadWaitDeadline(expires);
        const scope = { ...binding, tabId }, waiter = { ...scope, waiterId: ack.waiterId };
        return new OpenBrowserUseDownloadWait(ack, expires, (method, budget, startBefore) => this.#request(method, waiter, { timeoutMs: budget, startBefore }), id => new OpenBrowserUseDownload(id, (method, timeoutMs) => this.request(method, { ...scope, downloadId: id, timeoutMs }, { timeoutMs: timeoutMs + 1000 })));
    }
    async [fileChooserWaitSymbol](tabId, options = {}) {
        const timeoutMs = fileChooserWaitTimeout(options), deadline = Date.now() + timeoutMs;
        let binding;
        const value = await this.#request("armFileChooserWait", { tabId, timeoutMs }, { timeoutMs: timeoutMs + 1000, startBefore: deadline }, metadata => { binding = metadata; });
        const ack = fileChooserWaitAck(value, timeoutMs);
        const expires = Math.min(deadline, Date.now() + ack.remainingMs);
        assertFileChooserWaitDeadline(expires);
        const captured = { ...binding, tabId, waiterId: ack.waiterId };
        return new OpenBrowserUseFileChooserWait(ack, expires, (method, budget, startBefore) => this.#request(method, captured, { timeoutMs: budget, startBefore }));
    }
    getControlState() { return this.request("getControlState"); }
    async beginTurn(turnId) {
        if (turnId !== undefined && !turnId.trim())
            throw new Error("beginTurn requires a non-empty turn ID");
        const revision = ++this.#controlRevision;
        const binding = await this.#negotiateControl(this.#turnId, Date.now() + this.timeoutMs);
        if (binding.closing)
            throw new Error("OBU_CONTROL_ENDING: control is still ending");
        if (revision !== this.#controlRevision)
            throw new Error("Control changed while beginTurn was pending; call beginTurn() again explicitly");
        this.#control = binding;
        this.#turnId = turnId ?? binding.nextTurnId ?? `turn-${randomUUID()}`;
        return binding.controlEpoch === null ? null : { controlEpoch: binding.controlEpoch, closing: false, nextTurnId: this.#turnId, lifecycleVersion: 1 };
    }
    refreshControlState() { return this.beginTurn(); }
    [controlScopeSymbol](timeoutMs) {
        assertTimeout(timeoutMs);
        const deadline = Date.now() + timeoutMs, turnId = this.#turnId, revision = this.#controlRevision;
        const binding = this.#control ?? this.#initializeControl(turnId, deadline);
        return {
            remaining: () => Math.max(0, deadline - Date.now()),
            request: async (method, params = {}, reservedResponseMs = 0) => {
                const captured = JSON.parse(JSON.stringify(params));
                const fixed = await beforeDeadline(Promise.resolve(binding), deadline, method);
                if (revision !== this.#controlRevision || fixed.closing)
                    throw new Error("OBU_STALE_CONTROL_EPOCH: control changed while the compound operation was pending");
                return this.#sendRequest(method, { ...captured, session_id: this.sessionId, turn_id: turnId,
                    ...(fixed.controlEpoch === null ? {} : { control_epoch: fixed.controlEpoch }) }, deadline, reservedResponseMs);
            }
        };
    }
    async #initializeControl(turnId, deadline) {
        if (this.#controlInitialization)
            return this.#controlInitialization;
        const revision = this.#controlRevision;
        const initialization = this.#negotiateControl(turnId, deadline).then(binding => {
            if (revision === this.#controlRevision)
                this.#control = binding;
            return binding;
        });
        this.#controlInitialization = initialization;
        try {
            return await initialization;
        }
        finally {
            if (this.#controlInitialization === initialization)
                this.#controlInitialization = null;
        }
    }
    async #negotiateControl(turnId, deadline) {
        const params = { session_id: this.sessionId, turn_id: turnId };
        const info = await this.#sendRequest("getInfo", params, deadline);
        const version = isObject(info) && isObject(info.metadata) ? info.metadata.turnLifecycleVersion : undefined;
        if (version === undefined)
            return { controlEpoch: null, closing: false };
        if (version !== 1)
            throw new Error(`Unsupported turn lifecycle version: ${version}`);
        return parseControlState(await this.#sendRequest("getControlState", params, deadline));
    }
    async #sendRequest(method, params, deadline, reservedResponseMs = 0, startBefore) {
        await beforeDeadline(this.connect(), deadline, method);
        const socket = this.#socket;
        if (!socket) {
            throw new Error("Open Browser Use socket is not connected");
        }
        const remaining = deadline - Date.now();
        if (remaining < 1)
            throw new Error(`Open Browser Use request timed out: ${method}`);
        if (remaining <= reservedResponseMs)
            throw new Error(`Open Browser Use request timed out before ${method} could start`);
        if (method === "browserAction" || eventWaitMethods.has(method)) {
            const requested = ["armDownloadWait", "armFileChooserWait", "armNetworkWait", "armNavigationWait", "downloadURL", "downloadMedia", "downloadPath", "cancelDownload", "exportPage", ...clipboardMethods].includes(method) && Object.hasOwn(params, "timeoutMs") ? params.timeoutMs : params.timeoutMs ?? 10_000;
            if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 1 || requested > 120_000 || (eventWaitMethods.has(method) && !Number.isInteger(requested)))
                throw new Error(`${method} timeoutMs must be ${eventWaitMethods.has(method) ? "an integer " : ""}between 1 and 120000`);
            const available = Math.floor(method === "armDownloadWait" && startBefore !== undefined ? Math.min(remaining - 1000, startBefore - Date.now()) : remaining - 1000);
            if (available < 1)
                throw new Error(`Open Browser Use request timed out before ${method} could start`);
            params = { ...params, timeoutMs: Math.min(requested, available) };
        }
        const id = String(this.#nextId++);
        const message = {
            jsonrpc: "2.0",
            id,
            method,
            params
        };
        const payload = encodeFrame(message);
        // The extra response-read allowance cannot authorize a late collect send.
        if (startBefore !== undefined) {
            if (downloadWaitMethods.has(method))
                assertDownloadWaitDeadline(startBefore);
            else
                assertFileChooserWaitDeadline(startBefore);
        }
        const promise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error(`Open Browser Use request timed out: ${method}`));
            }, Math.max(1, deadline - Date.now()));
            this.#pending.set(id, { resolve, reject, timeout, strictUTF8: clipboardMethods.has(method) });
        });
        try {
            socket.write(payload);
        }
        catch (error) {
            this.#disconnect(socket, error instanceof Error ? error : new Error(String(error)));
        }
        const result = await promise;
        if (method === "getInfo")
            this.#mediaDownloadsVersion = isObject(result) && isObject(result.metadata) ? result.metadata.mediaDownloadsVersion ?? null : null;
        if (method === "getInfo")
            this.#directDownloadsVersion = isObject(result) && isObject(result.metadata) ? result.metadata.directDownloadsVersion ?? null : null;
        if (method === "getInfo")
            this.#clipboardVersion = isObject(result) && isObject(result.metadata) ? result.metadata.clipboardVersion ?? null : null;
        if (method === "getInfo")
            this.#pageExportVersion = isObject(result) && isObject(result.metadata) ? result.metadata.pageExportVersion ?? null : null;
        if (method === "getInfo")
            this.#navigationWaitVersion = isObject(result) && isObject(result.metadata) ? result.metadata.navigationWaitVersion ?? null : null;
        if (method === "getInfo")
            this.#networkWaitVersion = isObject(result) && isObject(result.metadata) ? result.metadata.networkWaitVersion ?? null : null;
        if (method === "getInfo")
            this.#fileChooserWaitVersion = isObject(result) && isObject(result.metadata) ? result.metadata.fileChooserWaitVersion ?? null : null;
        if (method === "getInfo")
            this.#downloadWaitVersion = isObject(result) && isObject(result.metadata) ? result.metadata.downloadWaitVersion ?? null : null;
        if (method === "armDownloadWait")
            return downloadWaitAck(result, params.timeoutMs);
        if (method === "collectDownloadWait") {
            downloadID(result);
            return result;
        }
        if (method === "cancelDownloadWait")
            downloadWaitCancelled(result);
        if (method === "armFileChooserWait")
            return fileChooserWaitAck(result, params.timeoutMs);
        if (method === "collectFileChooserWait")
            return fileChooserWaitResult(result);
        if (method === "cancelFileChooserWait")
            fileChooserWaitCancelled(result);
        return result;
    }
    getInfo() {
        return this.request("getInfo");
    }
    async browserAction(tabId, action, options = {}) {
        const timeoutMs = options.timeoutMs ?? 10_000;
        if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
            throw new Error("browserAction timeoutMs must be between 1 and 120000");
        }
        const result = await this.request("browserAction", {
            tabId, action,
            ...(options.locator ? { locator: [...options.locator] } : {}),
            ...(options.args ? { args: options.args } : {}),
            timeoutMs
        }, {
            // Allow the browser engine to return its own actionability timeout before
            // the outer IPC deadline expires. Longer requested waits keep their budget.
            timeoutMs: timeoutMs + 1000
        });
        if (!isObject(result) || !("value" in result) || !isObject(result.engine) ||
            result.engine.name !== "playwright-crx" || typeof result.engine.version !== "string" ||
            typeof result.engine.playwrightVersion !== "string") {
            throw new Error("Invalid browserAction response; update the Open Browser Use extension");
        }
        return { value: result.value, engine: result.engine };
    }
    createTab() {
        return this.request("createTab");
    }
    getTabs() {
        return this.request("getTabs");
    }
    getUserTabs() {
        return this.request("getUserTabs");
    }
    getUserHistory(params = {}) {
        return this.request("getUserHistory", params);
    }
    claimUserTab(tabId) {
        return this.request("claimUserTab", { tabId });
    }
    finalizeTabs(keep) {
        return this.request("finalizeTabs", { keep });
    }
    nameSession(name) {
        return this.request("nameSession", { name });
    }
    attach(tabId) {
        return this.request("attach", { tabId });
    }
    detach(tabId) {
        return this.request("detach", { tabId });
    }
    executeCdp(tabId, method, commandParams = {}) {
        return this.request("executeCdp", {
            target: { tabId },
            method,
            commandParams
        });
    }
    moveMouse(tabId, x, y, waitForArrival = true) {
        return this.request("moveMouse", { tabId, x, y, waitForArrival });
    }
    waitForFileChooser(tabId, timeoutMs) {
        return this.#waitForTabEvent("waitForFileChooser", tabId, timeoutMs);
    }
    setFileChooserFiles(fileChooserId, files) {
        return this.request("setFileChooserFiles", { fileChooserId, files });
    }
    waitForDownload(tabId, timeoutMs) {
        return this.#waitForTabEvent("waitForDownload", tabId, timeoutMs);
    }
    #waitForTabEvent(method, tabId, timeoutMs = 10_000) {
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
            return Promise.reject(new Error("timeoutMs must be an integer between 1 and 120000"));
        return this.request(method, { tabId, timeoutMs }, { timeoutMs: timeoutMs + 1000 });
    }
    downloadPath(downloadId, timeoutMs) {
        const timeout = downloadTimeout({ timeoutMs });
        return this.request("downloadPath", { downloadId, timeoutMs: timeout }, { timeoutMs: timeout + 1000 });
    }
    browserUserHistory(params = {}) {
        return this.getUserHistory(params);
    }
    async readClipboardText(tabId, options = {}) {
        return this.#clipboard("readClipboardText", tabId, {}, options);
    }
    async writeClipboardText(tabId, text, options = {}) {
        return this.#clipboard("writeClipboardText", tabId, { text }, options);
    }
    async readClipboard(tabId, options = {}) {
        return this.#clipboard("readClipboard", tabId, {}, options);
    }
    async writeClipboard(tabId, items, options = {}) {
        return this.#clipboard("writeClipboard", tabId, { items }, options);
    }
    async #clipboard(method, tabId, payload, options) {
        const params = clipboardParams(method, tabId, payload, options);
        const value = await this.request(method, params, { timeoutMs: params.timeoutMs + 1000 });
        return validateClipboardResult(method, value, params.maxBytes);
    }
    turnEnded() {
        return this.request("turnEnded");
    }
    #handleData(chunk) {
        this.#pendingData = Buffer.concat([this.#pendingData, chunk]);
        while (this.#pendingData.length >= headerBytes) {
            const length = endianness() === "LE"
                ? this.#pendingData.readUInt32LE(0)
                : this.#pendingData.readUInt32BE(0);
            if (length > maxFrameBytes)
                throw new Error(`Open Browser Use frame too large: ${length} > ${maxFrameBytes}`);
            const total = headerBytes + length;
            if (this.#pendingData.length < total) {
                return;
            }
            const payload = this.#pendingData.subarray(headerBytes, total);
            this.#pendingData = this.#pendingData.subarray(total);
            this.#handleMessage(JSON.parse(payload.toString("utf8")), payload);
        }
    }
    #handleMessage(message, payload) {
        if (!isObject(message)) {
            return;
        }
        const id = typeof message.id === "string" || typeof message.id === "number" ? String(message.id) : null;
        if (!id && typeof message.method === "string") {
            const notification = {
                method: message.method,
                params: message.params
            };
            for (const handler of this.#notificationHandlers) {
                handler(notification);
            }
            return;
        }
        if (!id) {
            return;
        }
        const pending = this.#pending.get(id);
        if (!pending) {
            return;
        }
        this.#pending.delete(id);
        clearTimeout(pending.timeout);
        // Identify the response using the existing decoder, but never publish
        // clipboard text after Buffer.toString has repaired malformed UTF-8.
        // A literal, correctly encoded U+FFFD remains valid clipboard content.
        if (pending.strictUTF8) {
            try {
                new TextDecoder("utf-8", { fatal: true }).decode(payload);
            }
            catch {
                pending.reject(new Error("Invalid clipboard response: UTF-8 is malformed"));
                return;
            }
        }
        if (isObject(message.error)) {
            pending.reject(new Error(String(message.error.message ?? "Open Browser Use request failed")));
            return;
        }
        pending.resolve((message.result ?? null));
    }
    #rejectAll(error) {
        for (const [id, pending] of this.#pending) {
            this.#pending.delete(id);
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
    }
    #disconnect(socket, error) {
        // A delayed close event from an older connection must not tear down a retry.
        if (this.#socket !== socket)
            return;
        this.#socket = null;
        this.#connecting = null;
        this.#pendingData = Buffer.alloc(0);
        this.#rejectAll(error);
        socket.destroy();
    }
}
export async function connectOpenBrowserUse(options) {
    const browser = new OpenBrowserUseBrowser(options);
    await browser.connect();
    return browser;
}
export class OpenBrowserUseBrowser {
    client;
    cdp;
    constructor(options) {
        this.client = "client" in options ? options.client : new OpenBrowserUseClient(options);
        this.cdp = new OpenBrowserUseCdp(this.client);
    }
    async connect() {
        await this.client.connect();
        return this;
    }
    close() {
        this.client.close();
    }
    async newTab(options = {}) {
        const { url, waitUntil = "load" } = options;
        const timeoutMs = options.timeoutMs ?? (url ? defaultNavigationTimeoutMs : this.client.timeoutMs);
        if (url)
            assertSupportedLoadState(waitUntil);
        const scope = this.client[controlScopeSymbol](timeoutMs + (url ? 1000 : 0));
        const created = await scope.request("createTab", {}, url ? 1000 : 0);
        const tabId = tabIdFromValue(created, "createTab response");
        const tab = this.tab(tabId);
        if (url) {
            await scope.request("browserAction", { tabId, action: "goto", args: { url, waitUntil }, timeoutMs });
        }
        return tab;
    }
    tab(tabId) {
        return new OpenBrowserUseTab(this, tabId);
    }
    getTabs() {
        return this.client.getTabs();
    }
}
export class OpenBrowserUseTab {
    get clipboard() { return new OpenBrowserUseClipboard(this.browser.client, this.id); }
    browser;
    id;
    playwright;
    mouse;
    keyboard;
    constructor(browser, id) {
        this.browser = browser;
        this.id = id;
        this.playwright = new OpenBrowserUseTabPlaywright(this);
        this.mouse = new OpenBrowserUseMouse(this);
        this.keyboard = new OpenBrowserUseKeyboard(this);
    }
    async action(action, args = {}, options = {}) {
        return (await this.browser.client.browserAction(this.id, action, { args, ...options })).value;
    }
    async engineInfo() {
        return (await this.browser.client.browserAction(this.id, "engineInfo")).engine;
    }
    downloadURL(url, options = {}) {
        return this.browser.client[downloadSymbol](this.id, "downloadURL", downloadURLParams(url, options));
    }
    async exportPage(format, options = {}) {
        const params = pageExportParams(format, options);
        const value = await this.browser.client.request("exportPage", { ...params, tabId: this.id }, { timeoutMs: params.timeoutMs + 1000 });
        return validatePageExport(value, format, params.maxBytes);
    }
    exportPDF(options = {}) { return this.exportPage("pdf", options); }
    exportMHTML(options = {}) { return this.exportPage("mhtml", options); }
    waitForDownload(options = {}) {
        return this.browser.client[downloadSymbol](this.id, "waitForDownload", { timeoutMs: downloadTimeout(options) });
    }
    expectDownload(options = {}) {
        return this.browser.client[downloadWaitSymbol](this.id, options);
    }
    expectFileChooser(options = {}) {
        return this.browser.client[fileChooserWaitSymbol](this.id, options);
    }
    expectRequest(match, options = {}) {
        return this.browser.client[networkWaitSymbol](this.id, "request", match, options);
    }
    expectResponse(match, options = {}) {
        return this.browser.client[networkWaitSymbol](this.id, "response", match, options);
    }
    expectURL(url, options = {}) {
        return this.browser.client[navigationWaitSymbol](this.id, navigationWaitParams("url", url, options));
    }
    expectLoadState(options = {}) {
        return this.browser.client[navigationWaitSymbol](this.id, navigationWaitParams("loadstate", undefined, options));
    }
    goto(url, options = {}) {
        if (!url)
            return Promise.reject(new Error("goto requires a URL"));
        assertSupportedLoadState(options.waitUntil ?? "load");
        return this.action("goto", { url, waitUntil: options.waitUntil ?? "load" }, options);
    }
    goBack(options = {}) {
        assertSupportedLoadState(options.waitUntil ?? "load");
        return this.action("goBack", { waitUntil: options.waitUntil ?? "load" }, options);
    }
    goForward(options = {}) {
        assertSupportedLoadState(options.waitUntil ?? "load");
        return this.action("goForward", { waitUntil: options.waitUntil ?? "load" }, options);
    }
    reload(options = {}) {
        assertSupportedLoadState(options.waitUntil ?? "load");
        return this.action("reload", { waitUntil: options.waitUntil ?? "load" }, options);
    }
    async waitForLoadState(options = {}) {
        assertSupportedLoadState(options.state ?? "load");
        await this.action("waitForLoadState", { state: options.state ?? "load" }, options);
    }
    async waitForURL(url, options = {}) {
        await this.action("waitForURL", { ...actionArgs(options), url }, options);
    }
    async domSnapshot(options = {}) {
        return expectString(await this.action("snapshot", actionArgs(options), options), "snapshot");
    }
    async snapshotAI(options = {}) {
        const limits = aiSnapshotLimits(options);
        const boxes = options.boxes === true;
        return expectAISnapshot(await this.action("snapshotAI", actionArgs(options), options), limits, boxes);
    }
    async screenshot(options = {}) {
        return expectScreenshot(await this.action("screenshot", actionArgs(options), options));
    }
    async diagnostics(options = {}) {
        const value = await this.action("diagnostics", actionArgs(options), options);
        if (!isObject(value) || typeof value.captureId !== "string" || typeof value.startedAt !== "string" ||
            !Number.isSafeInteger(value.dropped) || value.dropped < 0 || !Array.isArray(value.entries) ||
            !isObject(value.cursor) || value.cursor.captureId !== value.captureId || !Number.isSafeInteger(value.cursor.sequence) || value.cursor.sequence < 0 ||
            value.entries.some(entry => !isObject(entry) || !Number.isSafeInteger(entry.sequence) || typeof entry.timestamp !== "string" ||
                !["console", "pageerror", "request", "response", "requestfinished", "requestfailed"].includes(String(entry.kind))))
            throw new Error("Invalid diagnostics snapshot");
        return value;
    }
    locator(selector) { return this.playwright.locator(selector); }
    getByRef(captureId, ref) { return this.playwright.getByRef(captureId, ref); }
    frameLocator(selector) { return this.playwright.frameLocator(selector); }
    getByRole(role, options = {}) { return this.playwright.getByRole(role, options); }
    getByText(value, options = {}) { return this.playwright.getByText(value, options); }
    getByLabel(value, options = {}) { return this.playwright.getByLabel(value, options); }
    getByPlaceholder(value, options = {}) { return this.playwright.getByPlaceholder(value, options); }
    getByAltText(value, options = {}) { return this.playwright.getByAltText(value, options); }
    getByTitle(value, options = {}) { return this.playwright.getByTitle(value, options); }
    getByTestId(value) { return this.playwright.getByTestId(value); }
    evaluate(expression, options = {}) {
        return this.browser.cdp.evaluate(this.id, expression, options);
    }
    close() { return this.browser.cdp.call(this.id, "Page.close"); }
}
export class OpenBrowserUseLocator {
    tab;
    steps;
    constructor(tab, steps = []) {
        this.tab = tab;
        if (steps.some(step => step.kind === "ref")) {
            if (steps.length !== 1 || steps[0].kind !== "ref")
                throw new Error("Ref locators cannot be chained");
            assertCaptureRef(steps[0].captureId, steps[0].ref);
        }
        this.steps = copyLocatorSteps(steps);
    }
    #append(step) {
        if (this.steps.some(existing => existing.kind === "ref"))
            throw new Error("Ref locators cannot be chained");
        return new _a(this.tab, [...this.steps, step]);
    }
    getByRef(captureId, ref) {
        if (this.steps.length)
            throw new Error("Ref locators must be created directly from a tab");
        return this.#append({ kind: "ref", captureId, ref });
    }
    locator(selector) { return this.#append({ kind: "css", selector }); }
    frameLocator(selector) { return this.#append({ kind: "frame", selector }); }
    getByRole(role, options = {}) { return this.#append({ kind: "role", role, ...options }); }
    getByText(value, options = {}) { return this.#append({ kind: "text", value, ...options }); }
    getByLabel(value, options = {}) { return this.#append({ kind: "label", value, ...options }); }
    getByPlaceholder(value, options = {}) { return this.#append({ kind: "placeholder", value, ...options }); }
    getByAltText(value, options = {}) { return this.#append({ kind: "altText", value, ...options }); }
    getByTitle(value, options = {}) { return this.#append({ kind: "title", value, ...options }); }
    getByTestId(value) { return this.#append({ kind: "testId", value }); }
    first() { return this.#append({ kind: "first" }); }
    last() { return this.#append({ kind: "last" }); }
    nth(index) { return this.#append({ kind: "nth", index }); }
    #operand(other, relative) {
        if (!(other instanceof _a) || other.tab.id !== this.tab.id || other.tab.browser.client !== this.tab.browser.client)
            throw new Error("Locator composition requires the same tab and client");
        return relativeLocatorSteps(this.steps, other.steps, relative);
    }
    filter(options) {
        if (!options || typeof options !== "object" || Object.keys(options).some(key => !["hasText", "hasNotText", "visible", "has", "hasNot"].includes(key)))
            throw new Error("Invalid filter options");
        const { has, hasNot, ...values } = options;
        return this.#append({ kind: "filter", ...values, ...(has !== undefined ? { has: this.#operand(has, true) } : {}), ...(hasNot !== undefined ? { hasNot: this.#operand(hasNot, true) } : {}) });
    }
    and(other) { return this.#append({ kind: "and", locator: this.#operand(other, false) }); }
    or(other) { return this.#append({ kind: "or", locator: this.#operand(other, false) }); }
    async #perform(action, options = {}) {
        return (await this.tab.browser.client.browserAction(this.tab.id, action, {
            locator: this.steps, args: actionArgs(options), timeoutMs: options.timeoutMs
        })).value;
    }
    downloadMedia(options = {}) {
        if (!this.steps.length)
            throw new Error("downloadMedia requires a nonempty locator");
        return this.tab.browser.client[downloadSymbol](this.tab.id, "downloadMedia", { ...downloadFileParams(options), locator: [...this.steps] });
    }
    async click(options = {}) { await this.#perform("click", options); }
    async dblclick(options = {}) { await this.#perform("dblclick", options); }
    async hover(options = {}) { await this.#perform("hover", options); }
    async focus(options = {}) { await this.#perform("focus", options); }
    async scrollIntoViewIfNeeded(options = {}) { await this.#perform("scrollIntoViewIfNeeded", options); }
    async pressSequentially(text, options = {}) { await this.#perform("pressSequentially", { ...options, text }); }
    async dragTo(target, options = {}) {
        if (!(target instanceof _a) || target.tab.id !== this.tab.id || target.tab.browser.client !== this.tab.browser.client) {
            throw new Error("dragTo requires a target locator from the same tab and client");
        }
        assertCombinedLocatorBudget(this.steps, target.steps);
        await this.#perform("dragTo", { ...options, target: [...target.steps] });
    }
    async fill(value, options = {}) { await this.#perform("fill", { ...options, value }); }
    async press(key, options = {}) { await this.#perform("press", { ...options, key }); }
    async check(options = {}) { await this.#perform("check", options); }
    async uncheck(options = {}) { await this.#perform("uncheck", options); }
    async setChecked(checked, options = {}) { await this.#perform("setChecked", { ...options, checked }); }
    async selectOption(values, options = {}) { return expectStrings(await this.#perform("selectOption", { ...options, values }), "selectOption"); }
    async waitFor(options = {}) { await this.#perform("waitFor", options); }
    async count() { const value = await this.#perform("count"); if (typeof value !== "number")
        throw new Error("Invalid count result"); return value; }
    async innerText(options = {}) { return expectString(await this.#perform("innerText", options), "innerText"); }
    async textContent(options = {}) { const value = await this.#perform("textContent", options); return value === null ? null : expectString(value, "textContent"); }
    async inputValue(options = {}) { return expectString(await this.#perform("inputValue", options), "inputValue"); }
    async getAttribute(name, options = {}) { const value = await this.#perform("getAttribute", { ...options, name }); return value === null ? null : expectString(value, "getAttribute"); }
    async isVisible() { return expectBoolean(await this.#perform("isVisible"), "isVisible"); }
    async isEnabled() { return expectBoolean(await this.#perform("isEnabled"), "isEnabled"); }
    async isChecked() { return expectBoolean(await this.#perform("isChecked"), "isChecked"); }
    async boundingBox(options = {}) {
        const value = await this.#perform("boundingBox", options);
        if (value === null)
            return null;
        if (!isObject(value) || ["x", "y", "width", "height"].some(key => typeof value[key] !== "number"))
            throw new Error("Invalid boundingBox result");
        return value;
    }
    async allTextContents() { return expectStrings(await this.#perform("allTextContents"), "allTextContents"); }
    async allInnerTexts() { return expectStrings(await this.#perform("allInnerTexts"), "allInnerTexts"); }
    async ariaSnapshot(options = {}) { return expectString(await this.#perform("snapshot", options), "snapshot"); }
    async screenshot(options = {}) { return expectScreenshot(await this.#perform("screenshot", options)); }
}
_a = OpenBrowserUseLocator;
export class OpenBrowserUseTabPlaywright extends OpenBrowserUseLocator {
    expectRequest(match, options = {}) { return this.tab.expectRequest(match, options); }
    expectDownload(options = {}) { return this.tab.expectDownload(options); }
    expectFileChooser(options = {}) { return this.tab.expectFileChooser(options); }
    expectResponse(match, options = {}) { return this.tab.expectResponse(match, options); }
    snapshotAI(options = {}) { return this.tab.snapshotAI(options); }
    goBack(options = {}) { return this.tab.goBack(options); }
    goForward(options = {}) { return this.tab.goForward(options); }
    reload(options = {}) { return this.tab.reload(options); }
    waitForLoadState(options = {}) { return this.tab.waitForLoadState(options); }
    expectURL(url, options = {}) { return this.tab.expectURL(url, options); }
    expectLoadState(options = {}) { return this.tab.expectLoadState(options); }
    waitForURL(url, options = {}) { return this.tab.waitForURL(url, options); }
    domSnapshot(options = {}) { return this.tab.domSnapshot(options); }
    engineInfo() { return this.tab.engineInfo(); }
}
export class OpenBrowserUseMouse {
    tab;
    constructor(tab) {
        this.tab = tab;
    }
    async move(x, y, options = {}) { await this.tab.action("mouse.move", { ...actionArgs(options), x, y }, options); }
    async click(x, y, options = {}) { await this.tab.action("mouse.click", { ...actionArgs(options), x, y }, options); }
    async down(options = {}) { await this.tab.action("mouse.down", actionArgs(options), options); }
    async up(options = {}) { await this.tab.action("mouse.up", actionArgs(options), options); }
    async wheel(deltaX, deltaY) { await this.tab.action("mouse.wheel", { deltaX, deltaY }); }
}
export class OpenBrowserUseKeyboard {
    tab;
    constructor(tab) {
        this.tab = tab;
    }
    async press(key, options = {}) { await this.tab.action("keyboard.press", { ...actionArgs(options), key }, options); }
    async type(text, options = {}) { await this.tab.action("keyboard.type", { ...actionArgs(options), text }, options); }
    async insertText(text) { await this.tab.action("keyboard.insertText", { text }); }
}
function actionArgs(options) {
    return Object.fromEntries(Object.entries(options).filter(([key, value]) => key !== "timeoutMs" && value !== undefined));
}
function expectString(value, action) {
    if (typeof value !== "string")
        throw new Error(`Invalid ${action} result`);
    return value;
}
function expectStrings(value, action) {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string"))
        throw new Error(`Invalid ${action} result`);
    return value;
}
function expectBoolean(value, action) {
    if (typeof value !== "boolean")
        throw new Error(`Invalid ${action} result`);
    return value;
}
function expectScreenshot(value) {
    if (!isObject(value) || typeof value.base64 !== "string" || typeof value.mimeType !== "string")
        throw new Error("Invalid screenshot result");
    return { base64: value.base64, mimeType: value.mimeType };
}
const aiLimits = Object.freeze({ maxBytes: 262144, maxNodes: 5000, maxRefs: 2000, maxFrames: 32, maxDepth: 64 });
function validRef(ref) {
    return typeof ref === "string" && ref.length <= 64 && /^(?:f[1-9][0-9]*)?e[1-9][0-9]*$/.exec(ref)?.[0] === ref;
}
function assertCaptureRef(captureId, ref) {
    if (typeof captureId !== "string" || !captureId.length || captureId.length > 128)
        throw new Error("captureId must be a non-empty string of at most 128 characters");
    if (!validRef(ref))
        throw new Error("ref must be a native snapshot reference of at most 64 characters");
}
function aiSnapshotLimits(options) {
    const limits = { ...aiLimits };
    for (const [key, value] of Object.entries(options)) {
        if (key === "timeoutMs")
            continue;
        if (key === "boxes") {
            if (value !== undefined && typeof value !== "boolean")
                throw new Error("boxes must be a boolean");
            continue;
        }
        if (!Object.hasOwn(aiLimits, key))
            throw new Error(`snapshotAI does not support ${key}`);
        if (value === undefined)
            continue;
        const name = key;
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > aiLimits[name])
            throw new Error(`${key} must be a positive integer <= ${aiLimits[name]}`);
        limits[name] = value;
    }
    return limits;
}
function expectAISnapshot(value, limits, boxes) {
    const invalid = () => new Error("Invalid snapshotAI result");
    const fields = ["captureId", "snapshot", "refs", "stats", "complete", ...(boxes ? ["geometry"] : [])];
    if (!isObject(value) || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key)) ||
        value.complete !== true || typeof value.captureId !== "string" || !value.captureId.length || value.captureId.length > 128 ||
        typeof value.snapshot !== "string" || !Array.isArray(value.refs) || value.refs.length > limits.maxRefs || value.refs.some(ref => !validRef(ref)) ||
        new Set(value.refs).size !== value.refs.length || !isObject(value.stats))
        throw invalid();
    const stats = value.stats;
    if (Object.keys(stats).some(key => !["bytes", "nodes", "refs", "frames"].includes(key)) ||
        ["bytes", "nodes", "refs", "frames"].some(key => !Number.isSafeInteger(stats[key]) || stats[key] < 0) ||
        stats.bytes !== Buffer.byteLength(value.snapshot, "utf8") || stats.bytes > limits.maxBytes ||
        stats.nodes > limits.maxNodes || stats.refs !== value.refs.length ||
        stats.frames < 1 || stats.frames > limits.maxFrames)
        throw invalid();
    if (boxes && !validAIGeometry(value.geometry, value.refs, stats.frames))
        throw invalid();
    return value;
}
function validAIGeometry(value, refs, frameCount) {
    const exact = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    const finite = (value) => typeof value === "number" && Number.isFinite(value);
    const refFrame = (ref) => /^(f[1-9][0-9]*)e/.exec(ref)?.[1] ?? "root";
    if (!exact(value, ["coordinateSpace", "frames", "boxes"]) || value.coordinateSpace !== "frame-viewport-css" ||
        !Array.isArray(value.frames) || value.frames.length !== frameCount || !Array.isArray(value.boxes) || value.boxes.length !== refs.length)
        return false;
    const refSet = new Set(refs), boxesByRef = new Map(), frames = new Set(), owners = new Set();
    for (const entry of value.boxes) {
        if (!exact(entry, ["ref", "frameId", "box"]) || typeof entry.ref !== "string" || !refSet.has(entry.ref) || boxesByRef.has(entry.ref) ||
            typeof entry.frameId !== "string" || entry.frameId !== refFrame(entry.ref) || !exact(entry.box, ["x", "y", "width", "height"]) ||
            !Object.values(entry.box).every(finite) || entry.box.width < 0 || entry.box.height < 0)
            return false;
        boxesByRef.set(entry.ref, entry.frameId);
    }
    for (const [index, frame] of value.frames.entries()) {
        if (!exact(frame, ["id", "parentId", "ownerRef", "viewport"]) || typeof frame.id !== "string" || frames.has(frame.id) ||
            !exact(frame.viewport, ["width", "height", "scrollX", "scrollY", "devicePixelRatio"]) || !Object.values(frame.viewport).every(finite) ||
            frame.viewport.width < 0 || frame.viewport.height < 0 || frame.viewport.devicePixelRatio <= 0)
            return false;
        if (index === 0) {
            if (frame.id !== "root" || frame.parentId !== null || frame.ownerRef !== null)
                return false;
        }
        else if (/^f([1-9]|[12][0-9]|3[0-2])$/.exec(frame.id)?.[0] !== frame.id || typeof frame.parentId !== "string" || !frames.has(frame.parentId) ||
            typeof frame.ownerRef !== "string" || owners.has(frame.ownerRef) || boxesByRef.get(frame.ownerRef) !== frame.parentId)
            return false;
        frames.add(frame.id);
        if (typeof frame.ownerRef === "string")
            owners.add(frame.ownerRef);
    }
    return [...boxesByRef.values()].every(frameId => frames.has(frameId));
}
export class OpenBrowserUseCdp {
    client;
    constructor(client) {
        this.client = client;
    }
    async call(tabId, method, commandParams = {}, options = {}) {
        return this.#call(this.client[controlScopeSymbol](options.timeoutMs ?? this.client.timeoutMs), tabId, method, commandParams);
    }
    async #call(scope, tabId, method, commandParams = {}) {
        const commands = JSON.parse(JSON.stringify(commandParams));
        await scope.request("attach", { tabId });
        const remaining = scope.remaining();
        if (remaining < 1)
            throw new Error("Open Browser Use CDP request timed out before sending");
        return scope.request("executeCdp", {
            target: { tabId },
            method,
            commandParams: commands,
            timeoutMs: remaining
        });
    }
    async evaluate(tabId, expression, options = {}) {
        const result = await this.call(tabId, "Runtime.evaluate", {
            expression,
            returnByValue: true,
            ...(options.awaitPromise === undefined ? {} : { awaitPromise: options.awaitPromise })
        });
        if (isObject(result) && isObject(result.exceptionDetails)) {
            throw new Error(String(result.exceptionDetails.text ?? "Open Browser Use evaluation failed"));
        }
        return isObject(result) && isObject(result.result) ? (result.result.value ?? null) : null;
    }
    async navigate(tabId, url, options = {}) {
        if (!url) {
            throw new Error("goto requires a URL");
        }
        const waitUntil = options.waitUntil ?? "load";
        assertSupportedLoadState(waitUntil);
        const timeoutMs = options.timeoutMs ?? defaultNavigationTimeoutMs;
        const scope = this.client[controlScopeSymbol](timeoutMs);
        await this.#call(scope, tabId, "Page.enable");
        const result = await this.#call(scope, tabId, "Page.navigate", { url });
        if (isObject(result) && typeof result.errorText === "string" && result.errorText) {
            throw new Error(`Browser failed to navigate tab ${tabId}: ${result.errorText}`);
        }
        const loaderId = isObject(result) ? stringValue(result.loaderId) : undefined;
        await this.#waitForLoadState(scope, tabId, waitUntil, loaderId);
        return result;
    }
    async waitForLoadState(tabId, options = {}) {
        const state = options.state ?? "load";
        assertSupportedLoadState(state);
        const scope = this.client[controlScopeSymbol](options.timeoutMs ?? defaultNavigationTimeoutMs);
        await this.#call(scope, tabId, "Page.enable");
        await this.#waitForLoadState(scope, tabId, state);
    }
    async #waitForLoadState(scope, tabId, state, loaderId) {
        const sameLoader = async () => {
            if (!loaderId)
                return true;
            const tree = await this.#call(scope, tabId, "Page.getFrameTree");
            return isObject(tree) && isObject(tree.frameTree) && isObject(tree.frameTree.frame) && tree.frameTree.frame.loaderId === loaderId;
        };
        while (true) {
            // A previous document's load event or complete readyState cannot satisfy
            // navigation. Check the returned loader on both sides of the state read.
            if (await sameLoader() && documentStateMatches(await this.#readDocumentState(scope, tabId), state) && await sameLoader())
                return;
            const remaining = scope.remaining();
            if (remaining < 1)
                throw new Error(`Timed out waiting for ${state} in tab ${tabId}`);
            await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
        }
    }
    async #readDocumentState(scope, tabId) {
        const result = await this.#call(scope, tabId, "Runtime.evaluate", { expression: "({ href: window.location.href, readyState: document.readyState })", returnByValue: true });
        const value = isObject(result) && isObject(result.result) ? result.result.value : undefined;
        return isObject(value) ? { href: stringValue(value.href), readyState: stringValue(value.readyState) } : undefined;
    }
    async readDocumentState(tabId) {
        try {
            const value = await this.evaluate(tabId, "({ href: window.location.href, readyState: document.readyState })");
            return isObject(value) ? { href: stringValue(value.href), readyState: stringValue(value.readyState) } : undefined;
        }
        catch {
            return undefined;
        }
    }
    waitForEvent(tabId, predicate, options = {}) {
        const timeoutMs = options.timeoutMs ?? defaultNavigationTimeoutMs;
        return new Promise((resolve, reject) => {
            let settled = false;
            let removeHandler = null;
            let timer;
            const finish = () => {
                if (settled) {
                    return false;
                }
                settled = true;
                clearTimeout(timer);
                removeHandler?.();
                return true;
            };
            timer = setTimeout(() => {
                if (finish()) {
                    reject(new Error(options.timeoutMessage ?? `Timed out waiting for tab ${tabId} event`));
                }
            }, timeoutMs);
            removeHandler = this.client.onNotification((notification) => {
                try {
                    if (predicate(notification)) {
                        if (finish()) {
                            resolve(notification);
                        }
                    }
                }
                catch (error) {
                    if (finish()) {
                        reject(error instanceof Error ? error : new Error(String(error)));
                    }
                }
            });
        });
    }
    waitForLoadEvent(tabId, state, timeoutMs) {
        return this.waitForEvent(tabId, (notification) => {
            const event = cdpEventForTab(notification, tabId);
            if (!event) {
                return false;
            }
            if (event.method === "Page.navigationBlocked") {
                throw new Error(`Navigation was blocked in tab ${tabId}`);
            }
            return state === "domcontentloaded"
                ? event.method === "Page.domContentEventFired"
                : event.method === "Page.loadEventFired";
        }, {
            timeoutMs,
            timeoutMessage: `Timed out waiting for ${state} in tab ${tabId}`
        }).then(() => undefined);
    }
    async ensureAttached(tabId) {
        // Engine deadlines, navigation, and turn cleanup can detach while this
        // client remains connected. Attach is idempotent; execute is never replayed.
        await this.client.attach(tabId);
    }
}
export function encodeFrame(value) {
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    if (payload.length > maxFrameBytes)
        throw new Error("Open Browser Use frame exceeds 64 MiB");
    const frame = Buffer.alloc(headerBytes + payload.length);
    if (endianness() === "LE") {
        frame.writeUInt32LE(payload.length, 0);
    }
    else {
        frame.writeUInt32BE(payload.length, 0);
    }
    payload.copy(frame, headerBytes);
    return frame;
}
function parseControlState(value) {
    if (!isObject(value) || value.lifecycleVersion !== 1 || !Number.isSafeInteger(value.controlEpoch) || value.controlEpoch < 0 ||
        typeof value.closing !== "boolean" || typeof value.nextTurnId !== "string" || !value.nextTurnId)
        throw new Error("Invalid control state; update the Open Browser Use extension");
    return { controlEpoch: value.controlEpoch, closing: value.closing, nextTurnId: value.nextTurnId, lifecycleVersion: 1 };
}
function parseEndedControl(value) {
    if (!isObject(value) || typeof value.endedTurnId !== "string" || !value.endedTurnId)
        throw new Error("Invalid control-end acknowledgement; call beginTurn() explicitly to recover");
    return parseControlState({ ...value, closing: false });
}
async function beforeDeadline(work, deadline, method) {
    let timer;
    try {
        return await Promise.race([work, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Open Browser Use request timed out: ${method}`)), Math.max(0, deadline - Date.now()));
            })]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function assertTimeout(timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
        throw new Error("timeoutMs must be a positive finite timer duration");
    }
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function tabIdFromValue(value, label) {
    if (!isObject(value)) {
        throw new Error(`${label} did not include a tab object`);
    }
    const id = value.id;
    if (typeof id === "number" && Number.isInteger(id) && id > 0) {
        return id;
    }
    if (typeof id === "string") {
        const parsed = Number(id);
        if (Number.isInteger(parsed) && parsed > 0) {
            return parsed;
        }
    }
    throw new Error(`${label} did not include a numeric tab id`);
}
function assertSupportedLoadState(state) {
    if (state !== "domcontentloaded" && state !== "load") {
        throw new Error(`Unsupported load state "${state}". Use "domcontentloaded" or "load".`);
    }
}
function documentStateMatches(documentState, state) {
    if (documentState?.readyState === "complete") {
        return true;
    }
    return state === "domcontentloaded" && documentState?.readyState === "interactive";
}
function cdpEventForTab(notification, tabId) {
    if (notification.method !== "onCDPEvent" || !isObject(notification.params)) {
        return null;
    }
    const source = notification.params.source;
    if (!isObject(source) || source.tabId !== tabId) {
        return null;
    }
    return {
        method: stringValue(notification.params.method)
    };
}
function stringValue(value) {
    return typeof value === "string" ? value : undefined;
}
