import type { JsonValue } from "./index.js";
import { pageWaitTimeout } from "./page-waits.js";
export type OpenBrowserUseDialogType = "alert" | "confirm" | "prompt" | "beforeunload";
export type OpenBrowserUseDialogDecision = {
    type: OpenBrowserUseDialogType;
    accept: boolean;
    message?: string;
    promptText?: string;
};
export type OpenBrowserUseDialogOptions = {
    timeoutMs?: number;
};
export type OpenBrowserUseDialogResult = {
    type: OpenBrowserUseDialogType;
    message: string;
    defaultValue: string;
    accepted: boolean;
    promptText?: string;
};
export declare const dialogMethods: Set<string>;
export declare const dialogTimeout: typeof pageWaitTimeout;
export declare function dialogDecision(value: unknown): asserts value is OpenBrowserUseDialogDecision;
export declare function dialogParams(method: string, params: Record<string, unknown>): void;
export declare function dialogAck(value: unknown, timeout: number): {
    dialogId: string;
    remainingMs: number;
};
export declare function dialogResult(value: unknown): OpenBrowserUseDialogResult;
export declare function dialogCancelled(value: unknown): void;
/** One original decision; cancellation cannot undo an already submitted native response. */
export declare class OpenBrowserUseDialogWait {
    #private;
    private readonly deadline;
    private readonly call;
    private readonly decision;
    readonly dialogId: string;
    readonly remainingMs: number;
    constructor(ack: {
        dialogId: string;
        remainingMs: number;
    }, deadline: number, call: (method: string, timeoutMs: number, deadline?: number) => Promise<JsonValue>, decision: OpenBrowserUseDialogDecision);
    result(): Promise<OpenBrowserUseDialogResult>;
    cancel(): Promise<void>;
}
