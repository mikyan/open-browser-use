export type OpenBrowserUseNetworkWaitEvent = "request" | "response";
export type OpenBrowserUseNetworkWaitMatch = {
    url: string;
    urlMatch?: "exact" | "contains";
    method?: string;
    status?: number;
};
export type OpenBrowserUseNetworkWaitOptions = {
    timeoutMs?: number;
};
export type OpenBrowserUseNetworkWaitResult = {
    event: OpenBrowserUseNetworkWaitEvent;
    requestId: string;
    url: string;
    method: string;
    resourceType: string;
    frameUrl?: string;
    redirectedFrom?: string;
    status?: number;
    statusText?: string;
    truncated?: boolean;
};
export declare function networkWaitTimeout(options?: OpenBrowserUseNetworkWaitOptions, fallback?: number): number;
export declare function networkWaitMatch(event: OpenBrowserUseNetworkWaitEvent, match: OpenBrowserUseNetworkWaitMatch): OpenBrowserUseNetworkWaitMatch;
export declare function networkWaitAck(value: unknown, timeout: number): {
    waiterId: string;
    remainingMs: number;
};
export declare function networkWaitResult(value: unknown, event: OpenBrowserUseNetworkWaitEvent): OpenBrowserUseNetworkWaitResult;
/** An armed wait. Trigger the page action before calling result(). */
export declare class OpenBrowserUseNetworkWait {
    #private;
    readonly waiterId: string;
    readonly remainingMs: number;
    constructor(ack: {
        waiterId: string;
        remainingMs: number;
    }, event: OpenBrowserUseNetworkWaitEvent, call: (method: string, timeoutMs: number) => Promise<unknown>);
    result(options?: OpenBrowserUseNetworkWaitOptions): Promise<OpenBrowserUseNetworkWaitResult>;
    cancel(options?: OpenBrowserUseNetworkWaitOptions): Promise<void>;
}
