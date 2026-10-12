export const pageWaitMethods = new Set(["armPageWait", "collectPageWait", "cancelPageWait"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value) => typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 128;
export function pageWaitTimeout(options = {}) {
    if (!object(options) || Object.keys(options).some(key => key !== "timeoutMs"))
        throw new Error("Page wait options only accept timeoutMs");
    const timeout = options.timeoutMs === undefined ? 10000 : options.timeoutMs;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000)
        throw new Error("Page wait timeoutMs must be an integer from 1 to 120000");
    return timeout;
}
export function pageWaitParams(method, params) {
    const allowed = ["session_id", "turn_id", "control_epoch", "tabId", method === "armPageWait" ? "timeoutMs" : "waiterId"];
    if (!object(params) || Object.keys(params).some(key => !allowed.includes(key)) || !Number.isSafeInteger(params.tabId) || params.tabId < 0 ||
        (method !== "armPageWait" && !identifier(params.waiterId)))
        throw new Error("Invalid page wait parameters");
    for (const key of ["session_id", "turn_id"]) {
        const value = params[key];
        if (Object.hasOwn(params, key) && (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 4096))
            throw new Error("Invalid page wait scope");
    }
    if (Object.hasOwn(params, "control_epoch") && (!Number.isSafeInteger(params.control_epoch) || params.control_epoch < 1))
        throw new Error("Invalid page wait scope");
    if (method === "armPageWait")
        pageWaitTimeout({ timeoutMs: params.timeoutMs });
}
export function pageWaitAck(value, timeout) {
    if (!object(value) || Object.keys(value).length !== 2 || !identifier(value.waiterId) || typeof value.remainingMs !== "number" ||
        !Number.isFinite(value.remainingMs) || value.remainingMs <= 0 || value.remainingMs > timeout)
        throw new Error("Invalid page wait ready acknowledgement");
    return { waiterId: value.waiterId, remainingMs: value.remainingMs };
}
export function pageWaitCancelled(value) {
    if (!object(value) || Object.keys(value).length)
        throw new Error("Invalid page wait cancellation acknowledgement");
}
export function assertPageWaitDeadline(deadline) {
    const remaining = deadline - performance.now();
    if (remaining < 1)
        throw new Error("Open Browser Use page wait timed out; request was not sent");
    return remaining;
}
/** Observes one native child. Cancelling this wait never closes that child. */
export class OpenBrowserUsePageWait {
    deadline;
    call;
    page;
    waiterId;
    remainingMs;
    #collecting = false;
    #finished = false;
    constructor(ack, deadline, call, page) {
        this.deadline = deadline;
        this.call = call;
        this.page = page;
        this.waiterId = ack.waiterId;
        this.remainingMs = ack.remainingMs;
    }
    async result() {
        if (this.#collecting)
            throw new Error("OBU_PAGE_WAIT_CONFLICT: result is already pending");
        if (this.#finished)
            throw new Error("OBU_PAGE_WAIT_INVALID: wait has already been consumed or cancelled");
        this.#collecting = true;
        try {
            const remaining = assertPageWaitDeadline(this.deadline);
            const id = pageWaitResult(await this.call("collectPageWait", remaining, this.deadline));
            assertPageWaitDeadline(this.deadline);
            this.#finished = true;
            return this.page(id);
        }
        finally {
            this.#collecting = false;
        }
    }
    async cancel() {
        // Cleanup remains retryable after expiry, without extending the observation.
        pageWaitCancelled(await this.call("cancelPageWait", 10000));
        this.#finished = true;
    }
}
export function pageWaitResult(value) {
    if (!object(value) || Object.keys(value).length !== 1 || !Number.isSafeInteger(value.tabId) || value.tabId < 0)
        throw new Error("Invalid page wait result");
    return value.tabId;
}
