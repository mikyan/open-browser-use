import { OpenBrowserUseDownload } from "./downloads.js";
import type { JsonValue } from "./index.js";
export type OpenBrowserUseDownloadWaitOptions = {
    timeoutMs?: number;
    requirePath?: boolean;
};
export declare const downloadWaitMethods: Set<string>;
export declare function downloadWaitTimeout(options?: OpenBrowserUseDownloadWaitOptions): number;
export declare function downloadWaitParams(method: string, params: Record<string, unknown>): void;
export declare function downloadWaitAck(value: unknown, timeout: number): {
    waiterId: string;
    remainingMs: number;
};
export declare function downloadWaitCancelled(value: unknown): void;
export declare function assertDownloadWaitDeadline(deadline: number): number;
/** Observes one page download. Cancelling this wait does not cancel a transfer. */
export declare class OpenBrowserUseDownloadWait {
    #private;
    private readonly deadline;
    private readonly call;
    private readonly download;
    readonly waiterId: string;
    readonly remainingMs: number;
    constructor(ack: {
        waiterId: string;
        remainingMs: number;
    }, deadline: number, call: (method: string, timeoutMs: number, startBefore?: number) => Promise<JsonValue>, download: (id: string) => OpenBrowserUseDownload);
    result(): Promise<OpenBrowserUseDownload>;
    cancel(): Promise<void>;
}
