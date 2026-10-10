const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export function navigationWaitParams(event, url, options) {
    const allowed = event === "url" ? ["timeoutMs", "waitUntil"] : ["timeoutMs", "state"];
    if (!object(options) || Object.keys(options).some(key => !allowed.includes(key)))
        throw new Error("Invalid navigation wait options");
    const timeoutMs = navigationWaitTimeout({ timeoutMs: options.timeoutMs });
    if (event === "url") {
        const waitUntil = options.waitUntil === undefined ? "load" : options.waitUntil;
        if (typeof url !== "string" || !url || Buffer.byteLength(url, "utf8") > 4096 || !["load", "domcontentloaded", "networkidle", "commit"].includes(waitUntil))
            throw new Error("Invalid navigation URL or waitUntil");
        return { event, url, waitUntil, timeoutMs };
    }
    const state = options.state === undefined ? "load" : options.state;
    if (!["load", "domcontentloaded", "networkidle"].includes(state))
        throw new Error("Invalid navigation load state");
    return { event, state, timeoutMs };
}
export function navigationWaitTimeout(options = {}, fallback = 10000) {
    if (!object(options) || Object.keys(options).some(key => key !== "timeoutMs"))
        throw new Error("Navigation wait options only accept timeoutMs");
    const timeout = options.timeoutMs === undefined ? fallback : options.timeoutMs;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000)
        throw new Error("Navigation wait timeoutMs must be an integer from 1 to 120000");
    return timeout;
}
export function navigationWaitAck(value, timeout) {
    if (!object(value) || Object.keys(value).length !== 2 || typeof value.waiterId !== "string" || !value.waiterId || Buffer.byteLength(value.waiterId, "utf8") > 128 || typeof value.remainingMs !== "number" || !Number.isFinite(value.remainingMs) || value.remainingMs <= 0 || value.remainingMs > timeout)
        throw new Error("Invalid navigation wait ready acknowledgement");
    return { waiterId: value.waiterId, remainingMs: value.remainingMs };
}
/** A ready navigation observer. Trigger the page action before calling result(). */
export class OpenBrowserUseNavigationWait {
    waiterId;
    remainingMs;
    #call;
    constructor(ack, call) {
        this.waiterId = ack.waiterId;
        this.remainingMs = ack.remainingMs;
        this.#call = call;
    }
    async result(options = {}) {
        this.#empty(await this.#call("collectNavigationWait", navigationWaitTimeout(options, 120000) + 1000));
    }
    async cancel(options = {}) {
        this.#empty(await this.#call("cancelNavigationWait", navigationWaitTimeout(options) + 1000));
    }
    #empty(value) { if (!object(value) || Object.keys(value).length)
        throw new Error("Invalid navigation wait acknowledgement"); }
}
