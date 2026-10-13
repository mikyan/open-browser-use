export const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
export const DEFAULT_RESPONSE_BODY_BYTES = 1024 * 1024;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = () => new Error("OBU_RESPONSE_BODY_INVALID: invalid response body reference or options");
const identifier = (value) => typeof value === "string" && value.length > 0 &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) && Buffer.byteLength(value, "utf8") <= 128;
export function responseBodyParams(ref, options = {}) {
    if (!object(ref) || Object.keys(ref).some(key => !["captureId", "requestId"].includes(key)) || !identifier(ref.captureId) || !identifier(ref.requestId) ||
        !object(options) || Object.keys(options).some(key => !["maxBytes", "timeoutMs"].includes(key)))
        throw invalid();
    const maximum = options.maxBytes === undefined ? DEFAULT_RESPONSE_BODY_BYTES : options.maxBytes;
    const timeout = options.timeoutMs === undefined ? 10_000 : options.timeoutMs;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_RESPONSE_BODY_BYTES || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000)
        throw invalid();
    return { args: { captureId: ref.captureId, requestId: ref.requestId, maxBytes: maximum }, timeoutMs: timeout };
}
export function responseBodyRequest(params) {
    if (Object.keys(params).some(key => !["session_id", "turn_id", "control_epoch", "tabId", "action", "args", "timeoutMs"].includes(key)) ||
        !Number.isSafeInteger(params.tabId) || params.tabId < 0 || params.action !== "responseBody" || !object(params.args) ||
        Object.keys(params.args).some(key => !["captureId", "requestId", "maxBytes"].includes(key)))
        throw invalid();
    return responseBodyParams({ captureId: params.args.captureId, requestId: params.args.requestId }, { maxBytes: params.args.maxBytes, timeoutMs: params.timeoutMs });
}
export function validateResponseBody(value, ref, maximum) {
    const fail = () => new Error("OBU_RESPONSE_BODY_FAILED: invalid response body result");
    if (!object(value) || Object.keys(value).length !== 5 || value.captureId !== ref.captureId || value.requestId !== ref.requestId || value.encoding !== "base64" ||
        typeof value.data !== "string" || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > maximum ||
        value.data.length > 4 * Math.ceil(maximum / 3) || value.data.length !== 4 * Math.ceil(value.byteLength / 3))
        throw fail();
    const decoded = Buffer.from(value.data, "base64");
    if (decoded.byteLength !== value.byteLength || decoded.toString("base64") !== value.data)
        throw fail();
    return { captureId: ref.captureId, requestId: ref.requestId, encoding: "base64", data: value.data, byteLength: decoded.byteLength };
}
export function validateResponseBodyEnvelope(result, params) {
    const { args } = responseBodyRequest(params);
    if (!object(result) || !object(result.engine) || result.engine.name !== "playwright-crx" || typeof result.engine.version !== "string" || typeof result.engine.playwrightVersion !== "string")
        throw new Error("OBU_RESPONSE_BODY_FAILED: invalid response body envelope");
    if (!object(result.engine.capabilities) || result.engine.capabilities.responseBody !== 1)
        throw new Error("OBU_RESPONSE_BODY_UNSUPPORTED: extension engine does not advertise responseBody 1");
    validateResponseBody(result.value, { captureId: args.captureId, requestId: args.requestId }, args.maxBytes);
}
