const encoder = new TextEncoder();
export const DEFAULT_RESPONSE_BODY_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;

const error = (code, text) => new Error(`OBU_RESPONSE_BODY_${code}: ${text}`);
function identifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && value.isWellFormed() && encoder.encode(value).byteLength <= 128;
}

export function validateResponseBodyArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => !["captureId", "requestId", "maxBytes"].includes(key)) ||
      !identifier(args.captureId) || !identifier(args.requestId))
    throw error("INVALID", "captureId and requestId must identify an observed response");
  const maxBytes = args.maxBytes === undefined ? DEFAULT_RESPONSE_BODY_BYTES : args.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESPONSE_BODY_BYTES)
    throw error("INVALID", "maxBytes must be an integer from 1 to 8388608");
  return Object.freeze({ captureId: args.captureId, requestId: args.requestId, maxBytes });
}

function encodeBody(result, maxBytes) {
  if (!result || typeof result !== "object" || typeof result.body !== "string" || typeof result.base64Encoded !== "boolean")
    throw error("FAILED", "native response body has an invalid shape");
  if (result.base64Encoded) {
    const data = result.body;
    if (data.length > 4 * Math.ceil(maxBytes / 3)) throw error("TOO_LARGE", "original response exceeds maxBytes");
    // A simple alphabet check avoids recursive-regexp stack limits on 8 MiB.
    if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw error("FAILED", "native response body is not canonical base64");
    let bytes;
    try { bytes = atob(data); } catch { throw error("FAILED", "native response body is not canonical base64"); }
    if (btoa(bytes) !== data) throw error("FAILED", "native response body is not canonical base64");
    if (bytes.length > maxBytes) throw error("TOO_LARGE", "original response exceeds maxBytes");
    return { data, byteLength: bytes.length };
  }
  if (!result.body.isWellFormed()) throw error("FAILED", "native response body contains invalid Unicode");
  if (result.body.length > maxBytes) throw error("TOO_LARGE", "original response exceeds maxBytes");
  const bytes = encoder.encode(result.body);
  if (bytes.byteLength > maxBytes) throw error("TOO_LARGE", "original response exceeds maxBytes");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return { data: btoa(binary), byteLength: bytes.byteLength };
}

// The caller owns actual-operation capacity/drain: readNative.read must return
// its original native promise. Public cancellation never cancels or replaces
// that promise, and cannot cause a second getResponseBody call.
export async function readResponseBody({ reference, readNative, check, checkSync, signal, deadlineAt, maxBytes, now = () => performance.now() }) {
  const args = validateResponseBodyArgs({ captureId: reference?.captureId, requestId: reference?.requestId, maxBytes });
  if (typeof reference.check !== "function" || typeof reference.onInvalidated !== "function" || typeof check !== "function" || typeof checkSync !== "function" ||
      !readNative?.finished || typeof readNative.finished.then !== "function" || typeof readNative.read !== "function" || !Number.isFinite(deadlineAt))
    throw error("INVALID", "response read requires an original reference and deadline");
  let invalid, timer, unsubscribe = () => {};
  let rejectCancellation;
  const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
  // Invalidation may run synchronously while installing its subscription.
  cancellation.catch(() => {});
  const cancel = reason => {
    invalid ??= reason instanceof Error ? reason : error("EXPIRED", "response read was cancelled");
    rejectCancellation(invalid);
  };
  const onAbort = () => cancel(signal.reason);
  const checkpoint = () => {
    if (invalid) throw invalid;
    if (signal?.aborted) { onAbort(); throw invalid; }
    if (now() >= deadlineAt) throw error("TIMEOUT", "original response read deadline expired");
    reference.check();
    checkSync();
  };
  const authorize = async () => { checkpoint(); await check(); checkpoint(); };
  try {
    unsubscribe = reference.onInvalidated(cancel);
    signal?.addEventListener("abort", onAbort, { once: true });
    checkpoint();
    timer = setTimeout(() => cancel(error("TIMEOUT", "original response read deadline expired")), Math.max(0, deadlineAt - now()));
    const operation = (async () => {
      await authorize();
      // Stop the waiting flow as well as its public result. A response such as
      // SSE may never finish; cancellation must not leave a future native read.
      await Promise.race([readNative.finished, cancellation]);
      await authorize();
      const nativeResult = await readNative.read(checkpoint);
      await authorize();
      const body = encodeBody(nativeResult, args.maxBytes);
      checkpoint(); // Decoding/encoding consumes the same caller deadline.
      return { captureId: args.captureId, requestId: args.requestId, encoding: "base64", ...body };
    })();
    return await Promise.race([operation, cancellation]);
  } finally {
    clearTimeout(timer);
    unsubscribe();
    signal?.removeEventListener("abort", onAbort);
  }
}
