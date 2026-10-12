import { OpenBrowserUsePageWait, type OpenBrowserUsePageWaitOptions } from "./page-waits.js";
export { OpenBrowserUsePageWait, type OpenBrowserUsePageWaitOptions } from "./page-waits.js";
import { OpenBrowserUseDownloadWait, type OpenBrowserUseDownloadWaitOptions } from "./download-waits.js";
export { OpenBrowserUseDownloadWait, type OpenBrowserUseDownloadWaitOptions } from "./download-waits.js";
import { OpenBrowserUseClipboard, type OpenBrowserUseClipboardOptions } from "./clipboard.js";
import { OpenBrowserUseFileChooserWait, type OpenBrowserUseFileChooserWaitOptions } from "./file-chooser-waits.js";
export { OpenBrowserUseFileChooserWait, type OpenBrowserUseFileChooserWaitOptions, type OpenBrowserUseFileChooserWaitResult } from "./file-chooser-waits.js";
export { OpenBrowserUseClipboard } from "./clipboard.js";
export type { OpenBrowserUseClipboardOptions, OpenBrowserUseClipboardItem, OpenBrowserUseClipboardEntry } from "./clipboard.js";
import { OpenBrowserUseDownload, type OpenBrowserUseMediaDownloadOptions, type OpenBrowserUseDownloadOptions, type OpenBrowserUseDownloadURLOptions } from "./downloads.js";
import { type OpenBrowserUseExportFormat, type OpenBrowserUseExportOptions, type OpenBrowserUsePageExport } from "./page-exports.js";
export { type OpenBrowserUseExportFormat, type OpenBrowserUseExportOptions, type OpenBrowserUsePDFOptions, type OpenBrowserUsePageExport } from "./page-exports.js";
export { OpenBrowserUseDownload, type OpenBrowserUseMediaDownloadOptions, type OpenBrowserUseDownloadOptions, type OpenBrowserUseDownloadURLOptions } from "./downloads.js";
import { OpenBrowserUseNavigationWait, type OpenBrowserUseURLWaitOptions, type OpenBrowserUseLoadStateWaitOptions } from "./navigation-waits.js";
export { OpenBrowserUseNavigationWait, type OpenBrowserUseNavigationWaitOptions, type OpenBrowserUseURLWaitOptions, type OpenBrowserUseLoadStateWaitOptions } from "./navigation-waits.js";
import { OpenBrowserUseNetworkWait, type OpenBrowserUseNetworkWaitEvent, type OpenBrowserUseNetworkWaitMatch, type OpenBrowserUseNetworkWaitOptions } from "./network-waits.js";
export { OpenBrowserUseNetworkWait, type OpenBrowserUseNetworkWaitEvent, type OpenBrowserUseNetworkWaitMatch, type OpenBrowserUseNetworkWaitOptions, type OpenBrowserUseNetworkWaitResult } from "./network-waits.js";
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export type BrowserUseRequestParams = {
    [key: string]: JsonValue;
};
export type OpenBrowserUseClientOptions = {
    socketPath: string;
    sessionId?: string;
    turnId?: string;
    timeoutMs?: number;
};
export type OpenBrowserUseNotification = {
    method: string;
    params?: JsonValue;
};
export type NotificationHandler = (notification: OpenBrowserUseNotification) => void;
export type OpenBrowserUseLoadState = "domcontentloaded" | "load";
export type OpenBrowserUseGotoOptions = {
    waitUntil?: OpenBrowserUseLoadState;
    timeoutMs?: number;
};
export type OpenBrowserUseWaitForLoadStateOptions = {
    state?: OpenBrowserUseLoadState;
    timeoutMs?: number;
};
export type OpenBrowserUseBrowserOptions = OpenBrowserUseClientOptions | {
    client: OpenBrowserUseClient;
};
export type OpenBrowserUseLocatorStep = {
    kind: "ref";
    captureId: string;
    ref: string;
} | {
    kind: "css" | "frame";
    selector: string;
} | {
    kind: "role";
    role: string;
    name?: string;
    exact?: boolean;
} | {
    kind: "text" | "label" | "placeholder" | "altText" | "title" | "testId";
    value: string;
    exact?: boolean;
} | {
    kind: "nth";
    index: number;
} | {
    kind: "first" | "last";
} | {
    kind: "filter";
    hasText?: string;
    hasNotText?: string;
    visible?: boolean;
    has?: readonly OpenBrowserUseLocatorStep[];
    hasNot?: readonly OpenBrowserUseLocatorStep[];
} | {
    kind: "and" | "or";
    locator: readonly OpenBrowserUseLocatorStep[];
};
export type OpenBrowserUseFilterOptions = {
    hasText?: string;
    hasNotText?: string;
    visible?: boolean;
    has?: OpenBrowserUseLocator;
    hasNot?: OpenBrowserUseLocator;
};
export type OpenBrowserUseAISnapshotLimits = {
    maxBytes: number;
    maxNodes: number;
    maxRefs: number;
    maxFrames: number;
    maxDepth: number;
};
export type OpenBrowserUseEngineInfo = {
    name: "playwright-crx";
    version: string;
    playwrightVersion: string;
    capabilities?: {
        snapshotAI: 1;
        captureRefs: 1;
        snapshotBoxes?: 1;
        locatorFileUpload?: 1;
    };
    snapshotLimits?: OpenBrowserUseAISnapshotLimits;
};
export type OpenBrowserUseActionResult = {
    value: JsonValue;
    engine: OpenBrowserUseEngineInfo;
};
export type OpenBrowserUseActionOptions = {
    timeoutMs?: number;
    [key: string]: JsonValue | undefined;
};
export type OpenBrowserUseScreenshot = {
    base64: string;
    mimeType: string;
};
export type OpenBrowserUseAISnapshotOptions = {
    timeoutMs?: number;
    maxBytes?: number;
    maxNodes?: number;
    maxRefs?: number;
    maxFrames?: number;
    maxDepth?: number;
    boxes?: boolean;
};
export type OpenBrowserUseAISnapshotBox = {
    x: number;
    y: number;
    width: number;
    height: number;
};
export type OpenBrowserUseAISnapshotFrame = {
    id: string;
    parentId: string | null;
    ownerRef: string | null;
    viewport: {
        width: number;
        height: number;
        scrollX: number;
        scrollY: number;
        devicePixelRatio: number;
    };
};
export type OpenBrowserUseAISnapshotGeometry = {
    coordinateSpace: "frame-viewport-css";
    frames: OpenBrowserUseAISnapshotFrame[];
    boxes: {
        ref: string;
        frameId: string;
        box: OpenBrowserUseAISnapshotBox;
    }[];
};
export type OpenBrowserUseAISnapshot = {
    captureId: string;
    snapshot: string;
    refs: string[];
    stats: {
        bytes: number;
        nodes: number;
        refs: number;
        frames: number;
    };
    complete: true;
    geometry?: OpenBrowserUseAISnapshotGeometry;
};
export type OpenBrowserUseControlState = {
    controlEpoch: number;
    closing: boolean;
    nextTurnId: string;
    lifecycleVersion: 1;
};
export type OpenBrowserUseDiagnosticsCursor = {
    captureId: string;
    sequence: number;
};
export type OpenBrowserUseDiagnosticsOptions = {
    after?: OpenBrowserUseDiagnosticsCursor;
    limit?: number;
    timeoutMs?: number;
};
export type OpenBrowserUseDiagnosticsSnapshot = {
    captureId: string;
    startedAt: string;
    cursor: OpenBrowserUseDiagnosticsCursor;
    dropped: number;
    entries: (BrowserUseRequestParams & {
        sequence: number;
        timestamp: string;
        kind: "console" | "pageerror" | "request" | "response" | "requestfinished" | "requestfailed";
    })[];
};
declare const downloadSymbol: unique symbol;
declare const pageWaitSymbol: unique symbol;
declare const downloadWaitSymbol: unique symbol;
declare const navigationWaitSymbol: unique symbol;
declare const networkWaitSymbol: unique symbol;
declare const fileChooserWaitSymbol: unique symbol;
declare const controlScopeSymbol: unique symbol;
type ControlScope = {
    request(method: string, params?: BrowserUseRequestParams, reservedResponseMs?: number): Promise<JsonValue>;
    remaining(): number;
};
export declare class OpenBrowserUseClient {
    #private;
    readonly socketPath: string;
    readonly sessionId: string;
    readonly timeoutMs: number;
    constructor(options: OpenBrowserUseClientOptions);
    get turnId(): string;
    get controlEpoch(): number | null;
    connect(): Promise<this>;
    close(): void;
    onNotification(handler: NotificationHandler): () => void;
    request(method: string, params?: BrowserUseRequestParams, options?: {
        timeoutMs?: number;
    }): Promise<JsonValue>;
    [downloadSymbol](tabId: number, method: "downloadURL" | "downloadMedia" | "waitForDownload", params: BrowserUseRequestParams): Promise<OpenBrowserUseDownload>;
    [networkWaitSymbol](tabId: number, event: OpenBrowserUseNetworkWaitEvent, match: OpenBrowserUseNetworkWaitMatch, options?: OpenBrowserUseNetworkWaitOptions): Promise<OpenBrowserUseNetworkWait>;
    [navigationWaitSymbol](tabId: number, params: BrowserUseRequestParams): Promise<OpenBrowserUseNavigationWait>;
    [pageWaitSymbol](tabId: number, options?: OpenBrowserUsePageWaitOptions): Promise<OpenBrowserUsePageWait>;
    [downloadWaitSymbol](tabId: number, options?: OpenBrowserUseDownloadWaitOptions): Promise<OpenBrowserUseDownloadWait>;
    [fileChooserWaitSymbol](tabId: number, options?: OpenBrowserUseFileChooserWaitOptions): Promise<OpenBrowserUseFileChooserWait>;
    getControlState(): Promise<JsonValue>;
    beginTurn(turnId?: string): Promise<OpenBrowserUseControlState | null>;
    refreshControlState(): Promise<OpenBrowserUseControlState | null>;
    [controlScopeSymbol](timeoutMs: number): ControlScope;
    getInfo(): Promise<JsonValue>;
    browserAction(tabId: number, action: string, options?: {
        locator?: readonly OpenBrowserUseLocatorStep[];
        args?: BrowserUseRequestParams;
        timeoutMs?: number;
    }): Promise<OpenBrowserUseActionResult>;
    createTab(options?: OpenBrowserUseCreateTabOptions): Promise<JsonValue>;
    getTabs(): Promise<JsonValue>;
    getUserTabs(): Promise<JsonValue>;
    getUserHistory(params?: BrowserUseRequestParams): Promise<JsonValue>;
    claimUserTab(tabId: number): Promise<JsonValue>;
    finalizeTabs(keep: JsonValue[]): Promise<JsonValue>;
    nameSession(name: string): Promise<JsonValue>;
    attach(tabId: number): Promise<JsonValue>;
    detach(tabId: number): Promise<JsonValue>;
    executeCdp(tabId: number, method: string, commandParams?: BrowserUseRequestParams): Promise<JsonValue>;
    moveMouse(tabId: number, x: number, y: number, waitForArrival?: boolean): Promise<JsonValue>;
    waitForFileChooser(tabId: number, timeoutMs?: number): Promise<JsonValue>;
    setFileChooserFiles(fileChooserId: string, files: string[], timeoutMs?: number): Promise<JsonValue>;
    waitForDownload(tabId: number, timeoutMs?: number): Promise<JsonValue>;
    downloadPath(downloadId: string, timeoutMs?: number): Promise<JsonValue>;
    browserUserHistory(params?: BrowserUseRequestParams): Promise<JsonValue>;
    readClipboardText(tabId: number, options?: OpenBrowserUseClipboardOptions): Promise<JsonValue>;
    writeClipboardText(tabId: number, text: string, options?: OpenBrowserUseClipboardOptions): Promise<JsonValue>;
    readClipboard(tabId: number, options?: OpenBrowserUseClipboardOptions): Promise<JsonValue>;
    writeClipboard(tabId: number, items: JsonValue[], options?: OpenBrowserUseClipboardOptions): Promise<JsonValue>;
    turnEnded(): Promise<JsonValue>;
}
export declare function connectOpenBrowserUse(options: OpenBrowserUseBrowserOptions): Promise<OpenBrowserUseBrowser>;
export declare class OpenBrowserUseBrowser {
    readonly client: OpenBrowserUseClient;
    readonly cdp: OpenBrowserUseCdp;
    constructor(options: OpenBrowserUseBrowserOptions);
    connect(): Promise<this>;
    close(): void;
    newTab(options?: OpenBrowserUseGotoOptions & OpenBrowserUseCreateTabOptions & {
        url?: string;
    }): Promise<OpenBrowserUseTab>;
    tab(tabId: number): OpenBrowserUseTab;
    getTabs(): Promise<JsonValue>;
}
export declare class OpenBrowserUseTab {
    get clipboard(): OpenBrowserUseClipboard;
    readonly browser: OpenBrowserUseBrowser;
    readonly id: number;
    readonly playwright: OpenBrowserUseTabPlaywright;
    readonly mouse: OpenBrowserUseMouse;
    readonly keyboard: OpenBrowserUseKeyboard;
    constructor(browser: OpenBrowserUseBrowser, id: number);
    action(action: string, args?: BrowserUseRequestParams, options?: {
        timeoutMs?: number;
    }): Promise<JsonValue>;
    engineInfo(): Promise<OpenBrowserUseEngineInfo>;
    downloadURL(url: string, options?: OpenBrowserUseDownloadURLOptions): Promise<OpenBrowserUseDownload>;
    exportPage(format: OpenBrowserUseExportFormat, options?: OpenBrowserUseExportOptions): Promise<OpenBrowserUsePageExport>;
    exportPDF(options?: OpenBrowserUseExportOptions): Promise<OpenBrowserUsePageExport>;
    exportMHTML(options?: OpenBrowserUseExportOptions): Promise<OpenBrowserUsePageExport>;
    waitForDownload(options?: OpenBrowserUseDownloadOptions): Promise<OpenBrowserUseDownload>;
    expectPage(options?: OpenBrowserUsePageWaitOptions): Promise<OpenBrowserUsePageWait>;
    expectDownload(options?: OpenBrowserUseDownloadWaitOptions): Promise<OpenBrowserUseDownloadWait>;
    expectFileChooser(options?: OpenBrowserUseFileChooserWaitOptions): Promise<OpenBrowserUseFileChooserWait>;
    expectRequest(match: OpenBrowserUseNetworkWaitMatch, options?: OpenBrowserUseNetworkWaitOptions): Promise<OpenBrowserUseNetworkWait>;
    expectResponse(match: OpenBrowserUseNetworkWaitMatch, options?: OpenBrowserUseNetworkWaitOptions): Promise<OpenBrowserUseNetworkWait>;
    expectURL(url: string, options?: OpenBrowserUseURLWaitOptions): Promise<OpenBrowserUseNavigationWait>;
    expectLoadState(options?: OpenBrowserUseLoadStateWaitOptions): Promise<OpenBrowserUseNavigationWait>;
    goto(url: string, options?: OpenBrowserUseGotoOptions): Promise<JsonValue>;
    goBack(options?: OpenBrowserUseGotoOptions): Promise<JsonValue>;
    goForward(options?: OpenBrowserUseGotoOptions): Promise<JsonValue>;
    reload(options?: OpenBrowserUseGotoOptions): Promise<JsonValue>;
    waitForLoadState(options?: OpenBrowserUseWaitForLoadStateOptions): Promise<void>;
    waitForURL(url: string, options?: OpenBrowserUseActionOptions): Promise<void>;
    domSnapshot(options?: OpenBrowserUseActionOptions): Promise<string>;
    snapshotAI(options?: OpenBrowserUseAISnapshotOptions): Promise<OpenBrowserUseAISnapshot>;
    screenshot(options?: OpenBrowserUseActionOptions): Promise<OpenBrowserUseScreenshot>;
    diagnostics(options?: OpenBrowserUseDiagnosticsOptions): Promise<OpenBrowserUseDiagnosticsSnapshot>;
    locator(selector: string): OpenBrowserUseLocator;
    getByRef(captureId: string, ref: string): OpenBrowserUseLocator;
    frameLocator(selector: string): OpenBrowserUseLocator;
    getByRole(role: string, options?: {
        name?: string;
        exact?: boolean;
    }): OpenBrowserUseLocator;
    getByText(value: string, options?: {
        exact?: boolean;
    }): OpenBrowserUseLocator;
    getByLabel(value: string, options?: {
        exact?: boolean;
    }): OpenBrowserUseLocator;
    getByPlaceholder(value: string, options?: {
        exact?: boolean;
    }): OpenBrowserUseLocator;
    getByAltText(value: string, options?: {
        exact?: boolean;
    }): OpenBrowserUseLocator;
    getByTitle(value: string, options?: {
        exact?: boolean;
    }): OpenBrowserUseLocator;
    getByTestId(value: string): OpenBrowserUseLocator;
    evaluate(expression: string, options?: {
        awaitPromise?: boolean;
    }): Promise<JsonValue>;
    close(): Promise<JsonValue>;
}
export declare class OpenBrowserUseLocator {
    #private;
    readonly tab: OpenBrowserUseTab;
    readonly steps: readonly OpenBrowserUseLocatorStep[];
    constructor(tab: OpenBrowserUseTab, steps?: readonly OpenBrowserUseLocatorStep[]);
    getByRef(captureId: string, ref: string): OpenBrowserUseLocator;
    locator(selector: string): OpenBrowserUseLocator;
    frameLocator(selector: string): OpenBrowserUseLocator;
    getByRole(role: string, options?: {
        name?: string;
        exact?: boolean;
    }): OpenBrowserUseLocator;
    getByText(value: string, options?: {
        exact?: boolean;
    }): OpenBrowserUseLocator;
    getByLabel(value: string, options?: {
        exact?: boolean;
    }): OpenBrowserUseLocator;
    getByPlaceholder(value: string, options?: {
        exact?: boolean;
    }): OpenBrowserUseLocator;
    getByAltText(value: string, options?: {
        exact?: boolean;
    }): OpenBrowserUseLocator;
    getByTitle(value: string, options?: {
        exact?: boolean;
    }): OpenBrowserUseLocator;
    getByTestId(value: string): OpenBrowserUseLocator;
    first(): OpenBrowserUseLocator;
    last(): OpenBrowserUseLocator;
    nth(index: number): OpenBrowserUseLocator;
    filter(options: OpenBrowserUseFilterOptions): OpenBrowserUseLocator;
    and(other: OpenBrowserUseLocator): OpenBrowserUseLocator;
    or(other: OpenBrowserUseLocator): OpenBrowserUseLocator;
    downloadMedia(options?: OpenBrowserUseMediaDownloadOptions): Promise<OpenBrowserUseDownload>;
    click(options?: OpenBrowserUseActionOptions): Promise<void>;
    dblclick(options?: OpenBrowserUseActionOptions): Promise<void>;
    hover(options?: OpenBrowserUseActionOptions): Promise<void>;
    focus(options?: OpenBrowserUseActionOptions): Promise<void>;
    scrollIntoViewIfNeeded(options?: OpenBrowserUseActionOptions): Promise<void>;
    pressSequentially(text: string, options?: OpenBrowserUseActionOptions): Promise<void>;
    dragTo(target: OpenBrowserUseLocator, options?: OpenBrowserUseActionOptions): Promise<void>;
    setInputFiles(files: string[], options?: {
        timeoutMs?: number;
    }): Promise<void>;
    fill(value: string, options?: OpenBrowserUseActionOptions): Promise<void>;
    press(key: string, options?: OpenBrowserUseActionOptions): Promise<void>;
    check(options?: OpenBrowserUseActionOptions): Promise<void>;
    uncheck(options?: OpenBrowserUseActionOptions): Promise<void>;
    setChecked(checked: boolean, options?: OpenBrowserUseActionOptions): Promise<void>;
    selectOption(values: JsonValue, options?: OpenBrowserUseActionOptions): Promise<string[]>;
    waitFor(options?: OpenBrowserUseActionOptions): Promise<void>;
    count(): Promise<number>;
    innerText(options?: OpenBrowserUseActionOptions): Promise<string>;
    textContent(options?: OpenBrowserUseActionOptions): Promise<string | null>;
    inputValue(options?: OpenBrowserUseActionOptions): Promise<string>;
    getAttribute(name: string, options?: OpenBrowserUseActionOptions): Promise<string | null>;
    isVisible(): Promise<boolean>;
    isEnabled(): Promise<boolean>;
    isChecked(): Promise<boolean>;
    boundingBox(options?: OpenBrowserUseActionOptions): Promise<{
        x: number;
        y: number;
        width: number;
        height: number;
    } | null>;
    allTextContents(): Promise<string[]>;
    allInnerTexts(): Promise<string[]>;
    ariaSnapshot(options?: OpenBrowserUseActionOptions): Promise<string>;
    screenshot(options?: OpenBrowserUseActionOptions): Promise<OpenBrowserUseScreenshot>;
}
export declare class OpenBrowserUseTabPlaywright extends OpenBrowserUseLocator {
    expectRequest(match: OpenBrowserUseNetworkWaitMatch, options?: OpenBrowserUseNetworkWaitOptions): Promise<OpenBrowserUseNetworkWait>;
    expectPage(options?: OpenBrowserUsePageWaitOptions): Promise<OpenBrowserUsePageWait>;
    expectDownload(options?: OpenBrowserUseDownloadWaitOptions): Promise<OpenBrowserUseDownloadWait>;
    expectFileChooser(options?: OpenBrowserUseFileChooserWaitOptions): Promise<OpenBrowserUseFileChooserWait>;
    expectResponse(match: OpenBrowserUseNetworkWaitMatch, options?: OpenBrowserUseNetworkWaitOptions): Promise<OpenBrowserUseNetworkWait>;
    snapshotAI(options?: OpenBrowserUseAISnapshotOptions): Promise<OpenBrowserUseAISnapshot>;
    goBack(options?: OpenBrowserUseGotoOptions): Promise<JsonValue>;
    goForward(options?: OpenBrowserUseGotoOptions): Promise<JsonValue>;
    reload(options?: OpenBrowserUseGotoOptions): Promise<JsonValue>;
    waitForLoadState(options?: OpenBrowserUseWaitForLoadStateOptions): Promise<void>;
    expectURL(url: string, options?: OpenBrowserUseURLWaitOptions): Promise<OpenBrowserUseNavigationWait>;
    expectLoadState(options?: OpenBrowserUseLoadStateWaitOptions): Promise<OpenBrowserUseNavigationWait>;
    waitForURL(url: string, options?: OpenBrowserUseActionOptions): Promise<void>;
    domSnapshot(options?: OpenBrowserUseActionOptions): Promise<string>;
    engineInfo(): Promise<OpenBrowserUseEngineInfo>;
}
export declare class OpenBrowserUseMouse {
    readonly tab: OpenBrowserUseTab;
    constructor(tab: OpenBrowserUseTab);
    move(x: number, y: number, options?: OpenBrowserUseActionOptions): Promise<void>;
    click(x: number, y: number, options?: OpenBrowserUseActionOptions): Promise<void>;
    down(options?: OpenBrowserUseActionOptions): Promise<void>;
    up(options?: OpenBrowserUseActionOptions): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
}
export declare class OpenBrowserUseKeyboard {
    readonly tab: OpenBrowserUseTab;
    constructor(tab: OpenBrowserUseTab);
    press(key: string, options?: OpenBrowserUseActionOptions): Promise<void>;
    type(text: string, options?: OpenBrowserUseActionOptions): Promise<void>;
    insertText(text: string): Promise<void>;
}
export declare class OpenBrowserUseCdp {
    #private;
    readonly client: OpenBrowserUseClient;
    constructor(client: OpenBrowserUseClient);
    call(tabId: number, method: string, commandParams?: BrowserUseRequestParams, options?: {
        timeoutMs?: number;
    }): Promise<JsonValue>;
    evaluate(tabId: number, expression: string, options?: {
        awaitPromise?: boolean;
    }): Promise<JsonValue>;
    navigate(tabId: number, url: string, options?: OpenBrowserUseGotoOptions): Promise<JsonValue>;
    waitForLoadState(tabId: number, options?: OpenBrowserUseWaitForLoadStateOptions): Promise<void>;
    readDocumentState(tabId: number): Promise<{
        href?: string;
        readyState?: string;
    } | undefined>;
    waitForEvent(tabId: number, predicate: (notification: OpenBrowserUseNotification) => boolean, options?: {
        timeoutMs?: number;
        timeoutMessage?: string;
    }): Promise<OpenBrowserUseNotification>;
    waitForLoadEvent(tabId: number, state: OpenBrowserUseLoadState, timeoutMs: number): Promise<void>;
    ensureAttached(tabId: number): Promise<void>;
}
export declare function encodeFrame(value: JsonValue | Record<string, unknown>): Buffer;
export type OpenBrowserUseCreateTabOptions = {
    backgroundWindow?: boolean;
};
