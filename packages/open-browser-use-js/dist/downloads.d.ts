import type { BrowserUseRequestParams, JsonValue } from "./index.js";
export type OpenBrowserUseDownloadOptions = {
    timeoutMs?: number;
};
export type OpenBrowserUseDownloadURLOptions = OpenBrowserUseDownloadOptions & {
    filename?: string;
};
export type OpenBrowserUseMediaDownloadOptions = OpenBrowserUseDownloadURLOptions;
export declare function downloadTimeout(options?: OpenBrowserUseDownloadOptions): number;
export declare function downloadURLParams(url: string, options?: OpenBrowserUseDownloadURLOptions): BrowserUseRequestParams;
export declare function downloadFileParams(options?: OpenBrowserUseMediaDownloadOptions): BrowserUseRequestParams;
export declare function downloadID(value: JsonValue): string;
/** A download bound to the start request's session, turn and control epoch. */
export declare class OpenBrowserUseDownload {
    readonly downloadId: string;
    private readonly call;
    constructor(downloadId: string, call: (method: string, timeoutMs: number) => Promise<JsonValue>);
    path(options?: OpenBrowserUseDownloadOptions): Promise<string>;
    cancel(options?: OpenBrowserUseDownloadOptions): Promise<void>;
}
