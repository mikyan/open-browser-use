// Acceptance-only provenance gate. This does not alter, fetch or replay any
// request. The caller reads bounded, fully flushed JSON after Browser.close.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const revision = "f842f52ef39fd97b449eb27cff414bf05a98ddce";
// The annotation identifies Chromium's download_manager_resume call site at
// this pinned revision. It alone proves neither automatic retry nor a GUID:
// the exact Referer, request lifecycle, original Page/Browser GUID and server
// receipt are all required below. No filename or download path is inferred.
// Pinned source: components/download/internal/common/download_item_impl.cc
// (download_manager_resume), net/traffic_annotation/network_traffic_annotation.h
// (hash: (ret*31+c)%138003713), and net/log/net_log_util.cc (millisecond offset).
// https://github.com/chromium/chromium/tree/f842f52ef39fd97b449eb27cff414bf05a98ddce
const resumeAnnotation = 35380758;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function requireProof(condition, message) { assert.ok(condition, `OBU_NEGATIVE_NETLOG: ${message}`); }
function one(rows, message) { requireProof(rows.length === 1, `${message}: expected exactly one, got ${rows.length}`); return rows[0]; }
function integer(value, label) {
  requireProof(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, `${label} must be a nonnegative safe integer`);
  return value;
}
function decimal(value, label) {
  requireProof(typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value), `${label} must be an exact integer string`);
  return integer(Number(value), label);
}
function headerMap(lines, label) {
  requireProof(Array.isArray(lines) && lines.length <= 100, `${label} header array is missing or oversized`);
  const result = new Map();
  for (const line of lines) {
    requireProof(typeof line === "string" && line.length <= 16384 && !/[\r\n]/.test(line), `${label} invalid header`);
    const match = /^([^:\s]+):\s*(.*)$/.exec(line);
    requireProof(match, `${label} malformed header`);
    const name = match[1].toLowerCase();
    requireProof(!result.has(name), `${label} duplicate header ${name}`);
    result.set(name, match[2]);
  }
  return result;
}
function rawMessage(row) {
  requireProof(object(row) && typeof row.bodyBase64 === "string" && row.bodyBase64.length <= 65536, "missing or oversized original Browser message");
  const raw = Buffer.from(row.bodyBase64, "base64");
  requireProof(raw.toString("base64") === row.bodyBase64 && raw.length === row.bytes && digest(raw) === row.sha256, "original Browser message bytes/hash mismatch");
  assert.deepEqual(JSON.parse(raw.toString("utf8")), row.json, "Original Browser JSON must match raw message");
  return row.json;
}

export function assertOriginalNegativeNetlog({ netlog, detail, browserClose } = {}) {
  requireProof(object(netlog) && object(netlog.constants) && Array.isArray(netlog.events) && netlog.events.length > 0 && netlog.events.length <= 100000 && Array.isArray(netlog.polledData), "missing, incomplete or oversized NetLog document");
  requireProof(object(browserClose) && browserClose.closeObserved === true && browserClose.code === 0 && browserClose.signal === null && object(browserClose.closeResponse) && Object.keys(browserClose.closeResponse).length === 0, "Browser.close ACK and actual child close code 0 are required");
  const closeAt = integer(browserClose.closedAt, "browser closedAt"), closeRequestedAt = integer(browserClose.closeRequestedAt, "browser closeRequestedAt");
  requireProof(closeRequestedAt <= closeAt, "browser close timestamps are reversed");
  const constants = netlog.constants;
  requireProof(constants.logFormatVersion === 1 && constants.clientInfo?.cl?.split("-")[0] === revision, "unknown Chromium revision or NetLog format; annotation mapping must be revalidated");
  const offset = typeof constants.timeTickOffset === "number" ? integer(constants.timeTickOffset, "timeTickOffset") : decimal(constants.timeTickOffset, "timeTickOffset");
  const types = constants.logEventTypes, phases = constants.logEventPhase;
  requireProof(object(types) && object(phases) && object(constants.logSourceType), "NetLog constant maps are missing");
  const needed = ["REQUEST_ALIVE", "URL_REQUEST_START_JOB", "HTTP_TRANSACTION_SEND_REQUEST_HEADERS", "HTTP_TRANSACTION_READ_RESPONSE_HEADERS"];
  for (const name of needed) integer(types[name], name);
  requireProof(new Set(needed.map(name => types[name])).size === needed.length, "event type constants collide");
  const begin = integer(phases.PHASE_BEGIN, "PHASE_BEGIN"), end = integer(phases.PHASE_END, "PHASE_END"), none = integer(phases.PHASE_NONE, "PHASE_NONE");
  requireProof(new Set([begin, end, none]).size === 3, "phase constants collide");
  const urlRequestType = integer(constants.logSourceType.URL_REQUEST, "URL_REQUEST source type");
  const typeNames = new Map(Object.entries(types).map(([name, id]) => [id, name]));
  const events = netlog.events.map((event, index) => {
    requireProof(object(event) && object(event.source), `event ${index} missing source`);
    // NetLog also serializes legitimate high-bit source IDs as signed int32.
    requireProof(Number.isSafeInteger(event.source.id), `event ${index} source id must be a safe integer`);
    integer(event.source.type, `event ${index} source type`);
    const wallTime = offset + decimal(event.time, `event ${index} time`);
    requireProof(Number.isSafeInteger(wallTime) && wallTime <= closeAt, `event ${index} outside flushed browser lifetime`);
    return { index, wallTime, event };
  });
  const checks = detail?.checks, server = detail?.server;
  requireProof(object(checks) && Array.isArray(checks.cases) && checks.cases.length === 5 && object(server) && Array.isArray(server.requests) && server.requests.length <= 1000 && Array.isArray(server.controls), "original cases and bounded server ledger are required");
  const labels = ["warm", "held", "unowned", "interrupted", "fresh"];
  const cases = labels.map(label => one(checks.cases.filter(item => item.label === label), `${label} case`));
  requireProof(new Set(cases.map(item => item.guid)).size === 5 && new Set(cases.map(item => item.key)).size === 5, "original cases must have unique GUIDs and keys");
  requireProof(Array.isArray(detail.relays) && detail.relays.length === 2 && detail.relays.every(relay => relay.captureComplete === true && relay.overflow === false && Array.isArray(relay.records) && relay.records.length <= 10000), "complete original Browser relay evidence is required");
  const browserRows = detail.relays.flatMap((relay, relayIndex) => relay.records.map(row => ({ relayIndex, row })));
  const caseProofs = cases.map(item => {
    const { row, relayIndex } = one(browserRows.filter(({ row }) => row.direction === "upstream->downstream" && row.json?.method === "Browser.downloadWillBegin" && row.json.params?.guid === item.guid), `${item.label} original Browser begin`);
    const message = rawMessage(row), pageParams = item.label === "unowned" ? item.pageBegin?.json?.params : item.pageBegin?.params;
    requireProof(object(pageParams) && pageParams.guid === item.guid && pageParams.frameId === message.params.frameId && pageParams.url === message.params.url, `${item.label} original Page/Browser GUID/frame/URL mismatch`);
    const report = new URL(message.params.url);
    requireProof(report.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(report.hostname) && !report.username && !report.password && !report.search && !report.hash && report.pathname === item.record?.reportPath, "exact original loopback report URL is required");
    requireProof(typeof item.record?.urlPath === "string" && item.record.urlPath.startsWith("/") && !item.record.urlPath.startsWith("//"), "exact original fixture page path is required");
    const pageURL = new URL(item.record.urlPath, report.origin).href;
    requireProof(new URL(pageURL).origin === report.origin && new URL(pageURL).searchParams.get("key") === item.key && item.record.key === item.key, `${item.label} fixture page identity mismatch`);
    return { item, reportURL: report.href, pageURL, browserBegin: { relayIndex, ...row } };
  });
  const reportURL = caseProofs[0].reportURL, reportPath = new URL(reportURL).pathname;
  requireProof(caseProofs.every(item => item.reportURL === reportURL), "all five original reports must use the same exact endpoint");
  const starts = events.filter(({ event }) => event.type === types.URL_REQUEST_START_JOB && event.phase === begin && event.params?.url === reportURL);
  requireProof(starts.length === 6 && starts.filter(x => x.event.params.method === "POST").length === 5 && starts.filter(x => x.event.params.method === "GET").length === 1, "NetLog requires five original POSTs and exactly one extra GET");
  requireProof(new Set(starts.map(x => `${x.event.source.type}:${x.event.source.id}`)).size === 6, "request source reused or restarted");
  const receipts = server.requests.filter(row => row.url === reportPath);
  requireProof(receipts.length === 6 && receipts.filter(x => x.method === "POST").length === 5 && receipts.filter(x => x.method === "GET").length === 1, "server requires exactly five POSTs and one GET");
  // Every exact report REQUEST_ALIVE must be represented by one full source;
  // missing START rows cannot hide a second candidate request.
  const aliveBegins = events.filter(({ event }) => event.type === types.REQUEST_ALIVE && event.phase === begin && event.params?.url === reportURL);
  requireProof(aliveBegins.length === 6, "missing or extra report REQUEST_ALIVE");
  const usedCases = new Set(), requestProofs = [];
  for (const start of starts) {
    const source = start.event.source;
    requireProof(source.type === urlRequestType, "report request is not URL_REQUEST source type");
    const rows = events.filter(({ event }) => event.source.type === source.type && event.source.id === source.id);
    requireProof(rows.length <= 256, "request evidence exceeds bounded source-row capacity");
    requireProof(rows.every(row => row.event.source.start_time === source.start_time), "source id reused across lifetimes");
    const select = (type, phase) => rows.filter(({ event }) => event.type === types[type] && event.phase === phase);
    const alive = one(select("REQUEST_ALIVE", begin), "REQUEST_ALIVE begin"), finish = one(select("REQUEST_ALIVE", end), "REQUEST_ALIVE end");
    const job = one(select("URL_REQUEST_START_JOB", begin), "URL_REQUEST_START_JOB begin"), jobEnd = one(select("URL_REQUEST_START_JOB", end), "URL_REQUEST_START_JOB end");
    const headers = one(select("HTTP_TRANSACTION_SEND_REQUEST_HEADERS", none), "original send headers"), response = one(select("HTTP_TRANSACTION_READ_RESPONSE_HEADERS", none), "original response headers");
    requireProof(alive.event.params?.url === reportURL && job.index === start.index && alive.index < start.index && start.index < headers.index && headers.index < response.index && response.index < jobEnd.index && jobEnd.index < finish.index, "request lifecycle rows missing or out of order");
    requireProof([alive, start, headers, response, jobEnd, finish].every((x, i, all) => i === 0 || x.wallTime >= all[i - 1].wallTime), "request lifecycle time moved backwards");
    const requestHeaders = headerMap(headers.event.params?.headers, "request"), responseLines = response.event.params?.headers;
    requireProof(Array.isArray(responseLines) && /^HTTP\/1\.[01] [0-9]{3}(?: |$)/.test(responseLines[0]), "original HTTP status line missing");
    const status = Number(responseLines[0].split(" ")[1]); headerMap(responseLines.slice(1), "response");
    const method = start.event.params.method;
    requireProof(headers.event.params.line === `${method} ${reportPath} HTTP/1.1\r\n`, "exact original request line mismatch");
    const identity = one(caseProofs.filter(item => item.pageURL === requestHeaders.get("referer")), "exact original page Referer");
    let receipt;
    if (method === "POST") {
      requireProof(!usedCases.has(identity.item.key), "a fixture POST was repeated"); usedCases.add(identity.item.key);
      receipt = one(receipts.filter(x => x.method === "POST" && x.fields?.key === identity.item.key), "original POST receipt");
      requireProof(receipt.status === 200 && receipt.once === true && receipt.range === null && receipt.fields.nonce === identity.item.record.nonce && receipt.fields.documentToken === identity.item.page?.documentToken && receipt.fields.trusted === "true" && receipt.fields.buttonCount === "1", "original POST receipt identity or trusted single click mismatch");
      const body = receipt.body, raw = Buffer.from(body?.base64 ?? "", "base64");
      requireProof(body?.truncated === false && raw.length === body.bytes && digest(raw) === body.sha256 && raw.toString("base64") === body.base64, "original POST body is missing or truncated");
      assert.deepEqual(Object.fromEntries(new URLSearchParams(raw.toString())), receipt.fields, "Original POST form fields must match its bytes");
      requireProof(requestHeaders.get("content-type") === "application/x-www-form-urlencoded" && requestHeaders.get("content-length") === String(body.bytes) && typeof start.event.params.upload_id === "string" && start.event.params.upload_id.length > 0 && status === 200, "NetLog original POST upload/header/response mismatch");
    } else {
      receipt = one(receipts.filter(x => x.method === "GET"), "extra GET receipt");
      requireProof(identity.item.label === "interrupted" && alive.event.params?.traffic_annotation === resumeAnnotation, "extra GET is not pinned download_manager_resume for the exact interrupted page");
      requireProof(requestHeaders.get("accept-encoding") === "identity" && !["range", "if-range", "content-type", "content-length", "transfer-encoding"].some(name => requestHeaders.has(name)) && !Object.keys(start.event.params).some(key => /upload|post.?data|body/i.test(key)) && !rows.some(row => /^UPLOAD_/.test(typeNames.get(row.event.type) ?? "")), "resume GET has a range, upload/body or unexpected encoding");
      requireProof(status === 405 && receipt.status === 405 && receipt.range === null && receipt.once === false && receipt.contentType === null && !receipt.fields && !receipt.body && receipt.finished === true && receipt.closed === true && receipt.aborted === false, "extra GET was not the original completed body-free 405 receipt");
      const body = Buffer.from("ORIGINAL_REPORT_REQUIRES_POST\n");
      requireProof(receipt.response?.bytes === body.length && receipt.response.sha256 === digest(body) && receipt.response.base64 === body.toString("base64"), "GET response was replaced or truncated");
    }
    // NetLog offset and millisecond rounding are calibrated against each of the
    // six exact server receipts, rather than merely assuming the offset fits.
    requireProof(integer(receipt.at, "receipt at") >= headers.wallTime - 1 && receipt.at <= response.wallTime + 1, "NetLog wall-clock calibration disagrees with server receipt");
    requestProofs.push({ method, label: identity.item.label, source: structuredClone(source), receiptSequence: receipt.sequence, receiptAt: receipt.at, status, annotation: alive.event.params?.traffic_annotation,
      alive, start, headers, response, jobEnd, end: finish, rows });
  }
  requireProof(usedCases.size === 5, "five distinct original POST cases were not preserved");
  const resume = one(requestProofs.filter(row => row.method === "GET"), "resume proof"), interrupted = caseProofs.find(row => row.item.label === "interrupted");
  const interrupt = one(server.controls.filter(row => row.action === "interrupt" && row.key === interrupted.item.key), "original fixture interrupt");
  const path = one(checks.operations.filter(row => row.label === "interrupted.path"), "original public path operation");
  const progress = browserRows.filter(({ row }) => row.direction === "upstream->downstream" && row.json?.method === "Browser.downloadProgress" && row.json.params?.guid === interrupted.item.guid);
  requireProof(progress.length > 0 && progress.every(({ row }) => rawMessage(row).params.totalBytes === interrupted.item.record.expected.bytes), "original interrupted Browser progress mismatch");
  const canceled = one(progress.filter(({ row }) => row.json.params.state === "canceled"), "original Browser canceled");
  const fourK = progress.find(({ row }) => row.json.params.state === "inProgress" && row.json.params.receivedBytes === 4096);
  requireProof(fourK && interrupted.item.record.prefixBytes === 4096, "original 4096-byte progress missing");
  const zero = progress.find(({ row }) => row.sequence > fourK.row.sequence && row.json.params.state === "inProgress" && row.json.params.receivedBytes === 0);
  requireProof(zero && zero.relayIndex === fourK.relayIndex && zero.relayIndex === canceled.relayIndex && zero.row.sequence < canceled.row.sequence && canceled.row.json.params.receivedBytes === 0 && !progress.some(({ row }) => row.json.params.state === "completed" || row.json.params.filePath), "same original GUID did not progress 4096 to 0 to canceled without filePath");
  requireProof(interrupt.at < resume.start.wallTime && resume.start.wallTime <= resume.headers.wallTime && resume.end.wallTime <= canceled.row.at && resume.receiptAt < canceled.row.at && canceled.row.at < path.started?.at && path.error?.message?.startsWith("OBU_NATIVE_DOWNLOAD_CANCELED:"), "resume GET not strictly between original interrupt and canceled/public-path failure");
  requireProof(!browserRows.some(({ row }) => row.json?.method === "Browser.cancelDownload"), "native cancel command would confound interruption provenance");
  const report = {
    passed: true, gate: "js-original-download-network-provenance", status: "verified", reportURL,
    provenance: { chromiumRevision: revision, trafficAnnotation: resumeAnnotation, annotationName: "download_manager_resume",
      interpretation: "Exact Chromium Download Manager resume request, joined by complete NetLog source, interrupted-page Referer, original Page/Browser GUID and server receipt; annotation alone does not prove automatic retry or GUID." },
    offsetMs: offset, clockBoundary: "Chromium timeTickOffset is an approximate millisecond conversion; each exact request is cross-checked against its server receipt with at most 1 ms rounding tolerance. Browser progress sampling is not ordered against GET by receive time.",
    counts: { originalPOSTs: 5, resumeGETs: 1, reportRequests: 6 }, browserClose: structuredClone(browserClose),
    interrupted: { key: interrupted.item.key, guid: interrupted.item.guid, pageURL: interrupted.pageURL, browserBegin: interrupted.browserBegin,
      interrupt: structuredClone(interrupt), fourK, zero, canceled, publicPathStarted: structuredClone(path.started), publicPathError: structuredClone(path.error) },
    requests: requestProofs,
    boundary: "This explains the one observed 405 GET; it does not make this a zero-GET run, infer a file path, or by itself validate the other negative lifecycle checks."
  };
  const serialized = JSON.stringify(report);
  requireProof(Buffer.byteLength(serialized) <= 2 * 1024 * 1024, "bounded provenance report exceeded 2 MiB");
  return JSON.parse(serialized);
}
