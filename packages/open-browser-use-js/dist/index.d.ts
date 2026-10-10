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
};
export type OpenBrowserUseEngineInfo = {
    name: "playwright-crx";
    version: string;
    playwrightVersion: string;
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
    createTab(): Promise<JsonValue>;
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
    setFileChooserFiles(fileChooserId: string, files: string[]): Promise<JsonValue>;
    waitForDownload(tabId: number, timeoutMs?: number): Promise<JsonValue>;
    downloadPath(downloadId: string, timeoutMs?: number): Promise<JsonValue>;
    browserUserHistory(params?: BrowserUseRequestParams): Promise<JsonValue>;
    readClipboardText(tabId: number): Promise<JsonValue>;
    writeClipboardText(tabId: number, text: string): Promise<JsonValue>;
    readClipboard(tabId: number): Promise<JsonValue>;
    writeClipboard(tabId: number, items: JsonValue[]): Promise<JsonValue>;
    turnEnded(): Promise<JsonValue>;
}
export declare function connectOpenBrowserUse(options: OpenBrowserUseBrowserOptions): Promise<OpenBrowserUseBrowser>;
export declare class OpenBrowserUseBrowser {
    readonly client: OpenBrowserUseClient;
    readonly cdp: OpenBrowserUseCdp;
    constructor(options: OpenBrowserUseBrowserOptions);
    connect(): Promise<this>;
    close(): void;
    newTab(options?: OpenBrowserUseGotoOptions & {
        url?: string;
    }): Promise<OpenBrowserUseTab>;
    tab(tabId: number): OpenBrowserUseTab;
    getTabs(): Promise<JsonValue>;
}
export declare class OpenBrowserUseTab {
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
    goto(url: string, options?: OpenBrowserUseGotoOptions): Promise<JsonValue>;
    goBack(options?: OpenBrowserUseGotoOptions): Promise<JsonValue>;
    goForward(options?: OpenBrowserUseGotoOptions): Promise<JsonValue>;
    reload(options?: OpenBrowserUseGotoOptions): Promise<JsonValue>;
    waitForLoadState(options?: OpenBrowserUseWaitForLoadStateOptions): Promise<void>;
    waitForURL(url: string, options?: OpenBrowserUseActionOptions): Promise<void>;
    domSnapshot(options?: OpenBrowserUseActionOptions): Promise<string>;
    screenshot(options?: OpenBrowserUseActionOptions): Promise<OpenBrowserUseScreenshot>;
    diagnostics(options?: OpenBrowserUseDiagnosticsOptions): Promise<OpenBrowserUseDiagnosticsSnapshot>;
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
    filter(options: {
        hasText?: string;
        hasNotText?: string;
    }): OpenBrowserUseLocator;
    click(options?: OpenBrowserUseActionOptions): Promise<void>;
    dblclick(options?: OpenBrowserUseActionOptions): Promise<void>;
    hover(options?: OpenBrowserUseActionOptions): Promise<void>;
    focus(options?: OpenBrowserUseActionOptions): Promise<void>;
    scrollIntoViewIfNeeded(options?: OpenBrowserUseActionOptions): Promise<void>;
    pressSequentially(text: string, options?: OpenBrowserUseActionOptions): Promise<void>;
    dragTo(target: OpenBrowserUseLocator, options?: OpenBrowserUseActionOptions): Promise<void>;
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
    screenshot(options?: OpenBrowserUseActionOptions): Promise<OpenBrowserUseScreenshot>;
}
export declare class OpenBrowserUseTabPlaywright extends OpenBrowserUseLocator {
    goBack(options?: OpenBrowserUseGotoOptions): Promise<JsonValue>;
    goForward(options?: OpenBrowserUseGotoOptions): Promise<JsonValue>;
    reload(options?: OpenBrowserUseGotoOptions): Promise<JsonValue>;
    waitForLoadState(options?: OpenBrowserUseWaitForLoadStateOptions): Promise<void>;
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
export {};
