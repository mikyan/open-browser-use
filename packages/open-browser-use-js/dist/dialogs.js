import { pageWaitTimeout, assertPageWaitDeadline } from "./page-waits.js";
export const dialogMethods = new Set(["armDialog", "collectDialog", "cancelDialog"]);
const types = new Set(["alert", "confirm", "prompt", "beforeunload"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, limit = 8192, empty = true) => typeof value === "string" && (empty || value.length > 0) && !/[\uD800-\uDFFF]/u.test(value) && Buffer.byteLength(value, "utf8") <= limit;
export const dialogTimeout = pageWaitTimeout;
export function dialogDecision(value) {
    if (!object(value) || Object.keys(value).some(key => !["type", "accept", "message", "promptText"].includes(key)) || !types.has(value.type) || typeof value.accept !== "boolean" ||
        Object.hasOwn(value, "message") && !text(value.message) || Object.hasOwn(value, "promptText") && (!text(value.promptText) || value.type !== "prompt" || value.accept !== true))
        throw new Error("Invalid native dialog decision");
}
export function dialogParams(method, params) {
    const arm = method === "armDialog", allowed = ["session_id", "turn_id", "control_epoch", "tabId", ...(arm ? ["type", "accept", "message", "promptText", "timeoutMs"] : ["dialogId"])];
    if (!dialogMethods.has(method) || !object(params) || Object.keys(params).some(key => !allowed.includes(key)) || !Number.isSafeInteger(params.tabId) || params.tabId < 0)
        throw new Error("Invalid native dialog parameters");
    for (const key of ["session_id", "turn_id"])
        if (Object.hasOwn(params, key) && !text(params[key], 4096, false))
            throw new Error("Invalid native dialog scope");
    if (Object.hasOwn(params, "control_epoch") && (!Number.isSafeInteger(params.control_epoch) || params.control_epoch < 1))
        throw new Error("Invalid native dialog scope");
    if (arm) {
        const decision = Object.fromEntries(Object.entries(params).filter(([key]) => ["type", "accept", "message", "promptText"].includes(key)));
        dialogDecision(decision);
        dialogTimeout({ timeoutMs: params.timeoutMs });
    }
    else if (!text(params.dialogId, 128, false))
        throw new Error("Invalid native dialog ID");
}
export function dialogAck(value, timeout) {
    if (!object(value) || Object.keys(value).length !== 2 || !text(value.dialogId, 128, false) || typeof value.remainingMs !== "number" || !Number.isFinite(value.remainingMs) || value.remainingMs <= 0 || value.remainingMs > timeout)
        throw new Error("Invalid native dialog ready acknowledgement");
    return { dialogId: value.dialogId, remainingMs: value.remainingMs };
}
export function dialogResult(value) {
    if (!object(value) || Object.keys(value).some(key => !["type", "message", "defaultValue", "accepted", "promptText"].includes(key)) || !types.has(value.type) || !text(value.message) || !text(value.defaultValue) || typeof value.accepted !== "boolean" ||
        (value.type === "prompt" && value.accepted ? !text(value.promptText) : Object.hasOwn(value, "promptText")))
        throw new Error("Invalid native dialog result");
    return value;
}
export function dialogCancelled(value) {
    if (!object(value) || Object.keys(value).length)
        throw new Error("Invalid native dialog cancellation acknowledgement");
}
/** One original decision; cancellation cannot undo an already submitted native response. */
export class OpenBrowserUseDialogWait {
    deadline;
    call;
    decision;
    dialogId;
    remainingMs;
    #collecting = false;
    #finished = false;
    constructor(ack, deadline, call, decision) {
        this.deadline = deadline;
        this.call = call;
        this.decision = decision;
        this.dialogId = ack.dialogId;
        this.remainingMs = ack.remainingMs;
    }
    async result() {
        if (this.#collecting)
            throw new Error("OBU_DIALOG_BUSY: result is already pending");
        if (this.#finished)
            throw new Error("OBU_DIALOG_EXPIRED: decision has already been consumed or cancelled");
        this.#collecting = true;
        try {
            const result = dialogResult(await this.call("collectDialog", assertPageWaitDeadline(this.deadline), this.deadline));
            if (result.type !== this.decision.type || result.accepted !== this.decision.accept ||
                this.decision.message !== undefined && result.message !== this.decision.message ||
                result.type === "prompt" && result.accepted && result.promptText !== (this.decision.promptText ?? ""))
                throw new Error("Native dialog result differs from original decision");
            assertPageWaitDeadline(this.deadline);
            this.#finished = true;
            return result;
        }
        finally {
            this.#collecting = false;
        }
    }
    async cancel() { dialogCancelled(await this.call("cancelDialog", 10000)); this.#finished = true; }
}
