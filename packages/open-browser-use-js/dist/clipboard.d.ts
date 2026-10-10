import type { BrowserUseRequestParams, JsonValue, OpenBrowserUseClient } from "./index.js";
export declare const MAX_CLIPBOARD_BYTES: number;
export declare const clipboardMethods: Set<string>;
export type OpenBrowserUseClipboardOptions = {
    maxBytes?: number;
    timeoutMs?: number;
};
export type OpenBrowserUseClipboardEntry = {
    mime_type: "text/plain" | "text/html";
    text: string;
} | {
    mime_type: "image/png";
    base64: string;
};
export type OpenBrowserUseClipboardItem = {
    entries: OpenBrowserUseClipboardEntry[];
    presentation_style?: "unspecified" | "inline" | "attachment";
};
export declare function validateClipboardItems(value: unknown, maximum: number): OpenBrowserUseClipboardItem[];
export declare function clipboardParams(method: string, tabId: number, payload?: BrowserUseRequestParams, options?: OpenBrowserUseClipboardOptions): BrowserUseRequestParams;
export declare function validateClipboardResult(method: string, value: JsonValue, maximum: number): JsonValue;
export declare class OpenBrowserUseClipboard {
    private readonly client;
    private readonly tabId;
    constructor(client: OpenBrowserUseClient, tabId: number);
    readText(options?: OpenBrowserUseClipboardOptions): Promise<string>;
    writeText(text: string, options?: OpenBrowserUseClipboardOptions): Promise<void>;
    read(options?: OpenBrowserUseClipboardOptions): Promise<OpenBrowserUseClipboardItem[]>;
    write(items: OpenBrowserUseClipboardItem[], options?: OpenBrowserUseClipboardOptions): Promise<void>;
}
