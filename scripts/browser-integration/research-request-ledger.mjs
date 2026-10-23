// Metadata only: shared synthetic research traffic, including rejected routes.
// A finished response and a completely received request are separate evidence.
export function createResearchRequestLedger({ maxRequests = 4096, maxURLBytes = 16384 } = {}) {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 4096 ||
      !Number.isSafeInteger(maxURLBytes) || maxURLBytes < 1 || maxURLBytes > 16384)
    throw Error("Invalid research request ledger limits");
  const requests = [], pending = new Set(), failures = [];
  let received = 0, overflow = 0, sealing = false;
  const now = () => new Date().toISOString();
  const fail = message => { if (!failures.includes(message) && failures.length < 8) failures.push(message); };

  function observe(request, response) {
    if (sealing) throw Error("Research request ledger is already sealing");
    const sequence = ++received;
    if (requests.length === maxRequests) { overflow++; fail("Research request ledger overflow"); return; }
    const urlBytes = Buffer.from(request.url ?? ""), method = String(request.method ?? "");
    const truncated = urlBytes.length > maxURLBytes || method.length > 64;
    if (truncated) fail("Research request metadata exceeds ledger limits");
    const row = { sequence, receivedAt: now(), method: method.slice(0, 64),
      url: urlBytes.subarray(0, maxURLBytes).toString(), ...(truncated ? { metadataTruncated: true } : {}),
      status: null, requestComplete: request.complete === true, requestAbortedAt: null,
      responseFinishedAt: null, responseAbortedAt: null };
    requests.push(row);
    let requestDone = row.requestComplete, responseDone = false, resolve;
    const done = new Promise(complete => { resolve = complete; }); pending.add(done);
    function settle() {
      if (request.complete === true) { row.requestComplete = true; requestDone = true; }
      if (requestDone && responseDone) { pending.delete(done); resolve(); }
    }
    function requestEnded(reason) {
      if (request.complete !== true && !row.requestAbortedAt) {
        row.requestAbortedAt = now(); row.requestAbortReason = reason;
      }
      requestDone = true; settle();
    }
    function responseEnded(finished, reason) {
      if (responseDone) return;
      responseDone = true;
      row.status = response.headersSent ? response.statusCode : null;
      if (finished) row.responseFinishedAt = now();
      else { row.responseAbortedAt = now(); row.responseAbortReason = reason; }
      settle();
    }
    request.once("end", () => requestEnded("incomplete-end"));
    request.once("aborted", () => requestEnded("request-aborted"));
    request.once("close", () => requestEnded("request-closed-before-complete"));
    response.once("finish", () => responseEnded(true));
    response.once("close", () => responseEnded(false, "response-closed-before-finish"));
    // Error text, headers and bodies are deliberately not copied to the ledger.
    request.once("error", () => requestEnded("request-error"));
    response.once("error", () => responseEnded(false, "response-error"));
  }

  async function seal({ timeoutMs = 5000 } = {}) {
    if (sealing) throw Error("Research request ledger is already sealing");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
      throw Error("Invalid research request settlement timeout");
    sealing = true;
    let timer;
    try {
      await Promise.race([Promise.all([...pending]), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
    } finally { clearTimeout(timer); }
    if (pending.size) fail("Research request ledger has unsettled messages");
    return structuredClone({ version: 1, sealedAt: now(), complete: failures.length === 0,
      maxRequests, maxURLBytes, received, overflow, pending: pending.size, failures, requests });
  }
  return { observe, seal };
}
