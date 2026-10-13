import { OpenBrowserUseDialogWait, dialogMethods, dialogParams, dialogTimeout, dialogDecision, dialogAck, dialogResult, dialogCancelled, type OpenBrowserUseDialogDecision, type OpenBrowserUseDialogOptions } from "./dialogs.js";
export { OpenBrowserUseDialogWait, type OpenBrowserUseDialogDecision, type OpenBrowserUseDialogOptions, type OpenBrowserUseDialogResult, type OpenBrowserUseDialogType } from "./dialogs.js";
import { OpenBrowserUsePageWait, pageWaitMethods, pageWaitParams, pageWaitTimeout, pageWaitAck, pageWaitCancelled, pageWaitResult, assertPageWaitDeadline, type OpenBrowserUsePageWaitOptions } from "./page-waits.js";
export { OpenBrowserUsePageWait, type OpenBrowserUsePageWaitOptions } from "./page-waits.js";
import { locatorUploadParams, requireLocatorUpload } from "./locator-upload.js";
import { responseBodyParams, responseBodyRequest, validateResponseBodyEnvelope, type OpenBrowserUseResponseBodyRef, type OpenBrowserUseResponseBodyOptions, type OpenBrowserUseResponseBody } from "./response-body.js";
export type { OpenBrowserUseResponseBodyRef, OpenBrowserUseResponseBodyOptions, OpenBrowserUseResponseBody } from "./response-body.js";
import { OpenBrowserUseDownloadWait, downloadWaitMethods, downloadWaitParams, downloadWaitTimeout, downloadWaitAck, downloadWaitCancelled, assertDownloadWaitDeadline, type OpenBrowserUseDownloadWaitOptions } from "./download-waits.js";
export { OpenBrowserUseDownloadWait, type OpenBrowserUseDownloadWaitOptions } from "./download-waits.js";
import { clipboardMethods, clipboardParams, validateClipboardResult, OpenBrowserUseClipboard, type OpenBrowserUseClipboardOptions } from "./clipboard.js";
import { OpenBrowserUseFileChooserWait, fileChooserWaitMethods, fileChooserWaitParams, fileChooserWaitTimeout, fileChooserWaitAck, fileChooserWaitResult, fileChooserWaitCancelled, assertFileChooserWaitDeadline, type OpenBrowserUseFileChooserWaitOptions } from "./file-chooser-waits.js";
export { OpenBrowserUseFileChooserWait, type OpenBrowserUseFileChooserWaitOptions, type OpenBrowserUseFileChooserWaitResult } from "./file-chooser-waits.js";
export { OpenBrowserUseClipboard } from "./clipboard.js";
export type { OpenBrowserUseClipboardOptions, OpenBrowserUseClipboardItem, OpenBrowserUseClipboardEntry } from "./clipboard.js";
import { OpenBrowserUseDownload, downloadID, downloadTimeout, downloadURLParams, downloadFileParams, type OpenBrowserUseMediaDownloadOptions, type OpenBrowserUseDownloadOptions, type OpenBrowserUseDownloadURLOptions } from "./downloads.js";
import { pageExportParams, validatePageExport, type OpenBrowserUseExportFormat, type OpenBrowserUseExportOptions, type OpenBrowserUsePageExport } from "./page-exports.js";
export { type OpenBrowserUseExportFormat, type OpenBrowserUseExportOptions, type OpenBrowserUsePDFOptions, type OpenBrowserUsePageExport } from "./page-exports.js";
export { OpenBrowserUseDownload, type OpenBrowserUseMediaDownloadOptions, type OpenBrowserUseDownloadOptions, type OpenBrowserUseDownloadURLOptions } from "./downloads.js";
import { OpenBrowserUseNavigationWait, navigationWaitAck, navigationWaitParams, type OpenBrowserUseURLWaitOptions, type OpenBrowserUseLoadStateWaitOptions } from "./navigation-waits.js";
export { OpenBrowserUseNavigationWait, type OpenBrowserUseNavigationWaitOptions, type OpenBrowserUseURLWaitOptions, type OpenBrowserUseLoadStateWaitOptions } from "./navigation-waits.js";
import { Socket, createConnection } from "node:net";
import { endianness } from "node:os";
import { randomUUID } from "node:crypto";
import { copyLocatorSteps, relativeLocatorSteps, assertCombinedLocatorBudget } from "./locator-composition.js";
import { OpenBrowserUseNetworkWait, networkWaitAck, networkWaitMatch, networkWaitTimeout, type OpenBrowserUseNetworkWaitEvent, type OpenBrowserUseNetworkWaitMatch, type OpenBrowserUseNetworkWaitOptions } from "./network-waits.js";
export { OpenBrowserUseNetworkWait, type OpenBrowserUseNetworkWaitEvent, type OpenBrowserUseNetworkWaitMatch, type OpenBrowserUseNetworkWaitOptions, type OpenBrowserUseNetworkWaitResult } from "./network-waits.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type BrowserUseRequestParams = { [key: string]: JsonValue };

export type OpenBrowserUseClientOptions = {
  socketPath: string;
  sessionId?: string;
  turnId?: string;
  timeoutMs?: number;
};

type PendingRequest = {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  strictUTF8: boolean;
};

export type OpenBrowserUseNotification = {
  method: string;
  params?: JsonValue;
};

export type NotificationHandler = (notification: OpenBrowserUseNotification) => void;

const headerBytes = 4;
const maxFrameBytes = 64 * 1024 * 1024;
const defaultNavigationTimeoutMs = 10_000;

export type OpenBrowserUseLoadState = "domcontentloaded" | "load";

export type OpenBrowserUseGotoOptions = {
  waitUntil?: OpenBrowserUseLoadState;
  timeoutMs?: number;
};

export type OpenBrowserUseWaitForLoadStateOptions = {
  state?: OpenBrowserUseLoadState;
  timeoutMs?: number;
};

export type OpenBrowserUseBrowserOptions = OpenBrowserUseClientOptions | { client: OpenBrowserUseClient };

export type OpenBrowserUseLocatorStep =
  | { kind: "ref"; captureId: string; ref: string }
  | { kind: "css" | "frame"; selector: string }
  | { kind: "role"; role: string; name?: string; exact?: boolean }
  | { kind: "text" | "label" | "placeholder" | "altText" | "title" | "testId"; value: string; exact?: boolean }
  | { kind: "nth"; index: number }
  | { kind: "first" | "last" }
  | { kind: "filter"; hasText?: string; hasNotText?: string; visible?: boolean; has?: readonly OpenBrowserUseLocatorStep[]; hasNot?: readonly OpenBrowserUseLocatorStep[] }
  | { kind: "and" | "or"; locator: readonly OpenBrowserUseLocatorStep[] };

export type OpenBrowserUseFilterOptions = { hasText?: string; hasNotText?: string; visible?: boolean; has?: OpenBrowserUseLocator; hasNot?: OpenBrowserUseLocator };

export type OpenBrowserUseAISnapshotLimits = { maxBytes: number; maxNodes: number; maxRefs: number; maxFrames: number; maxDepth: number };
export type OpenBrowserUseEngineInfo = {
  name: "playwright-crx"; version: string; playwrightVersion: string;
  capabilities?: { snapshotAI: 1; captureRefs: 1; snapshotBoxes?: 1; locatorFileUpload?: 1; responseBody?: 1 };
  snapshotLimits?: OpenBrowserUseAISnapshotLimits;
};
export type OpenBrowserUseActionResult = { value: JsonValue; engine: OpenBrowserUseEngineInfo };
export type OpenBrowserUseActionOptions = { timeoutMs?: number; [key: string]: JsonValue | undefined };
export type OpenBrowserUseScreenshot = { base64: string; mimeType: string };
export type OpenBrowserUseAISnapshotOptions = {
  timeoutMs?: number; maxBytes?: number; maxNodes?: number; maxRefs?: number; maxFrames?: number; maxDepth?: number; boxes?: boolean;
};
export type OpenBrowserUseAISnapshotBox = { x: number; y: number; width: number; height: number };
export type OpenBrowserUseAISnapshotFrame = {
  id: string; parentId: string | null; ownerRef: string | null;
  viewport: { width: number; height: number; scrollX: number; scrollY: number; devicePixelRatio: number };
};
export type OpenBrowserUseAISnapshotGeometry = {
  coordinateSpace: "frame-viewport-css"; frames: OpenBrowserUseAISnapshotFrame[];
  boxes: { ref: string; frameId: string; box: OpenBrowserUseAISnapshotBox }[];
};
export type OpenBrowserUseAISnapshot = {
  captureId: string; snapshot: string; refs: string[];
  stats: { bytes: number; nodes: number; refs: number; frames: number }; complete: true;
  geometry?: OpenBrowserUseAISnapshotGeometry;
};
export type OpenBrowserUseControlState = { controlEpoch: number; closing: boolean; nextTurnId: string; lifecycleVersion: 1 };
export type OpenBrowserUseDiagnosticsCursor = { captureId: string; sequence: number };
export type OpenBrowserUseDiagnosticsOptions = { after?: OpenBrowserUseDiagnosticsCursor; limit?: number; timeoutMs?: number };
export type OpenBrowserUseDiagnosticsSnapshot = {
  captureId: string; startedAt: string; cursor: OpenBrowserUseDiagnosticsCursor; dropped: number;
  entries: (BrowserUseRequestParams & { sequence: number; timestamp: string; kind: "console" | "pageerror" | "request" | "response" | "requestfinished" | "requestfailed" })[];
};
type ControlBinding = { controlEpoch: number | null; closing: boolean; nextTurnId?: string };
const controlExemptMethods = new Set(["ping", "getInfo", "getControlState"]);
const eventWaitMethods = new Set(["waitForFileChooser", "waitForDownload", "armDownloadWait", "armFileChooserWait", "armNetworkWait", "armNavigationWait", "downloadURL", "downloadMedia", "downloadPath", "cancelDownload", "exportPage", ...clipboardMethods]);
const networkWaitMethods = new Set(["armNetworkWait", "collectNetworkWait", "cancelNetworkWait"]);
const navigationWaitMethods = new Set(["armNavigationWait", "collectNavigationWait", "cancelNavigationWait"]);
const downloadSymbol = Symbol("download");
const pageWaitSymbol = Symbol("pageWait");
const dialogSymbol = Symbol("dialog");
const downloadWaitSymbol = Symbol("downloadWait");
const navigationWaitSymbol = Symbol("navigationWait");
const networkWaitSymbol = Symbol("networkWait");
const fileChooserWaitSymbol = Symbol("fileChooserWait");
const controlScopeSymbol = Symbol("controlScope");
type ControlScope = { request(method: string, params?: BrowserUseRequestParams, reservedResponseMs?: number): Promise<JsonValue>; remaining(): number };

export class OpenBrowserUseClient {
  readonly socketPath: string;
  readonly sessionId: string;
  readonly timeoutMs: number;
  #turnId: string;
  #control: ControlBinding | null = null;
  #controlInitialization: Promise<ControlBinding> | null = null;
  #controlRevision = 0;
  #directDownloadsVersion: unknown = undefined;
  #mediaDownloadsVersion: unknown = undefined;
  #pageExportVersion: unknown = undefined;
  #responseBodyVersion: unknown = undefined;
  #clipboardVersion: unknown = undefined;
  #navigationWaitVersion: unknown = undefined;
  #networkWaitVersion: unknown = undefined;
  #fileChooserWaitVersion: unknown = undefined;
  #downloadWaitVersion: unknown = undefined;
  #downloadWaitPathVersion: unknown = undefined;
  #pageWaitVersion: unknown = undefined;
  #dialogVersion: unknown = undefined;
  #scopeParent: OpenBrowserUseClient | null = null;
  #boundScope: BrowserUseRequestParams = {};
  #boundRevision = 0;
  #socket: Socket | null = null;
  #connecting: Promise<void> | null = null;
  #connectedOnce = false;
  #disconnected = false;
  #pendingData = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map<string, PendingRequest>();
  #notificationHandlers = new Set<NotificationHandler>();

  constructor(options: OpenBrowserUseClientOptions) {
    this.socketPath = options.socketPath;
    this.sessionId = options.sessionId ?? "open-browser-use-js";
    this.#turnId = options.turnId ?? `turn-${randomUUID()}`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    assertTimeout(this.timeoutMs);
  }

  get turnId(): string { return this.#turnId; }
  get controlEpoch(): number | null { return this.#control?.controlEpoch ?? null; }

  async connect(): Promise<this> {
    this.#assertNotDisconnected();
    if (this.#scopeParent) { await this.#scopeParent.connect(); this.#assertNotDisconnected(); return this; }
    if (this.#connecting) {
      await this.#connecting;
      this.#assertNotDisconnected();
      return this;
    }
    if (this.#socket) {
      return this;
    }
    const socket = createConnection(this.socketPath);
    this.#socket = socket;
    this.#pendingData = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (this.#socket !== socket) return;
      try {
        this.#handleData(Buffer.from(chunk));
      } catch (error) {
        this.#disconnect(socket, error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("end", () => this.#disconnect(socket, new Error(
      this.#pendingData.length ? "Open Browser Use socket closed with an incomplete frame" : "Open Browser Use socket closed"
    )));
    socket.on("close", () => this.#disconnect(socket, new Error("Open Browser Use socket closed")));
    socket.on("error", (error) => this.#disconnect(socket, error));
    const connecting = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error("Open Browser Use connection timed out");
        this.#disconnect(socket, error);
        reject(error);
      }, this.timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        // A closed or superseded initial attempt cannot revive this client.
        if (this.#disconnected || this.#socket !== socket) {
          socket.destroy();
          reject(new Error("OBU_SDK_BROWSER_DISCONNECTED: Browser connection is closed. Create a new client and explicitly begin a new turn."));
          return;
        }
        this.#connectedOnce = true;
        resolve();
      });
      socket.once("error", error => { clearTimeout(timer); reject(error); });
      socket.once("close", () => { clearTimeout(timer); reject(new Error("Open Browser Use socket closed before connecting")); });
    });
    this.#connecting = connecting;
    try {
      await connecting;
      this.#assertNotDisconnected();
    } finally {
      if (this.#connecting === connecting) this.#connecting = null;
    }
    return this;
  }

  close(): void {
    if (this.#scopeParent) { this.#scopeParent.close(); return; }
    this.#disconnected = true;
    if (this.#socket) this.#disconnect(this.#socket, new Error("Open Browser Use client closed"));
  }

  #assertNotDisconnected(): void {
    if (this.#scopeParent) {
      const parent = this.#scopeParent;
      parent.#assertNotDisconnected();
      if (parent.#controlRevision !== this.#boundRevision || parent.sessionId !== this.#boundScope.session_id || parent.#turnId !== this.#boundScope.turn_id || parent.#control?.controlEpoch !== this.#boundScope.control_epoch) throw new Error("OBU_STALE_CONTROL_EPOCH: created page belongs to an earlier control scope");
    }
    if (this.#disconnected) throw new Error("OBU_SDK_BROWSER_DISCONNECTED: Browser connection is closed. Create a new client and explicitly begin a new turn.");
  }

  onNotification(handler: NotificationHandler): () => void {
    if (this.#scopeParent) return this.#scopeParent.onNotification(handler);
    this.#notificationHandlers.add(handler);
    return () => {
      this.#notificationHandlers.delete(handler);
    };
  }

  async request(method: string, params: BrowserUseRequestParams = {}, options: { timeoutMs?: number } = {}): Promise<JsonValue> {
    return this.#request(method, params, options);
  }

  async #request(method: string, params: BrowserUseRequestParams, options: { timeoutMs?: number; startBefore?: number; monotonicDeadline?: number }, capture?: (metadata: BrowserUseRequestParams) => void): Promise<JsonValue> {
    this.#assertNotDisconnected();
    if (this.#scopeParent) {
      const result = await this.#scopeParent.#request(method, { ...params, ...this.#boundScope }, options, capture);
      this.#assertNotDisconnected(); return result;
    }
    if (pageWaitMethods.has(method)) pageWaitParams(method, params);
    if (dialogMethods.has(method)) dialogParams(method, params);
    const locatorUpload = method === "browserAction" && params.action === "setInputFiles";
    const responseBody = method === "browserAction" && params.action === "responseBody";
    if (responseBody) responseBodyRequest(params);
    if (locatorUpload) locatorUploadParams(params);
    if (method === "createTab" && Object.hasOwn(params, "backgroundWindow") && typeof params.backgroundWindow !== "boolean") throw new Error("backgroundWindow must be a boolean");
    if (fileChooserWaitMethods.has(method)) fileChooserWaitParams(method, params);
    if (downloadWaitMethods.has(method)) downloadWaitParams(method, params);
    assertTimeout(options.timeoutMs ?? this.timeoutMs);
    const submittedAt = Date.now();
    const submittedMonotonic = performance.now();
    let deadline = submittedAt + (options.timeoutMs ?? this.timeoutMs);
    // Capture before the first await. A concurrent end must never rebind work
    // already submitted by the caller to its newly issued turn or epoch.
    const turnId = this.#turnId;
    const captured = JSON.parse(JSON.stringify(params)) as BrowserUseRequestParams;
    if (locatorUpload) locatorUploadParams(captured);
    if (responseBody) responseBodyRequest(captured);
    if (method === "browserAction" || eventWaitMethods.has(method)) {
      const requested = captured.timeoutMs ?? 10_000;
      if (typeof requested === "number" && Number.isFinite(requested) && requested >= 1 && requested <= 120_000) deadline = Math.min(deadline, submittedAt + requested + 1000);
    }
    if (method === "armDialog") deadline = Math.min(deadline, submittedAt + dialogTimeout({ timeoutMs: captured.timeoutMs as number | undefined }));
    if (method === "armPageWait") deadline = Math.min(deadline, submittedAt + pageWaitTimeout({ timeoutMs: captured.timeoutMs as number | undefined }));
    const monotonicDeadline = options.monotonicDeadline ?? (responseBody || locatorUpload || pageWaitMethods.has(method) || dialogMethods.has(method) ? submittedMonotonic + (deadline - submittedAt) : undefined);
    const merged: BrowserUseRequestParams = { session_id: this.sessionId, turn_id: turnId, ...captured };
    if (pageWaitMethods.has(method)) pageWaitParams(method, merged);
    if (dialogMethods.has(method)) dialogParams(method, merged);
    if (downloadWaitMethods.has(method)) downloadWaitParams(method, merged);
    if (controlExemptMethods.has(method)) return this.#sendRequest(method, merged, deadline);
    const explicitEpoch = Object.hasOwn(captured, "control_epoch");
    let binding: ControlBinding | undefined;
    if (explicitEpoch) {
      if (!Number.isSafeInteger(captured.control_epoch) || (captured.control_epoch as number) < 0) throw new Error("control_epoch must be a non-negative safe integer");
    } else {
      if (merged.session_id !== this.sessionId || merged.turn_id !== turnId) throw new Error("Use a separate client or an explicit control_epoch when overriding session_id or turn_id");
      binding = this.#control ?? await beforeDeadline(this.#initializeControl(turnId, deadline, monotonicDeadline), deadline, method, monotonicDeadline);
      if (binding.closing) throw new Error("OBU_CONTROL_ENDING: call beginTurn() explicitly after control has ended");
      if (binding.controlEpoch !== null) merged.control_epoch = binding.controlEpoch;
    }
    if (method === "createTab" && merged.backgroundWindow === true) await this.#requireBackgroundWindow(merged, deadline);
    if (networkWaitMethods.has(method)) {
      if (this.#networkWaitVersion === undefined) await this.#sendRequest("getInfo", { session_id: merged.session_id, turn_id: merged.turn_id }, deadline);
      if (this.#networkWaitVersion !== 1) throw new Error("OBU_NETWORK_WAIT_UNSUPPORTED: extension does not advertise networkWaitVersion 1");
    }
    if (fileChooserWaitMethods.has(method)) {
      if (this.#fileChooserWaitVersion === undefined) await this.#sendRequest("getInfo", { session_id: merged.session_id, turn_id: merged.turn_id }, deadline);
      if (this.#fileChooserWaitVersion !== 1) throw new Error("OBU_FILE_CHOOSER_WAIT_UNSUPPORTED: extension does not advertise fileChooserWaitVersion 1");
      if (!Number.isSafeInteger(merged.control_epoch) || (merged.control_epoch as number) < 1) throw new Error("File chooser waits require an explicit control epoch");
    }
    if (dialogMethods.has(method)) {
      if (this.#dialogVersion === undefined) await this.#sendRequest("getInfo", { session_id: merged.session_id, turn_id: merged.turn_id }, deadline, 0, undefined, monotonicDeadline);
      if (this.#dialogVersion !== 1) throw new Error("OBU_DIALOG_UNSUPPORTED: extension does not advertise dialogVersion 1");
      if (!Number.isSafeInteger(merged.control_epoch) || (merged.control_epoch as number) < 1) throw new Error("Dialog decisions require an explicit control epoch");
    }
    if (pageWaitMethods.has(method)) {
      if (this.#pageWaitVersion === undefined) await this.#sendRequest("getInfo", { session_id: merged.session_id, turn_id: merged.turn_id }, deadline, 0, undefined, monotonicDeadline);
      if (this.#pageWaitVersion !== 1) throw new Error("OBU_PAGE_WAIT_UNSUPPORTED: extension does not advertise pageWaitVersion 1");
      if (!Number.isSafeInteger(merged.control_epoch) || (merged.control_epoch as number) < 1) throw new Error("Page waits require an explicit control epoch");
    }
    if (downloadWaitMethods.has(method)) {
      if (this.#downloadWaitVersion === undefined) await this.#sendRequest("getInfo", { session_id: merged.session_id, turn_id: merged.turn_id }, deadline);
      if (this.#downloadWaitVersion !== 1) throw new Error("OBU_DOWNLOAD_WAIT_UNSUPPORTED: extension does not advertise downloadWaitVersion 1");
      if (method === "armDownloadWait" && merged.requirePath === true && this.#downloadWaitPathVersion !== 1)
        throw new Error("OBU_DOWNLOAD_WAIT_PATH_UNSUPPORTED: extension does not advertise downloadWaitPathVersion 1");
      if (!Number.isSafeInteger(merged.control_epoch) || (merged.control_epoch as number) < 1) throw new Error("Download waits require an explicit control epoch");
    }
    if (navigationWaitMethods.has(method)) {
      if (this.#navigationWaitVersion === undefined) await this.#sendRequest("getInfo", { session_id: merged.session_id, turn_id: merged.turn_id }, deadline);
      if (this.#navigationWaitVersion !== 1) throw new Error("OBU_NAVIGATION_WAIT_UNSUPPORTED: extension does not advertise navigationWaitVersion 1");
    }
    if (method === "downloadURL" || method === "cancelDownload") {
      if (this.#directDownloadsVersion === undefined) await this.#sendRequest("getInfo", { session_id: merged.session_id, turn_id: merged.turn_id }, deadline);
      if (this.#directDownloadsVersion !== 1) throw new Error("OBU_DIRECT_DOWNLOADS_UNSUPPORTED: extension does not advertise directDownloadsVersion 1");
    }
    if (method === "downloadMedia") {
      if (this.#mediaDownloadsVersion === undefined) await this.#sendRequest("getInfo", { session_id: merged.session_id, turn_id: merged.turn_id }, deadline);
      if (this.#mediaDownloadsVersion !== 1) throw new Error("OBU_MEDIA_DOWNLOADS_UNSUPPORTED: extension does not advertise mediaDownloadsVersion 1");
    }
    if (method === "exportPage") {
      if (this.#pageExportVersion === undefined) await this.#sendRequest("getInfo", { session_id: merged.session_id, turn_id: merged.turn_id }, deadline);
      if (this.#pageExportVersion !== 1) throw new Error("OBU_PAGE_EXPORT_UNSUPPORTED: extension does not advertise pageExportVersion 1");
    }
    if (responseBody) {
      if (this.#responseBodyVersion === undefined) await this.#sendRequest("getInfo", { session_id: merged.session_id, turn_id: merged.turn_id }, deadline, 0, undefined, monotonicDeadline);
      if (this.#responseBodyVersion !== 1) throw new Error("OBU_RESPONSE_BODY_UNSUPPORTED: extension does not advertise responseBodyVersion 1");
    }
    if (clipboardMethods.has(method)) {
      if (this.#clipboardVersion === undefined) await this.#sendRequest("getInfo", { session_id: merged.session_id, turn_id: merged.turn_id }, deadline);
      if (this.#clipboardVersion !== 1) throw new Error("OBU_CLIPBOARD_UNSUPPORTED: extension does not advertise clipboardVersion 1");
    }
    if (locatorUpload) {
      const info = await this.#sendRequest("browserAction", { session_id: merged.session_id, turn_id: merged.turn_id,
        ...(merged.control_epoch === undefined ? {} : { control_epoch: merged.control_epoch }),
        tabId: merged.tabId!, action: "engineInfo", timeoutMs: merged.timeoutMs ?? 10000 }, deadline, 0, undefined, monotonicDeadline);
      requireLocatorUpload(info);
    }
    capture?.({ session_id: merged.session_id, turn_id: merged.turn_id, ...(merged.control_epoch === undefined ? {} : { control_epoch: merged.control_epoch }) });
    const result = await this.#sendRequest(method, merged, deadline, 0, options.startBefore, monotonicDeadline);
    if (!explicitEpoch && binding && (method === "turnEnded" || method === "finalizeTabs")) {
      const next = binding.controlEpoch === null ? { controlEpoch: null, closing: false, nextTurnId: `turn-${randomUUID()}` } : parseEndedControl(result);
      if (binding.controlEpoch !== null && (next.controlEpoch! <= binding.controlEpoch || !isObject(result) || result.endedTurnId !== turnId)) throw new Error("Invalid control-end acknowledgement; call beginTurn() explicitly to recover");
      if (this.#control === binding && this.#turnId === turnId) {
        this.#controlRevision++;
        this.#control = next;
        this.#turnId = next.nextTurnId!;
      }
    }
    return result;
  }

  async [downloadSymbol](tabId: number, method: "downloadURL" | "downloadMedia" | "waitForDownload", params: BrowserUseRequestParams): Promise<OpenBrowserUseDownload> {
    const timeoutMs = params.timeoutMs as number;
    let binding: BrowserUseRequestParams | undefined;
    const value = await this.#request(method, { ...params, tabId }, { timeoutMs: timeoutMs + 1000 }, metadata => {
      if (!Number.isSafeInteger(metadata.control_epoch) || (metadata.control_epoch as number) < 1) throw new Error("Download handles require an explicit control epoch");
      binding = metadata;
    });
    const id = downloadID(value), captured = { ...binding!, downloadId: id };
    return new OpenBrowserUseDownload(id, (operation, timeout) => this.request(operation, { ...captured, timeoutMs: timeout }, { timeoutMs: timeout + 1000 }));
  }

  async [networkWaitSymbol](tabId: number, event: OpenBrowserUseNetworkWaitEvent, match: OpenBrowserUseNetworkWaitMatch, options: OpenBrowserUseNetworkWaitOptions = {}): Promise<OpenBrowserUseNetworkWait> {
    const timeoutMs = networkWaitTimeout(options), frozen = networkWaitMatch(event, match);
    let binding: BrowserUseRequestParams | undefined;
    const value = await this.#request("armNetworkWait", { tabId, event, match: frozen, timeoutMs }, { timeoutMs: timeoutMs + 1000 }, metadata => {
      if (!Number.isSafeInteger(metadata.control_epoch) || (metadata.control_epoch as number) < 1) throw new Error("Network waits require an explicit control epoch");
      binding = metadata;
    });
    const ack = networkWaitAck(value, timeoutMs);
    if (!binding || !Number.isSafeInteger(binding.control_epoch) || (binding.control_epoch as number) < 1) throw new Error("Network waits require an explicit control epoch");
    const params = { ...binding, tabId, waiterId: ack.waiterId };
    return new OpenBrowserUseNetworkWait(ack, event, (method, timeout) => this.request(method, params, { timeoutMs: timeout }));
  }

  async [navigationWaitSymbol](tabId: number, params: BrowserUseRequestParams): Promise<OpenBrowserUseNavigationWait> {
    const timeoutMs = params.timeoutMs as number;
    let binding: BrowserUseRequestParams | undefined;
    const value = await this.#request("armNavigationWait", { ...params, tabId }, { timeoutMs: timeoutMs + 1000 }, metadata => {
      if (!Number.isSafeInteger(metadata.control_epoch) || (metadata.control_epoch as number) < 1) throw new Error("Navigation waits require an explicit control epoch");
      binding = metadata;
    });
    const ack = navigationWaitAck(value, timeoutMs);
    const captured = { ...binding!, tabId, waiterId: ack.waiterId };
    return new OpenBrowserUseNavigationWait(ack, (method, timeout) => this.request(method, captured, { timeoutMs: timeout }));
  }

  armDialog(tabId: number, decision: OpenBrowserUseDialogDecision, options: OpenBrowserUseDialogOptions = {}): Promise<JsonValue> {
    dialogDecision(decision); const timeoutMs = dialogTimeout(options);
    return this.request("armDialog", { tabId, ...decision, timeoutMs }, { timeoutMs });
  }
  collectDialog(tabId: number, dialogId: string): Promise<JsonValue> { return this.request("collectDialog", { tabId, dialogId }); }
  cancelDialog(tabId: number, dialogId: string): Promise<JsonValue> { return this.request("cancelDialog", { tabId, dialogId }); }

  async [dialogSymbol](tabId: number, decision: OpenBrowserUseDialogDecision, options: OpenBrowserUseDialogOptions = {}): Promise<OpenBrowserUseDialogWait> {
    dialogDecision(decision); const timeoutMs = dialogTimeout(options), deadline = performance.now() + timeoutMs;
    const originalDecision = { ...decision };
    let binding: BrowserUseRequestParams = {};
    const value = await this.#request("armDialog", { tabId, ...decision, timeoutMs }, { timeoutMs, monotonicDeadline: deadline }, metadata => { binding = metadata; });
    const ack = dialogAck(value, timeoutMs), expires = Math.min(deadline, performance.now() + ack.remainingMs);
    const remainingMs = Math.min(ack.remainingMs, assertPageWaitDeadline(expires));
    const captured = { ...binding, tabId, dialogId: ack.dialogId };
    let origin: OpenBrowserUseClient = this; while (origin.#scopeParent) origin = origin.#scopeParent;
    return new OpenBrowserUseDialogWait({ ...ack, remainingMs }, expires,
      (method, budget, monotonicDeadline) => origin.#request(method, captured, { timeoutMs: budget, monotonicDeadline }), originalDecision);
  }

  async [pageWaitSymbol](tabId: number, options: OpenBrowserUsePageWaitOptions = {}): Promise<OpenBrowserUsePageWait> {
    this.#assertNotDisconnected();
    const timeoutMs = pageWaitTimeout(options), deadline = performance.now() + timeoutMs;
    let origin: OpenBrowserUseClient = this;
    while (origin.#scopeParent) origin = origin.#scopeParent;
    const revision = origin.#controlRevision;
    let binding: BrowserUseRequestParams = {};
    const value = await this.#request("armPageWait", { tabId, timeoutMs }, { timeoutMs, monotonicDeadline: deadline }, metadata => { binding = metadata; });
    const ack = pageWaitAck(value, timeoutMs), expires = Math.min(deadline, performance.now() + ack.remainingMs);
    const remaining = Math.min(ack.remainingMs, assertPageWaitDeadline(expires));
    const waiter = { ...binding, tabId, waiterId: ack.waiterId };
    return new OpenBrowserUsePageWait({ ...ack, remainingMs: remaining }, expires,
      (method, budget, monotonicDeadline) => origin.#request(method, waiter, { timeoutMs: budget, monotonicDeadline }),
      id => {
        if (id === tabId) throw new Error("Invalid page wait result: child equals source");
        const view = new OpenBrowserUseClient({ socketPath: origin.socketPath, sessionId: origin.sessionId, turnId: binding.turn_id as string, timeoutMs: origin.timeoutMs });
        view.#scopeParent = origin; view.#boundScope = binding; view.#boundRevision = revision;
        view.#control = { controlEpoch: binding.control_epoch as number, closing: false, nextTurnId: binding.turn_id as string };
        view.#assertNotDisconnected();
        return new OpenBrowserUseBrowser({ client: view }).tab(id);
      });
  }

  async [downloadWaitSymbol](tabId: number, options: OpenBrowserUseDownloadWaitOptions = {}): Promise<OpenBrowserUseDownloadWait> {
    const timeoutMs = downloadWaitTimeout(options), deadline = Date.now() + timeoutMs;
    let binding: BrowserUseRequestParams | undefined;
    const value = await this.#request("armDownloadWait", { tabId, timeoutMs,
      ...(options.requirePath === true ? { requirePath: true } : {}) },
      { timeoutMs: timeoutMs + 1000, startBefore: deadline }, metadata => { binding = metadata; });
    const ack = downloadWaitAck(value, timeoutMs);
    const expires = Math.min(deadline, Date.now() + ack.remainingMs);
    assertDownloadWaitDeadline(expires);
    const scope = { ...binding!, tabId }, waiter = { ...scope, waiterId: ack.waiterId };
    return new OpenBrowserUseDownloadWait(ack, expires,
      (method, budget, startBefore) => this.#request(method, waiter, { timeoutMs: budget, startBefore }),
      id => new OpenBrowserUseDownload(id, (method, timeoutMs) => this.request(method, { ...scope, downloadId: id, timeoutMs }, { timeoutMs: timeoutMs + 1000 })));
  }

  async [fileChooserWaitSymbol](tabId: number, options: OpenBrowserUseFileChooserWaitOptions = {}): Promise<OpenBrowserUseFileChooserWait> {
    const timeoutMs = fileChooserWaitTimeout(options), deadline = Date.now() + timeoutMs;
    let binding: BrowserUseRequestParams | undefined;
    const value = await this.#request("armFileChooserWait", { tabId, timeoutMs }, { timeoutMs: timeoutMs + 1000, startBefore: deadline }, metadata => { binding = metadata; });
    const ack = fileChooserWaitAck(value, timeoutMs);
    const expires = Math.min(deadline, Date.now() + ack.remainingMs);
    assertFileChooserWaitDeadline(expires);
    const captured = { ...binding!, tabId, waiterId: ack.waiterId };
    return new OpenBrowserUseFileChooserWait(ack, expires, (method, budget, startBefore) => this.#request(method, captured, { timeoutMs: budget, startBefore }));
  }

  getControlState(): Promise<JsonValue> { return this.request("getControlState"); }

  async beginTurn(turnId?: string): Promise<OpenBrowserUseControlState | null> {
    this.#assertNotDisconnected();
    if (this.#scopeParent) throw new Error("OBU_STALE_CONTROL_EPOCH: begin a turn on the original client, then create new handles");
    if (turnId !== undefined && !turnId.trim()) throw new Error("beginTurn requires a non-empty turn ID");
    const revision = ++this.#controlRevision;
    const binding = await this.#negotiateControl(this.#turnId, Date.now() + this.timeoutMs);
    this.#assertNotDisconnected();
    if (binding.closing) throw new Error("OBU_CONTROL_ENDING: control is still ending");
    if (revision !== this.#controlRevision) throw new Error("Control changed while beginTurn was pending; call beginTurn() again explicitly");
    this.#control = binding;
    this.#turnId = turnId ?? binding.nextTurnId ?? `turn-${randomUUID()}`;
    return binding.controlEpoch === null ? null : { controlEpoch: binding.controlEpoch, closing: false, nextTurnId: this.#turnId, lifecycleVersion: 1 };
  }

  refreshControlState(): Promise<OpenBrowserUseControlState | null> { return this.beginTurn(); }

  [controlScopeSymbol](timeoutMs: number): ControlScope {
    this.#assertNotDisconnected();
    assertTimeout(timeoutMs);
    const deadline = Date.now() + timeoutMs, turnId = this.#turnId, revision = this.#controlRevision;
    const binding = this.#control ?? this.#initializeControl(turnId, deadline);
    return {
      remaining: () => Math.max(0, deadline - Date.now()),
      request: async (method, params = {}, reservedResponseMs = 0) => {
        const captured = JSON.parse(JSON.stringify(params)) as BrowserUseRequestParams;
        const fixed = await beforeDeadline(Promise.resolve(binding), deadline, method);
        if (revision !== this.#controlRevision || fixed.closing) throw new Error("OBU_STALE_CONTROL_EPOCH: control changed while the compound operation was pending");
        if (method === "createTab" && captured.backgroundWindow === true) {
          await this.#requireBackgroundWindow({ session_id: this.sessionId, turn_id: turnId }, deadline);
          if (revision !== this.#controlRevision || fixed.closing) throw new Error("OBU_STALE_CONTROL_EPOCH: control changed while the compound operation was pending");
        }
        return this.#sendRequest(method, { ...captured, session_id: this.sessionId, turn_id: turnId,
          ...(fixed.controlEpoch === null ? {} : { control_epoch: fixed.controlEpoch }) }, deadline, reservedResponseMs);
      }
    };
  }

  async #requireBackgroundWindow(scope: BrowserUseRequestParams, deadline: number): Promise<void> {
    const info = await this.#sendRequest("getInfo", { session_id: scope.session_id, turn_id: scope.turn_id }, deadline);
    if (!isObject(info) || !isObject(info.metadata) || info.metadata.backgroundWindowVersion !== 1) throw new Error("OBU_BACKGROUND_WINDOW_UNSUPPORTED: extension does not advertise backgroundWindowVersion 1");
  }

  async #initializeControl(turnId: string, deadline: number, monotonicDeadline?: number): Promise<ControlBinding> {
    if (this.#controlInitialization) return this.#controlInitialization;
    const revision = this.#controlRevision;
    const initialization = this.#negotiateControl(turnId, deadline, monotonicDeadline).then(binding => {
      if (!this.#disconnected && revision === this.#controlRevision) this.#control = binding;
      return binding;
    });
    this.#controlInitialization = initialization;
    try { return await initialization; }
    finally { if (this.#controlInitialization === initialization) this.#controlInitialization = null; }
  }

  async #negotiateControl(turnId: string, deadline: number, monotonicDeadline?: number): Promise<ControlBinding> {
    const params = { session_id: this.sessionId, turn_id: turnId };
    const info = await this.#sendRequest("getInfo", params, deadline, 0, undefined, monotonicDeadline);
    const version = isObject(info) && isObject(info.metadata) ? info.metadata.turnLifecycleVersion : undefined;
    if (version === undefined) return { controlEpoch: null, closing: false };
    if (version !== 1) throw new Error(`Unsupported turn lifecycle version: ${version}`);
    return parseControlState(await this.#sendRequest("getControlState", params, deadline, 0, undefined, monotonicDeadline));
  }

  async #sendRequest(method: string, params: BrowserUseRequestParams, deadline: number, reservedResponseMs = 0, startBefore?: number, monotonicDeadline?: number): Promise<JsonValue> {
    if (this.#scopeParent) {
      this.#assertNotDisconnected();
      const result = await this.#scopeParent.#sendRequest(method, { ...params, ...this.#boundScope }, deadline, reservedResponseMs, startBefore, monotonicDeadline);
      this.#assertNotDisconnected(); return result;
    }
    await beforeDeadline(this.connect(), deadline, method, monotonicDeadline);
    this.#assertNotDisconnected();
    const socket = this.#socket;
    if (!socket) {
      throw new Error("Open Browser Use socket is not connected");
    }
    const remaining = requestRemaining(deadline, monotonicDeadline);
    if (remaining < 1) throw new Error(`Open Browser Use request timed out: ${method}`);
    if (remaining <= reservedResponseMs) throw new Error(`Open Browser Use request timed out before ${method} could start`);
    if (method === "browserAction" || eventWaitMethods.has(method)) {
      const requested = ["armDownloadWait", "armFileChooserWait", "armNetworkWait", "armNavigationWait", "downloadURL", "downloadMedia", "downloadPath", "cancelDownload", "exportPage", ...clipboardMethods].includes(method) && Object.hasOwn(params, "timeoutMs") ? params.timeoutMs : params.timeoutMs ?? 10_000;
      if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 1 || requested > 120_000 || (eventWaitMethods.has(method) && !Number.isInteger(requested))) throw new Error(`${method} timeoutMs must be ${eventWaitMethods.has(method) ? "an integer " : ""}between 1 and 120000`);
      const available = Math.floor(method === "armDownloadWait" && startBefore !== undefined ? Math.min(remaining - 1000, startBefore - Date.now()) : remaining - 1000);
      if (available < 1) throw new Error(`Open Browser Use request timed out before ${method} could start`);
      params = { ...params, timeoutMs: Math.min(requested, available) };
    }
    if (method === "armPageWait" || method === "armDialog") {
      const requested = pageWaitTimeout({ timeoutMs: params.timeoutMs as number | undefined });
      const available = Math.floor(requestRemaining(deadline, monotonicDeadline));
      if (available < 1) throw new Error("Open Browser Use page wait timed out before arm");
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
    if (monotonicDeadline !== undefined && requestRemaining(deadline, monotonicDeadline) <= (method === "browserAction" ? 1000 : 0)) {
      throw new Error(`Open Browser Use request timed out before ${method} could start`);
    }
    // The extra response-read allowance cannot authorize a late collect send.
    if (startBefore !== undefined) {
      if (downloadWaitMethods.has(method)) assertDownloadWaitDeadline(startBefore);
      else assertFileChooserWaitDeadline(startBefore);
    }
    const promise = new Promise<JsonValue>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Open Browser Use request timed out: ${method}`));
      }, Math.max(1, requestRemaining(deadline, monotonicDeadline)));
      this.#pending.set(id, { resolve, reject, timeout, strictUTF8: clipboardMethods.has(method) || dialogMethods.has(method) || (method === "browserAction" && params.action === "responseBody") });
    });
    try {
      socket.write(payload);
    } catch (error) {
      this.#disconnect(socket, error instanceof Error ? error : new Error(String(error)));
    }
    const result = await promise;
    if (method === "getInfo") this.#responseBodyVersion = isObject(result) && isObject(result.metadata) ? result.metadata.responseBodyVersion ?? null : null;
    if (method === "browserAction" && params.action === "responseBody") validateResponseBodyEnvelope(result, params);
    if (dialogMethods.has(method) && requestRemaining(deadline, monotonicDeadline) <= 0) throw new Error("Open Browser Use dialog decision timed out");
    if (method === "getInfo") this.#dialogVersion = isObject(result) && isObject(result.metadata) ? result.metadata.dialogVersion ?? null : null;
    if (method === "armDialog") return dialogAck(result, params.timeoutMs as number);
    if (method === "collectDialog") { dialogResult(result); return result; }
    if (method === "cancelDialog") dialogCancelled(result);
    if (pageWaitMethods.has(method) && requestRemaining(deadline, monotonicDeadline) <= 0) throw new Error("Open Browser Use page wait timed out");
    if (method === "getInfo") this.#pageWaitVersion = isObject(result) && isObject(result.metadata) ? result.metadata.pageWaitVersion ?? null : null;
    if (method === "armPageWait") return pageWaitAck(result, params.timeoutMs as number);
    if (method === "collectPageWait" && pageWaitResult(result) === params.tabId) throw new Error("Invalid page wait result: child equals source");
    if (method === "cancelPageWait") pageWaitCancelled(result);
    if (method === "getInfo") this.#mediaDownloadsVersion = isObject(result) && isObject(result.metadata) ? result.metadata.mediaDownloadsVersion ?? null : null;
    if (method === "getInfo") this.#directDownloadsVersion = isObject(result) && isObject(result.metadata) ? result.metadata.directDownloadsVersion ?? null : null;
    if (method === "getInfo") this.#clipboardVersion = isObject(result) && isObject(result.metadata) ? result.metadata.clipboardVersion ?? null : null;
    if (method === "getInfo") this.#pageExportVersion = isObject(result) && isObject(result.metadata) ? result.metadata.pageExportVersion ?? null : null;
    if (method === "getInfo") this.#navigationWaitVersion = isObject(result) && isObject(result.metadata) ? result.metadata.navigationWaitVersion ?? null : null;
    if (method === "getInfo") this.#networkWaitVersion = isObject(result) && isObject(result.metadata) ? result.metadata.networkWaitVersion ?? null : null;
    if (method === "getInfo") this.#fileChooserWaitVersion = isObject(result) && isObject(result.metadata) ? result.metadata.fileChooserWaitVersion ?? null : null;
    if (method === "getInfo") this.#downloadWaitVersion = isObject(result) && isObject(result.metadata) ? result.metadata.downloadWaitVersion ?? null : null;
    if (method === "getInfo") this.#downloadWaitPathVersion = isObject(result) && isObject(result.metadata) ? result.metadata.downloadWaitPathVersion ?? null : null;
    if (method === "armDownloadWait") return downloadWaitAck(result, params.timeoutMs as number);
    if (method === "collectDownloadWait") { downloadID(result); return result; }
    if (method === "cancelDownloadWait") downloadWaitCancelled(result);
    if (method === "armFileChooserWait") return fileChooserWaitAck(result, params.timeoutMs as number);
    if (method === "collectFileChooserWait") return fileChooserWaitResult(result);
    if (method === "cancelFileChooserWait") fileChooserWaitCancelled(result);
    return result;
  }

  getInfo(): Promise<JsonValue> {
    return this.request("getInfo");
  }

  async browserAction(tabId: number, action: string, options: {
    locator?: readonly OpenBrowserUseLocatorStep[];
    args?: BrowserUseRequestParams;
    timeoutMs?: number;
  } = {}): Promise<OpenBrowserUseActionResult> {
    if (action === "setInputFiles" && options.timeoutMs !== undefined && !Number.isInteger(options.timeoutMs)) throw new Error("setInputFiles timeoutMs must be an integer from 1 to 120000");
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new Error("browserAction timeoutMs must be between 1 and 120000");
    }
    const result = await this.request("browserAction", {
      tabId, action,
      ...(options.locator ? { locator: [...options.locator] as JsonValue[] } : {}),
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
    return { value: result.value, engine: result.engine as OpenBrowserUseEngineInfo };
  }

  async createTab(options: OpenBrowserUseCreateTabOptions = {}): Promise<JsonValue> {
    if (!isObject(options) || Object.keys(options).some(key => key !== "backgroundWindow")) throw new Error("Invalid createTab options");
    return this.request("createTab", createTabOptions(options));
  }

  getTabs(): Promise<JsonValue> {
    return this.request("getTabs");
  }

  getUserTabs(): Promise<JsonValue> {
    return this.request("getUserTabs");
  }

  getUserHistory(params: BrowserUseRequestParams = {}): Promise<JsonValue> {
    return this.request("getUserHistory", params);
  }

  claimUserTab(tabId: number): Promise<JsonValue> {
    return this.request("claimUserTab", { tabId });
  }

  finalizeTabs(keep: JsonValue[]): Promise<JsonValue> {
    return this.request("finalizeTabs", { keep });
  }

  nameSession(name: string): Promise<JsonValue> {
    return this.request("nameSession", { name });
  }

  attach(tabId: number): Promise<JsonValue> {
    return this.request("attach", { tabId });
  }

  detach(tabId: number): Promise<JsonValue> {
    return this.request("detach", { tabId });
  }

  executeCdp(tabId: number, method: string, commandParams: BrowserUseRequestParams = {}): Promise<JsonValue> {
    return this.request("executeCdp", {
      target: { tabId },
      method,
      commandParams
    });
  }

  moveMouse(tabId: number, x: number, y: number, waitForArrival = true): Promise<JsonValue> {
    return this.request("moveMouse", { tabId, x, y, waitForArrival });
  }

  waitForFileChooser(tabId: number, timeoutMs?: number): Promise<JsonValue> {
    return this.#waitForTabEvent("waitForFileChooser", tabId, timeoutMs);
  }

  setFileChooserFiles(fileChooserId: string, files: string[], timeoutMs?: number): Promise<JsonValue> {
    if (timeoutMs === undefined) return this.request("setFileChooserFiles", { fileChooserId, files });
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return Promise.reject(new Error("timeoutMs must be an integer between 1 and 120000"));
    return this.request("setFileChooserFiles", { fileChooserId, files, timeoutMs }, { timeoutMs: timeoutMs + 1000 });
  }

  waitForDownload(tabId: number, timeoutMs?: number): Promise<JsonValue> {
    return this.#waitForTabEvent("waitForDownload", tabId, timeoutMs);
  }

  #waitForTabEvent(method: string, tabId: number, timeoutMs = 10_000): Promise<JsonValue> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return Promise.reject(new Error("timeoutMs must be an integer between 1 and 120000"));
    return this.request(method, { tabId, timeoutMs }, { timeoutMs: timeoutMs + 1000 });
  }

  downloadPath(downloadId: string, timeoutMs?: number): Promise<JsonValue> {
    const timeout = downloadTimeout({ timeoutMs });
    return this.request("downloadPath", { downloadId, timeoutMs: timeout }, { timeoutMs: timeout + 1000 });
  }

  browserUserHistory(params: BrowserUseRequestParams = {}): Promise<JsonValue> {
    return this.getUserHistory(params);
  }

  async readClipboardText(tabId: number, options: OpenBrowserUseClipboardOptions = {}): Promise<JsonValue> {
    return this.#clipboard("readClipboardText", tabId, {}, options);
  }
  async writeClipboardText(tabId: number, text: string, options: OpenBrowserUseClipboardOptions = {}): Promise<JsonValue> {
    return this.#clipboard("writeClipboardText", tabId, { text }, options);
  }
  async readClipboard(tabId: number, options: OpenBrowserUseClipboardOptions = {}): Promise<JsonValue> {
    return this.#clipboard("readClipboard", tabId, {}, options);
  }
  async writeClipboard(tabId: number, items: JsonValue[], options: OpenBrowserUseClipboardOptions = {}): Promise<JsonValue> {
    return this.#clipboard("writeClipboard", tabId, { items }, options);
  }
  async #clipboard(method: string, tabId: number, payload: BrowserUseRequestParams, options: OpenBrowserUseClipboardOptions): Promise<JsonValue> {
    const params = clipboardParams(method, tabId, payload, options);
    const value = await this.request(method, params, { timeoutMs: (params.timeoutMs as number) + 1000 });
    return validateClipboardResult(method, value, params.maxBytes as number);
  }

  turnEnded(): Promise<JsonValue> {
    return this.request("turnEnded");
  }

  #handleData(chunk: Buffer): void {
    this.#pendingData = Buffer.concat([this.#pendingData, chunk]);
    while (this.#pendingData.length >= headerBytes) {
      const length =
        endianness() === "LE"
          ? this.#pendingData.readUInt32LE(0)
          : this.#pendingData.readUInt32BE(0);
      if (length > maxFrameBytes) throw new Error(`Open Browser Use frame too large: ${length} > ${maxFrameBytes}`);
      const total = headerBytes + length;
      if (this.#pendingData.length < total) {
        return;
      }
      const payload = this.#pendingData.subarray(headerBytes, total);
      this.#pendingData = this.#pendingData.subarray(total);
      this.#handleMessage(JSON.parse(payload.toString("utf8")) as JsonValue, payload);
    }
  }

  #handleMessage(message: JsonValue, payload: Buffer): void {
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
      } catch {
        pending.reject(new Error("Invalid clipboard response: UTF-8 is malformed"));
        return;
      }
    }
    if (isObject(message.error)) {
      pending.reject(new Error(String(message.error.message ?? "Open Browser Use request failed")));
      return;
    }
    pending.resolve((message.result ?? null) as JsonValue);
  }

  #rejectAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  #disconnect(socket: Socket, error: Error): void {
    // Only a never-connected first attempt may retry. An established physical
    // connection owns every cached scope and handle for this client's lifetime.
    // Keep the original error for pending work, and a stable error for new work.
    if (this.#socket !== socket) return;
    if (this.#connectedOnce) this.#disconnected = true;
    this.#socket = null;
    this.#connecting = null;
    this.#pendingData = Buffer.alloc(0);
    this.#rejectAll(error);
    socket.destroy();
  }
}

export async function connectOpenBrowserUse(options: OpenBrowserUseBrowserOptions): Promise<OpenBrowserUseBrowser> {
  const browser = new OpenBrowserUseBrowser(options);
  await browser.connect();
  return browser;
}

export class OpenBrowserUseBrowser {
  readonly client: OpenBrowserUseClient;
  readonly cdp: OpenBrowserUseCdp;

  constructor(options: OpenBrowserUseBrowserOptions) {
    this.client = "client" in options ? options.client : new OpenBrowserUseClient(options);
    this.cdp = new OpenBrowserUseCdp(this.client);
  }

  async connect(): Promise<this> {
    await this.client.connect();
    return this;
  }

  close(): void {
    this.client.close();
  }

  async newTab(options: OpenBrowserUseGotoOptions & OpenBrowserUseCreateTabOptions & { url?: string } = {}): Promise<OpenBrowserUseTab> {
    const createOptions = createTabOptions(options);
    const { url, waitUntil = "load" } = options;
    const timeoutMs = options.timeoutMs ?? (url ? defaultNavigationTimeoutMs : this.client.timeoutMs);
    if (url) assertSupportedLoadState(waitUntil);
    const scope = this.client[controlScopeSymbol](timeoutMs + (url ? 1000 : 0));
    const created = await scope.request("createTab", createOptions, url ? 1000 : 0);
    const tabId = tabIdFromValue(created, "createTab response");
    const tab = this.tab(tabId);
    if (url) {
      await scope.request("browserAction", { tabId, action: "goto", args: { url, waitUntil }, timeoutMs });
    }
    return tab;
  }

  tab(tabId: number): OpenBrowserUseTab {
    return new OpenBrowserUseTab(this, tabId);
  }

  getTabs(): Promise<JsonValue> {
    return this.client.getTabs();
  }
}

export class OpenBrowserUseTab {
  get clipboard(): OpenBrowserUseClipboard { return new OpenBrowserUseClipboard(this.browser.client, this.id); }
  readonly browser: OpenBrowserUseBrowser;
  readonly id: number;
  readonly playwright: OpenBrowserUseTabPlaywright;
  readonly mouse: OpenBrowserUseMouse;
  readonly keyboard: OpenBrowserUseKeyboard;

  constructor(browser: OpenBrowserUseBrowser, id: number) {
    this.browser = browser;
    this.id = id;
    this.playwright = new OpenBrowserUseTabPlaywright(this);
    this.mouse = new OpenBrowserUseMouse(this);
    this.keyboard = new OpenBrowserUseKeyboard(this);
  }

  async action(action: string, args: BrowserUseRequestParams = {}, options: { timeoutMs?: number } = {}): Promise<JsonValue> {
    return (await this.browser.client.browserAction(this.id, action, { args, ...options })).value;
  }

  async engineInfo(): Promise<OpenBrowserUseEngineInfo> {
    return (await this.browser.client.browserAction(this.id, "engineInfo")).engine;
  }

  downloadURL(url: string, options: OpenBrowserUseDownloadURLOptions = {}): Promise<OpenBrowserUseDownload> {
    return this.browser.client[downloadSymbol](this.id, "downloadURL", downloadURLParams(url, options));
  }

  async exportPage(format: OpenBrowserUseExportFormat, options: OpenBrowserUseExportOptions = {}): Promise<OpenBrowserUsePageExport> {
    const params = pageExportParams(format, options);
    const value = await this.browser.client.request("exportPage", { ...params, tabId: this.id }, { timeoutMs: (params.timeoutMs as number) + 1000 });
    return validatePageExport(value, format, params.maxBytes as number);
  }
  async responseBody(ref: OpenBrowserUseResponseBodyRef, options: OpenBrowserUseResponseBodyOptions = {}): Promise<OpenBrowserUseResponseBody> {
    const params = responseBodyParams(ref, options);
    return (await this.browser.client.browserAction(this.id, "responseBody", params)).value as OpenBrowserUseResponseBody;
  }
  exportPDF(options: OpenBrowserUseExportOptions = {}): Promise<OpenBrowserUsePageExport> { return this.exportPage("pdf", options); }
  exportMHTML(options: OpenBrowserUseExportOptions = {}): Promise<OpenBrowserUsePageExport> { return this.exportPage("mhtml", options); }

  waitForDownload(options: OpenBrowserUseDownloadOptions = {}): Promise<OpenBrowserUseDownload> {
    return this.browser.client[downloadSymbol](this.id, "waitForDownload", { timeoutMs: downloadTimeout(options) });
  }

  expectDialog(decision: OpenBrowserUseDialogDecision, options: OpenBrowserUseDialogOptions = {}): Promise<OpenBrowserUseDialogWait> {
    return this.browser.client[dialogSymbol](this.id, decision, options);
  }

  expectPage(options: OpenBrowserUsePageWaitOptions = {}): Promise<OpenBrowserUsePageWait> {
    return this.browser.client[pageWaitSymbol](this.id, options);
  }

  expectDownload(options: OpenBrowserUseDownloadWaitOptions = {}): Promise<OpenBrowserUseDownloadWait> {
    return this.browser.client[downloadWaitSymbol](this.id, options);
  }

  expectFileChooser(options: OpenBrowserUseFileChooserWaitOptions = {}): Promise<OpenBrowserUseFileChooserWait> {
    return this.browser.client[fileChooserWaitSymbol](this.id, options);
  }

  expectRequest(match: OpenBrowserUseNetworkWaitMatch, options: OpenBrowserUseNetworkWaitOptions = {}): Promise<OpenBrowserUseNetworkWait> {
    return this.browser.client[networkWaitSymbol](this.id, "request", match, options);
  }

  expectResponse(match: OpenBrowserUseNetworkWaitMatch, options: OpenBrowserUseNetworkWaitOptions = {}): Promise<OpenBrowserUseNetworkWait> {
    return this.browser.client[networkWaitSymbol](this.id, "response", match, options);
  }

  expectURL(url: string, options: OpenBrowserUseURLWaitOptions = {}): Promise<OpenBrowserUseNavigationWait> {
    return this.browser.client[navigationWaitSymbol](this.id, navigationWaitParams("url", url, options));
  }
  expectLoadState(options: OpenBrowserUseLoadStateWaitOptions = {}): Promise<OpenBrowserUseNavigationWait> {
    return this.browser.client[navigationWaitSymbol](this.id, navigationWaitParams("loadstate", undefined, options));
  }

  goto(url: string, options: OpenBrowserUseGotoOptions = {}): Promise<JsonValue> {
    if (!url) return Promise.reject(new Error("goto requires a URL"));
    assertSupportedLoadState(options.waitUntil ?? "load");
    return this.action("goto", { url, waitUntil: options.waitUntil ?? "load" }, options);
  }

  goBack(options: OpenBrowserUseGotoOptions = {}): Promise<JsonValue> {
    assertSupportedLoadState(options.waitUntil ?? "load");
    return this.action("goBack", { waitUntil: options.waitUntil ?? "load" }, options);
  }

  goForward(options: OpenBrowserUseGotoOptions = {}): Promise<JsonValue> {
    assertSupportedLoadState(options.waitUntil ?? "load");
    return this.action("goForward", { waitUntil: options.waitUntil ?? "load" }, options);
  }

  reload(options: OpenBrowserUseGotoOptions = {}): Promise<JsonValue> {
    assertSupportedLoadState(options.waitUntil ?? "load");
    return this.action("reload", { waitUntil: options.waitUntil ?? "load" }, options);
  }

  async waitForLoadState(options: OpenBrowserUseWaitForLoadStateOptions = {}): Promise<void> {
    assertSupportedLoadState(options.state ?? "load");
    await this.action("waitForLoadState", { state: options.state ?? "load" }, options);
  }

  async waitForURL(url: string, options: OpenBrowserUseActionOptions = {}): Promise<void> {
    await this.action("waitForURL", { ...actionArgs(options), url }, options);
  }

  async domSnapshot(options: OpenBrowserUseActionOptions = {}): Promise<string> {
    return expectString(await this.action("snapshot", actionArgs(options), options), "snapshot");
  }

  async snapshotAI(options: OpenBrowserUseAISnapshotOptions = {}): Promise<OpenBrowserUseAISnapshot> {
    const limits = aiSnapshotLimits(options);
    const boxes = options.boxes === true;
    return expectAISnapshot(await this.action("snapshotAI", actionArgs(options), options), limits, boxes);
  }

  async screenshot(options: OpenBrowserUseActionOptions = {}): Promise<OpenBrowserUseScreenshot> {
    return expectScreenshot(await this.action("screenshot", actionArgs(options), options));
  }

  async diagnostics(options: OpenBrowserUseDiagnosticsOptions = {}): Promise<OpenBrowserUseDiagnosticsSnapshot> {
    const value = await this.action("diagnostics", actionArgs(options), options);
    if (!isObject(value) || typeof value.captureId !== "string" || typeof value.startedAt !== "string" ||
        !Number.isSafeInteger(value.dropped) || (value.dropped as number) < 0 || !Array.isArray(value.entries) ||
        !isObject(value.cursor) || value.cursor.captureId !== value.captureId || !Number.isSafeInteger(value.cursor.sequence) || (value.cursor.sequence as number) < 0 ||
        value.entries.some(entry => !isObject(entry) || !Number.isSafeInteger(entry.sequence) || typeof entry.timestamp !== "string" ||
          !["console", "pageerror", "request", "response", "requestfinished", "requestfailed"].includes(String(entry.kind)))) throw new Error("Invalid diagnostics snapshot");
    return value as OpenBrowserUseDiagnosticsSnapshot;
  }

  locator(selector: string): OpenBrowserUseLocator { return this.playwright.locator(selector); }
  getByRef(captureId: string, ref: string): OpenBrowserUseLocator { return this.playwright.getByRef(captureId, ref); }
  frameLocator(selector: string): OpenBrowserUseLocator { return this.playwright.frameLocator(selector); }
  getByRole(role: string, options: { name?: string; exact?: boolean } = {}): OpenBrowserUseLocator { return this.playwright.getByRole(role, options); }
  getByText(value: string, options: { exact?: boolean } = {}): OpenBrowserUseLocator { return this.playwright.getByText(value, options); }
  getByLabel(value: string, options: { exact?: boolean } = {}): OpenBrowserUseLocator { return this.playwright.getByLabel(value, options); }
  getByPlaceholder(value: string, options: { exact?: boolean } = {}): OpenBrowserUseLocator { return this.playwright.getByPlaceholder(value, options); }
  getByAltText(value: string, options: { exact?: boolean } = {}): OpenBrowserUseLocator { return this.playwright.getByAltText(value, options); }
  getByTitle(value: string, options: { exact?: boolean } = {}): OpenBrowserUseLocator { return this.playwright.getByTitle(value, options); }
  getByTestId(value: string): OpenBrowserUseLocator { return this.playwright.getByTestId(value); }

  evaluate(expression: string, options: { awaitPromise?: boolean } = {}): Promise<JsonValue> {
    return this.browser.cdp.evaluate(this.id, expression, options);
  }

  close(): Promise<JsonValue> { return this.browser.cdp.call(this.id, "Page.close"); }
}

export class OpenBrowserUseLocator {
  readonly tab: OpenBrowserUseTab;
  readonly steps: readonly OpenBrowserUseLocatorStep[];

  constructor(tab: OpenBrowserUseTab, steps: readonly OpenBrowserUseLocatorStep[] = []) {
    this.tab = tab;
    if (steps.some(step => step.kind === "ref")) {
      if (steps.length !== 1 || steps[0].kind !== "ref") throw new Error("Ref locators cannot be chained");
      assertCaptureRef(steps[0].captureId, steps[0].ref);
    }
    this.steps = copyLocatorSteps(steps);
  }

  #append(step: OpenBrowserUseLocatorStep): OpenBrowserUseLocator {
    if (this.steps.some(existing => existing.kind === "ref")) throw new Error("Ref locators cannot be chained");
    return new OpenBrowserUseLocator(this.tab, [...this.steps, step]);
  }

  getByRef(captureId: string, ref: string): OpenBrowserUseLocator {
    if (this.steps.length) throw new Error("Ref locators must be created directly from a tab");
    return this.#append({ kind: "ref", captureId, ref });
  }
  locator(selector: string): OpenBrowserUseLocator { return this.#append({ kind: "css", selector }); }
  frameLocator(selector: string): OpenBrowserUseLocator { return this.#append({ kind: "frame", selector }); }
  getByRole(role: string, options: { name?: string; exact?: boolean } = {}): OpenBrowserUseLocator { return this.#append({ kind: "role", role, ...options }); }
  getByText(value: string, options: { exact?: boolean } = {}): OpenBrowserUseLocator { return this.#append({ kind: "text", value, ...options }); }
  getByLabel(value: string, options: { exact?: boolean } = {}): OpenBrowserUseLocator { return this.#append({ kind: "label", value, ...options }); }
  getByPlaceholder(value: string, options: { exact?: boolean } = {}): OpenBrowserUseLocator { return this.#append({ kind: "placeholder", value, ...options }); }
  getByAltText(value: string, options: { exact?: boolean } = {}): OpenBrowserUseLocator { return this.#append({ kind: "altText", value, ...options }); }
  getByTitle(value: string, options: { exact?: boolean } = {}): OpenBrowserUseLocator { return this.#append({ kind: "title", value, ...options }); }
  getByTestId(value: string): OpenBrowserUseLocator { return this.#append({ kind: "testId", value }); }
  first(): OpenBrowserUseLocator { return this.#append({ kind: "first" }); }
  last(): OpenBrowserUseLocator { return this.#append({ kind: "last" }); }
  nth(index: number): OpenBrowserUseLocator { return this.#append({ kind: "nth", index }); }
  #operand(other: OpenBrowserUseLocator, relative: boolean): readonly OpenBrowserUseLocatorStep[] {
    if (!(other instanceof OpenBrowserUseLocator) || other.tab.id !== this.tab.id || other.tab.browser.client !== this.tab.browser.client) throw new Error("Locator composition requires the same tab and client");
    return relativeLocatorSteps(this.steps, other.steps, relative);
  }
  filter(options: OpenBrowserUseFilterOptions): OpenBrowserUseLocator {
    if (!options || typeof options !== "object" || Object.keys(options).some(key => !["hasText", "hasNotText", "visible", "has", "hasNot"].includes(key))) throw new Error("Invalid filter options");
    const { has, hasNot, ...values } = options;
    return this.#append({ kind: "filter", ...values, ...(has !== undefined ? { has: this.#operand(has, true) } : {}), ...(hasNot !== undefined ? { hasNot: this.#operand(hasNot, true) } : {}) });
  }
  and(other: OpenBrowserUseLocator): OpenBrowserUseLocator { return this.#append({ kind: "and", locator: this.#operand(other, false) }); }
  or(other: OpenBrowserUseLocator): OpenBrowserUseLocator { return this.#append({ kind: "or", locator: this.#operand(other, false) }); }

  async #perform(action: string, options: OpenBrowserUseActionOptions = {}): Promise<JsonValue> {
    return (await this.tab.browser.client.browserAction(this.tab.id, action, {
      locator: this.steps, args: actionArgs(options), timeoutMs: options.timeoutMs
    })).value;
  }

  downloadMedia(options: OpenBrowserUseMediaDownloadOptions = {}): Promise<OpenBrowserUseDownload> {
    if (!this.steps.length) throw new Error("downloadMedia requires a nonempty locator");
    return this.tab.browser.client[downloadSymbol](this.tab.id, "downloadMedia", { ...downloadFileParams(options), locator: [...this.steps] as JsonValue[] });
  }

  async click(options: OpenBrowserUseActionOptions = {}): Promise<void> { await this.#perform("click", options); }
  async dblclick(options: OpenBrowserUseActionOptions = {}): Promise<void> { await this.#perform("dblclick", options); }
  async hover(options: OpenBrowserUseActionOptions = {}): Promise<void> { await this.#perform("hover", options); }
  async focus(options: OpenBrowserUseActionOptions = {}): Promise<void> { await this.#perform("focus", options); }
  async scrollIntoViewIfNeeded(options: OpenBrowserUseActionOptions = {}): Promise<void> { await this.#perform("scrollIntoViewIfNeeded", options); }
  async pressSequentially(text: string, options: OpenBrowserUseActionOptions = {}): Promise<void> { await this.#perform("pressSequentially", { ...options, text }); }
  async dragTo(target: OpenBrowserUseLocator, options: OpenBrowserUseActionOptions = {}): Promise<void> {
    if (!(target instanceof OpenBrowserUseLocator) || target.tab.id !== this.tab.id || target.tab.browser.client !== this.tab.browser.client) {
      throw new Error("dragTo requires a target locator from the same tab and client");
    }
    assertCombinedLocatorBudget(this.steps, target.steps);
    await this.#perform("dragTo", { ...options, target: [...target.steps] as JsonValue[] });
  }
  async setInputFiles(files: string[], options: { timeoutMs?: number } = {}): Promise<void> {
    if (!isObject(options) || Object.keys(options).some(key => key !== "timeoutMs")) throw new Error("Invalid setInputFiles options");
    await this.#perform("setInputFiles", { ...options, files });
  }
  async fill(value: string, options: OpenBrowserUseActionOptions = {}): Promise<void> { await this.#perform("fill", { ...options, value }); }
  async press(key: string, options: OpenBrowserUseActionOptions = {}): Promise<void> { await this.#perform("press", { ...options, key }); }
  async check(options: OpenBrowserUseActionOptions = {}): Promise<void> { await this.#perform("check", options); }
  async uncheck(options: OpenBrowserUseActionOptions = {}): Promise<void> { await this.#perform("uncheck", options); }
  async setChecked(checked: boolean, options: OpenBrowserUseActionOptions = {}): Promise<void> { await this.#perform("setChecked", { ...options, checked }); }
  async selectOption(values: JsonValue, options: OpenBrowserUseActionOptions = {}): Promise<string[]> { return expectStrings(await this.#perform("selectOption", { ...options, values }), "selectOption"); }
  async waitFor(options: OpenBrowserUseActionOptions = {}): Promise<void> { await this.#perform("waitFor", options); }
  async count(): Promise<number> { const value = await this.#perform("count"); if (typeof value !== "number") throw new Error("Invalid count result"); return value; }
  async innerText(options: OpenBrowserUseActionOptions = {}): Promise<string> { return expectString(await this.#perform("innerText", options), "innerText"); }
  async textContent(options: OpenBrowserUseActionOptions = {}): Promise<string | null> { const value = await this.#perform("textContent", options); return value === null ? null : expectString(value, "textContent"); }
  async inputValue(options: OpenBrowserUseActionOptions = {}): Promise<string> { return expectString(await this.#perform("inputValue", options), "inputValue"); }
  async getAttribute(name: string, options: OpenBrowserUseActionOptions = {}): Promise<string | null> { const value = await this.#perform("getAttribute", { ...options, name }); return value === null ? null : expectString(value, "getAttribute"); }
  async isVisible(): Promise<boolean> { return expectBoolean(await this.#perform("isVisible"), "isVisible"); }
  async isEnabled(): Promise<boolean> { return expectBoolean(await this.#perform("isEnabled"), "isEnabled"); }
  async isChecked(): Promise<boolean> { return expectBoolean(await this.#perform("isChecked"), "isChecked"); }
  async boundingBox(options: OpenBrowserUseActionOptions = {}): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const value = await this.#perform("boundingBox", options);
    if (value === null) return null;
    if (!isObject(value) || ["x", "y", "width", "height"].some(key => typeof value[key] !== "number")) throw new Error("Invalid boundingBox result");
    return value as { x: number; y: number; width: number; height: number };
  }
  async allTextContents(): Promise<string[]> { return expectStrings(await this.#perform("allTextContents"), "allTextContents"); }
  async allInnerTexts(): Promise<string[]> { return expectStrings(await this.#perform("allInnerTexts"), "allInnerTexts"); }
  async ariaSnapshot(options: OpenBrowserUseActionOptions = {}): Promise<string> { return expectString(await this.#perform("snapshot", options), "snapshot"); }
  async screenshot(options: OpenBrowserUseActionOptions = {}): Promise<OpenBrowserUseScreenshot> { return expectScreenshot(await this.#perform("screenshot", options)); }
}

export class OpenBrowserUseTabPlaywright extends OpenBrowserUseLocator {
  responseBody(ref: OpenBrowserUseResponseBodyRef, options: OpenBrowserUseResponseBodyOptions = {}): Promise<OpenBrowserUseResponseBody> { return this.tab.responseBody(ref, options); }
  expectRequest(match: OpenBrowserUseNetworkWaitMatch, options: OpenBrowserUseNetworkWaitOptions = {}): Promise<OpenBrowserUseNetworkWait> { return this.tab.expectRequest(match, options); }
  expectDialog(decision: OpenBrowserUseDialogDecision, options: OpenBrowserUseDialogOptions = {}): Promise<OpenBrowserUseDialogWait> { return this.tab.expectDialog(decision, options); }
  expectPage(options: OpenBrowserUsePageWaitOptions = {}): Promise<OpenBrowserUsePageWait> { return this.tab.expectPage(options); }
  expectDownload(options: OpenBrowserUseDownloadWaitOptions = {}): Promise<OpenBrowserUseDownloadWait> { return this.tab.expectDownload(options); }
  expectFileChooser(options: OpenBrowserUseFileChooserWaitOptions = {}): Promise<OpenBrowserUseFileChooserWait> { return this.tab.expectFileChooser(options); }
  expectResponse(match: OpenBrowserUseNetworkWaitMatch, options: OpenBrowserUseNetworkWaitOptions = {}): Promise<OpenBrowserUseNetworkWait> { return this.tab.expectResponse(match, options); }
  snapshotAI(options: OpenBrowserUseAISnapshotOptions = {}): Promise<OpenBrowserUseAISnapshot> { return this.tab.snapshotAI(options); }
  goBack(options: OpenBrowserUseGotoOptions = {}): Promise<JsonValue> { return this.tab.goBack(options); }
  goForward(options: OpenBrowserUseGotoOptions = {}): Promise<JsonValue> { return this.tab.goForward(options); }
  reload(options: OpenBrowserUseGotoOptions = {}): Promise<JsonValue> { return this.tab.reload(options); }
  waitForLoadState(options: OpenBrowserUseWaitForLoadStateOptions = {}): Promise<void> { return this.tab.waitForLoadState(options); }
  expectURL(url: string, options: OpenBrowserUseURLWaitOptions = {}): Promise<OpenBrowserUseNavigationWait> { return this.tab.expectURL(url, options); }
  expectLoadState(options: OpenBrowserUseLoadStateWaitOptions = {}): Promise<OpenBrowserUseNavigationWait> { return this.tab.expectLoadState(options); }
  waitForURL(url: string, options: OpenBrowserUseActionOptions = {}): Promise<void> { return this.tab.waitForURL(url, options); }
  domSnapshot(options: OpenBrowserUseActionOptions = {}): Promise<string> { return this.tab.domSnapshot(options); }
  engineInfo(): Promise<OpenBrowserUseEngineInfo> { return this.tab.engineInfo(); }
}

export class OpenBrowserUseMouse {
  constructor(readonly tab: OpenBrowserUseTab) {}
  async move(x: number, y: number, options: OpenBrowserUseActionOptions = {}): Promise<void> { await this.tab.action("mouse.move", { ...actionArgs(options), x, y }, options); }
  async click(x: number, y: number, options: OpenBrowserUseActionOptions = {}): Promise<void> { await this.tab.action("mouse.click", { ...actionArgs(options), x, y }, options); }
  async down(options: OpenBrowserUseActionOptions = {}): Promise<void> { await this.tab.action("mouse.down", actionArgs(options), options); }
  async up(options: OpenBrowserUseActionOptions = {}): Promise<void> { await this.tab.action("mouse.up", actionArgs(options), options); }
  async wheel(deltaX: number, deltaY: number): Promise<void> { await this.tab.action("mouse.wheel", { deltaX, deltaY }); }
}

export class OpenBrowserUseKeyboard {
  constructor(readonly tab: OpenBrowserUseTab) {}
  async press(key: string, options: OpenBrowserUseActionOptions = {}): Promise<void> { await this.tab.action("keyboard.press", { ...actionArgs(options), key }, options); }
  async type(text: string, options: OpenBrowserUseActionOptions = {}): Promise<void> { await this.tab.action("keyboard.type", { ...actionArgs(options), text }, options); }
  async insertText(text: string): Promise<void> { await this.tab.action("keyboard.insertText", { text }); }
}

function actionArgs(options: object): BrowserUseRequestParams {
  return Object.fromEntries(Object.entries(options).filter(([key, value]) => key !== "timeoutMs" && value !== undefined)) as BrowserUseRequestParams;
}

function expectString(value: JsonValue, action: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${action} result`);
  return value;
}
function expectStrings(value: JsonValue, action: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`Invalid ${action} result`);
  return value as string[];
}
function expectBoolean(value: JsonValue, action: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid ${action} result`);
  return value;
}
function expectScreenshot(value: JsonValue): OpenBrowserUseScreenshot {
  if (!isObject(value) || typeof value.base64 !== "string" || typeof value.mimeType !== "string") throw new Error("Invalid screenshot result");
  return { base64: value.base64, mimeType: value.mimeType };
}

const aiLimits: Readonly<OpenBrowserUseAISnapshotLimits> = Object.freeze({ maxBytes: 262144, maxNodes: 5000, maxRefs: 2000, maxFrames: 32, maxDepth: 64 });
function validRef(ref: unknown): ref is string {
  return typeof ref === "string" && ref.length <= 64 && /^(?:f[1-9][0-9]*)?e[1-9][0-9]*$/.exec(ref)?.[0] === ref;
}
function assertCaptureRef(captureId: unknown, ref: unknown): void {
  if (typeof captureId !== "string" || !captureId.length || captureId.length > 128) throw new Error("captureId must be a non-empty string of at most 128 characters");
  if (!validRef(ref)) throw new Error("ref must be a native snapshot reference of at most 64 characters");
}
function aiSnapshotLimits(options: OpenBrowserUseAISnapshotOptions): typeof aiLimits {
  const limits = { ...aiLimits };
  for (const [key, value] of Object.entries(options)) {
    if (key === "timeoutMs") continue;
    if (key === "boxes") {
      if (value !== undefined && typeof value !== "boolean") throw new Error("boxes must be a boolean");
      continue;
    }
    if (!Object.hasOwn(aiLimits, key)) throw new Error(`snapshotAI does not support ${key}`);
    if (value === undefined) continue;
    const name = key as keyof typeof aiLimits;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > aiLimits[name]) throw new Error(`${key} must be a positive integer <= ${aiLimits[name]}`);
    limits[name] = value;
  }
  return limits;
}
function expectAISnapshot(value: JsonValue, limits: typeof aiLimits, boxes: boolean): OpenBrowserUseAISnapshot {
  const invalid = () => new Error("Invalid snapshotAI result");
  const fields = ["captureId", "snapshot", "refs", "stats", "complete", ...(boxes ? ["geometry"] : [])];
  if (!isObject(value) || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key)) ||
      value.complete !== true || typeof value.captureId !== "string" || !value.captureId.length || value.captureId.length > 128 ||
      typeof value.snapshot !== "string" || !Array.isArray(value.refs) || value.refs.length > limits.maxRefs || value.refs.some(ref => !validRef(ref)) ||
      new Set(value.refs).size !== value.refs.length || !isObject(value.stats)) throw invalid();
  const stats = value.stats;
  if (Object.keys(stats).some(key => !["bytes", "nodes", "refs", "frames"].includes(key)) ||
      ["bytes", "nodes", "refs", "frames"].some(key => !Number.isSafeInteger(stats[key]) || (stats[key] as number) < 0) ||
      stats.bytes !== Buffer.byteLength(value.snapshot, "utf8") || (stats.bytes as number) > limits.maxBytes ||
      (stats.nodes as number) > limits.maxNodes || stats.refs !== value.refs.length ||
      (stats.frames as number) < 1 || (stats.frames as number) > limits.maxFrames) throw invalid();
  if (boxes && !validAIGeometry(value.geometry, value.refs as string[], stats.frames as number)) throw invalid();
  return value as OpenBrowserUseAISnapshot;
}

function validAIGeometry(value: JsonValue | undefined, refs: string[], frameCount: number): boolean {
  const exact = (value: unknown, keys: string[]): value is Record<string, JsonValue> =>
    isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const refFrame = (ref: string): string => /^(f[1-9][0-9]*)e/.exec(ref)?.[1] ?? "root";
  if (!exact(value, ["coordinateSpace", "frames", "boxes"]) || value.coordinateSpace !== "frame-viewport-css" ||
      !Array.isArray(value.frames) || value.frames.length !== frameCount || !Array.isArray(value.boxes) || value.boxes.length !== refs.length) return false;
  const refSet = new Set(refs), boxesByRef = new Map<string, string>(), frames = new Set<string>(), owners = new Set<string>();
  for (const entry of value.boxes) {
    if (!exact(entry, ["ref", "frameId", "box"]) || typeof entry.ref !== "string" || !refSet.has(entry.ref) || boxesByRef.has(entry.ref) ||
        typeof entry.frameId !== "string" || entry.frameId !== refFrame(entry.ref) || !exact(entry.box, ["x", "y", "width", "height"]) ||
        !Object.values(entry.box).every(finite) || (entry.box.width as number) < 0 || (entry.box.height as number) < 0) return false;
    boxesByRef.set(entry.ref, entry.frameId);
  }
  for (const [index, frame] of value.frames.entries()) {
    if (!exact(frame, ["id", "parentId", "ownerRef", "viewport"]) || typeof frame.id !== "string" || frames.has(frame.id) ||
        !exact(frame.viewport, ["width", "height", "scrollX", "scrollY", "devicePixelRatio"]) || !Object.values(frame.viewport).every(finite) ||
        (frame.viewport.width as number) < 0 || (frame.viewport.height as number) < 0 || (frame.viewport.devicePixelRatio as number) <= 0) return false;
    if (index === 0) {
      if (frame.id !== "root" || frame.parentId !== null || frame.ownerRef !== null) return false;
    } else if (/^f([1-9]|[12][0-9]|3[0-2])$/.exec(frame.id)?.[0] !== frame.id || typeof frame.parentId !== "string" || !frames.has(frame.parentId) ||
        typeof frame.ownerRef !== "string" || owners.has(frame.ownerRef) || boxesByRef.get(frame.ownerRef) !== frame.parentId) return false;
    frames.add(frame.id);
    if (typeof frame.ownerRef === "string") owners.add(frame.ownerRef);
  }
  return [...boxesByRef.values()].every(frameId => frames.has(frameId));
}

export class OpenBrowserUseCdp {
  readonly client: OpenBrowserUseClient;

  constructor(client: OpenBrowserUseClient) {
    this.client = client;
  }

  async call(
    tabId: number,
    method: string,
    commandParams: BrowserUseRequestParams = {},
    options: { timeoutMs?: number } = {}
  ): Promise<JsonValue> {
    return this.#call(this.client[controlScopeSymbol](options.timeoutMs ?? this.client.timeoutMs), tabId, method, commandParams);
  }

  async #call(scope: ControlScope, tabId: number, method: string, commandParams: BrowserUseRequestParams = {}): Promise<JsonValue> {
    const commands = JSON.parse(JSON.stringify(commandParams)) as BrowserUseRequestParams;
    await scope.request("attach", { tabId });
    const remaining = scope.remaining();
    if (remaining < 1) throw new Error("Open Browser Use CDP request timed out before sending");
    return scope.request("executeCdp", {
      target: { tabId },
      method,
      commandParams: commands,
      timeoutMs: remaining
    });
  }

  async evaluate(tabId: number, expression: string, options: { awaitPromise?: boolean } = {}): Promise<JsonValue> {
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

  async navigate(tabId: number, url: string, options: OpenBrowserUseGotoOptions = {}): Promise<JsonValue> {
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

  async waitForLoadState(tabId: number, options: OpenBrowserUseWaitForLoadStateOptions = {}): Promise<void> {
    const state = options.state ?? "load";
    assertSupportedLoadState(state);
    const scope = this.client[controlScopeSymbol](options.timeoutMs ?? defaultNavigationTimeoutMs);
    await this.#call(scope, tabId, "Page.enable");
    await this.#waitForLoadState(scope, tabId, state);
  }

  async #waitForLoadState(scope: ControlScope, tabId: number, state: OpenBrowserUseLoadState, loaderId?: string): Promise<void> {
    const sameLoader = async (): Promise<boolean> => {
      if (!loaderId) return true;
      const tree = await this.#call(scope, tabId, "Page.getFrameTree");
      return isObject(tree) && isObject(tree.frameTree) && isObject(tree.frameTree.frame) && tree.frameTree.frame.loaderId === loaderId;
    };
    while (true) {
      // A previous document's load event or complete readyState cannot satisfy
      // navigation. Check the returned loader on both sides of the state read.
      if (await sameLoader() && documentStateMatches(await this.#readDocumentState(scope, tabId), state) && await sameLoader()) return;
      const remaining = scope.remaining();
      if (remaining < 1) throw new Error(`Timed out waiting for ${state} in tab ${tabId}`);
      await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
    }
  }

  async #readDocumentState(scope: ControlScope, tabId: number): Promise<{ href?: string; readyState?: string } | undefined> {
    const result = await this.#call(scope, tabId, "Runtime.evaluate", { expression: "({ href: window.location.href, readyState: document.readyState })", returnByValue: true });
    const value = isObject(result) && isObject(result.result) ? result.result.value : undefined;
    return isObject(value) ? { href: stringValue(value.href), readyState: stringValue(value.readyState) } : undefined;
  }

  async readDocumentState(tabId: number): Promise<{ href?: string; readyState?: string } | undefined> {
    try {
      const value = await this.evaluate(tabId, "({ href: window.location.href, readyState: document.readyState })");
      return isObject(value) ? { href: stringValue(value.href), readyState: stringValue(value.readyState) } : undefined;
    } catch {
      return undefined;
    }
  }

  waitForEvent(
    tabId: number,
    predicate: (notification: OpenBrowserUseNotification) => boolean,
    options: { timeoutMs?: number; timeoutMessage?: string } = {}
  ): Promise<OpenBrowserUseNotification> {
    const timeoutMs = options.timeoutMs ?? defaultNavigationTimeoutMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      let removeHandler: (() => void) | null = null;
      let timer: NodeJS.Timeout;
      const finish = (): boolean => {
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
        } catch (error) {
          if (finish()) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
    });
  }

  waitForLoadEvent(tabId: number, state: OpenBrowserUseLoadState, timeoutMs: number): Promise<void> {
    return this.waitForEvent(
      tabId,
      (notification) => {
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
      },
      {
        timeoutMs,
        timeoutMessage: `Timed out waiting for ${state} in tab ${tabId}`
      }
    ).then(() => undefined);
  }

  async ensureAttached(tabId: number): Promise<void> {
    // Engine deadlines, navigation, and turn cleanup can detach while this
    // client remains connected. Attach is idempotent; execute is never replayed.
    await this.client.attach(tabId);
  }
}

export function encodeFrame(value: JsonValue | Record<string, unknown>): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > maxFrameBytes) throw new Error("Open Browser Use frame exceeds 64 MiB");
  const frame = Buffer.alloc(headerBytes + payload.length);
  if (endianness() === "LE") {
    frame.writeUInt32LE(payload.length, 0);
  } else {
    frame.writeUInt32BE(payload.length, 0);
  }
  payload.copy(frame, headerBytes);
  return frame;
}

function parseControlState(value: JsonValue): OpenBrowserUseControlState {
  if (!isObject(value) || value.lifecycleVersion !== 1 || !Number.isSafeInteger(value.controlEpoch) || (value.controlEpoch as number) < 0 ||
      typeof value.closing !== "boolean" || typeof value.nextTurnId !== "string" || !value.nextTurnId) throw new Error("Invalid control state; update the Open Browser Use extension");
  return { controlEpoch: value.controlEpoch as number, closing: value.closing, nextTurnId: value.nextTurnId, lifecycleVersion: 1 };
}

function parseEndedControl(value: JsonValue): ControlBinding {
  if (!isObject(value) || typeof value.endedTurnId !== "string" || !value.endedTurnId) throw new Error("Invalid control-end acknowledgement; call beginTurn() explicitly to recover");
  return parseControlState({ ...value, closing: false });
}

function requestRemaining(deadline: number, monotonicDeadline?: number): number {
  return Math.min(deadline - Date.now(), monotonicDeadline === undefined ? Infinity : monotonicDeadline - performance.now());
}

async function beforeDeadline<T>(work: Promise<T>, deadline: number, method: string, monotonicDeadline?: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Open Browser Use request timed out: ${method}`)), Math.max(0, requestRemaining(deadline, monotonicDeadline)));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function assertTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error("timeoutMs must be a positive finite timer duration");
  }
}

function isObject(value: JsonValue | unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tabIdFromValue(value: JsonValue, label: string): number {
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

function assertSupportedLoadState(state: string): asserts state is OpenBrowserUseLoadState {
  if (state !== "domcontentloaded" && state !== "load") {
    throw new Error(`Unsupported load state "${state}". Use "domcontentloaded" or "load".`);
  }
}

function documentStateMatches(documentState: { readyState?: string } | undefined, state: OpenBrowserUseLoadState): boolean {
  if (documentState?.readyState === "complete") {
    return true;
  }
  return state === "domcontentloaded" && documentState?.readyState === "interactive";
}

function cdpEventForTab(
  notification: OpenBrowserUseNotification,
  tabId: number
): { method?: string } | null {
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

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export type OpenBrowserUseCreateTabOptions = { backgroundWindow?: boolean };

function createTabOptions(options: OpenBrowserUseCreateTabOptions): BrowserUseRequestParams {
  if (!isObject(options) || (options.backgroundWindow !== undefined && typeof options.backgroundWindow !== "boolean")) throw new Error("backgroundWindow must be a boolean");
  return options.backgroundWindow === true ? { backgroundWindow: true } : {};
}
