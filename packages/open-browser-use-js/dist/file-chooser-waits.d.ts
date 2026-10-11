export type OpenBrowserUseFileChooserWaitOptions = {
    timeoutMs?: number;
};
export type OpenBrowserUseFileChooserWaitResult = {
    fileChooserId: string;
    isMultiple: boolean;
};
export declare const fileChooserWaitMethods: Set<string>;
export declare function fileChooserWaitTimeout(options?: OpenBrowserUseFileChooserWaitOptions): number;
export declare function fileChooserWaitParams(method: string, params: Record<string, unknown>): void;
export declare function fileChooserWaitAck(value: unknown, timeout: number): {
    waiterId: string;
    remainingMs: number;
};
export declare function fileChooserWaitResult(value: unknown): OpenBrowserUseFileChooserWaitResult;
export declare function fileChooserWaitCancelled(value: unknown): void;
export declare function assertFileChooserWaitDeadline(deadline: number): number;
/** Ready before the triggering click. The original wait deadline never renews. */
export declare class OpenBrowserUseFileChooserWait {
    #private;
    readonly waiterId: string;
    readonly remainingMs: number;
    constructor(ack: {
        waiterId: string;
        remainingMs: number;
    }, deadline: number, call: (method: string, timeoutMs: number, startBefore?: number) => Promise<unknown>);
    result(): Promise<OpenBrowserUseFileChooserWaitResult>;
    cancel(): Promise<void>;
}
