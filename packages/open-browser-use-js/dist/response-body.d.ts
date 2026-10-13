import type { BrowserUseRequestParams, JsonValue } from "./index.js";
export type OpenBrowserUseResponseBodyRef = {
    captureId: string;
    requestId: string;
};
export type OpenBrowserUseResponseBodyOptions = {
    maxBytes?: number;
    timeoutMs?: number;
};
export type OpenBrowserUseResponseBody = OpenBrowserUseResponseBodyRef & {
    encoding: "base64";
    data: string;
    byteLength: number;
};
export declare const MAX_RESPONSE_BODY_BYTES: number;
export declare const DEFAULT_RESPONSE_BODY_BYTES: number;
export declare function responseBodyParams(ref: OpenBrowserUseResponseBodyRef, options?: OpenBrowserUseResponseBodyOptions): {
    args: BrowserUseRequestParams;
    timeoutMs: number;
};
export declare function responseBodyRequest(params: BrowserUseRequestParams): ReturnType<typeof responseBodyParams>;
export declare function validateResponseBody(value: unknown, ref: OpenBrowserUseResponseBodyRef, maximum: number): OpenBrowserUseResponseBody;
export declare function validateResponseBodyEnvelope(result: JsonValue, params: BrowserUseRequestParams): void;
