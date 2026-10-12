import type { OpenBrowserUseTab } from "./index.js";
import type { JsonValue } from "./index.js";
export type OpenBrowserUsePageWaitOptions = {
    timeoutMs?: number;
};
export declare const pageWaitMethods: Set<string>;
export declare function pageWaitTimeout(options?: OpenBrowserUsePageWaitOptions): number;
export declare function pageWaitParams(method: string, params: Record<string, unknown>): void;
export declare function pageWaitAck(value: unknown, timeout: number): {
    waiterId: string;
    remainingMs: number;
};
export declare function pageWaitCancelled(value: unknown): void;
export declare function assertPageWaitDeadline(deadline: number): number;
/** Observes one native child. Cancelling this wait never closes that child. */
export declare class OpenBrowserUsePageWait {
    #private;
    private readonly deadline;
    private readonly call;
    private readonly page;
    readonly waiterId: string;
    readonly remainingMs: number;
    constructor(ack: {
        waiterId: string;
        remainingMs: number;
    }, deadline: number, call: (method: string, timeoutMs: number, startBefore?: number) => Promise<JsonValue>, page: (id: number) => OpenBrowserUseTab);
    result(): Promise<OpenBrowserUseTab>;
    cancel(): Promise<void>;
}
export declare function pageWaitResult(value: unknown): number;
