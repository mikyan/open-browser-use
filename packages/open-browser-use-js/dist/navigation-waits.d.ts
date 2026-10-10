export type OpenBrowserUseNavigationWaitOptions = {
    timeoutMs?: number;
};
export type OpenBrowserUseURLWaitOptions = OpenBrowserUseNavigationWaitOptions & {
    waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
};
export type OpenBrowserUseLoadStateWaitOptions = OpenBrowserUseNavigationWaitOptions & {
    state?: "load" | "domcontentloaded" | "networkidle";
};
export declare function navigationWaitParams(event: "url" | "loadstate", url: string | undefined, options: OpenBrowserUseURLWaitOptions | OpenBrowserUseLoadStateWaitOptions): Record<string, string | number>;
export declare function navigationWaitTimeout(options?: OpenBrowserUseNavigationWaitOptions, fallback?: number): number;
export declare function navigationWaitAck(value: unknown, timeout: number): {
    waiterId: string;
    remainingMs: number;
};
/** A ready navigation observer. Trigger the page action before calling result(). */
export declare class OpenBrowserUseNavigationWait {
    #private;
    readonly waiterId: string;
    readonly remainingMs: number;
    constructor(ack: {
        waiterId: string;
        remainingMs: number;
    }, call: (method: string, timeoutMs: number) => Promise<unknown>);
    result(options?: OpenBrowserUseNavigationWaitOptions): Promise<void>;
    cancel(options?: OpenBrowserUseNavigationWaitOptions): Promise<void>;
}
