import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertOriginalNegativeNetlog } from "./original-download-negative-netlog.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const reportURL = "http://127.0.0.1:32123/original-negative/report";
function fixture() {
  const input = {
    netlog: { constants: { logFormatVersion: 1, clientInfo: { cl: "f842f52ef39fd97b449eb27cff414bf05a98ddce-refs/branch-heads/test" }, timeTickOffset: 100000,
      logEventTypes: { REQUEST_ALIVE: 1, URL_REQUEST_START_JOB: 2, HTTP_TRANSACTION_SEND_REQUEST_HEADERS: 3, HTTP_TRANSACTION_READ_RESPONSE_HEADERS: 4, UPLOAD_DATA_STREAM_INIT: 5 },
      logEventPhase: { PHASE_BEGIN: 1, PHASE_END: 2, PHASE_NONE: 0 }, logSourceType: { URL_REQUEST: 1 } }, events: [], polledData: [] },
    detail: { checks: { cases: [], operations: [{ label: "interrupted.path", started: { at: 100680 }, error: { message: "OBU_NATIVE_DOWNLOAD_CANCELED: original download was canceled" } }] },
      server: { requests: [], controls: [{ action: "interrupt", key: "key-interrupted", at: 100600 }] },
      relays: [{ captureComplete: true, overflow: false, records: [] }, { captureComplete: true, overflow: false, records: [] }] },
    browserClose: { closeRequestedAt: 100998, closeResponse: {}, closeObserved: true, closedAt: 100999, code: 0, signal: null }
  };
  function browserMessage(relay, message, at) {
    const bytes = Buffer.from(JSON.stringify(message)); const rows = input.detail.relays[relay].records;
    rows.push({ sequence: rows.length, at, direction: "upstream->downstream", bytes: bytes.length, sha256: sha(bytes), bodyBase64: bytes.toString("base64"), json: message });
  }
  function request(id, method, label, at, receipt) {
    const source = { id, type: 1, start_time: String(at) };
    function event(type, phase, delta, params) { input.netlog.events.push({ source: { ...source }, type, phase, time: String(at + delta), ...(params ? { params } : {}) }); }
    const isGET = method === "GET";
    event(1, 1, 0, { url: reportURL, traffic_annotation: isGET ? 35380758 : 63171670 });
    event(2, 1, 0, { url: reportURL, method, ...(!isGET ? { upload_id: String(id * 10) } : {}) });
    event(3, 0, 1, { line: `${method} /original-negative/report HTTP/1.1\r\n`, headers: [
      `Referer: http://127.0.0.1:32123/original-negative/page?key=key-${label}`,
      ...(isGET ? ["Accept-Encoding: identity"] : ["Content-Type: application/x-www-form-urlencoded", `Content-Length: ${receipt.body.bytes}`])
    ] });
    event(4, 0, 2, { headers: [`HTTP/1.1 ${isGET ? "405 Method Not Allowed" : "200 OK"}`, "Cache-Control: no-store"] });
    event(2, 2, 3); event(1, 2, 4);
  }
  for (const [i, label] of ["warm", "held", "unowned", "interrupted", "fresh"].entries()) {
    const at = [100, 200, 300, 500, 800][i], key = `key-${label}`, nonce = `nonce-${label}`, guid = `guid-${label}`, documentToken = `document-${label}`;
    const params = { guid, frameId: `frame-${label}`, url: reportURL, suggestedFilename: "report.bin" };
    const item = { label, guid, key, record: { key, nonce, urlPath: `/original-negative/page?key=${key}`, reportPath: "/original-negative/report", prefixBytes: 4096, expected: { bytes: 16384 } },
      page: { documentToken }, pageBegin: label === "unowned" ? { json: { method: "Page.downloadWillBegin", params } } : { method: "Page.downloadWillBegin", params } };
    input.detail.checks.cases.push(item);
    browserMessage(label === "fresh" ? 1 : 0, { method: "Browser.downloadWillBegin", params }, 100000 + at);
    const fields = { key, nonce, documentToken, trusted: "true", buttonCount: "1" }, raw = Buffer.from(new URLSearchParams(fields).toString());
    const receipt = { sequence: i + 1, at: 100000 + at + 1, url: "/original-negative/report", method: "POST", status: 200, once: true, range: null, fields,
      body: { base64: raw.toString("base64"), bytes: raw.length, sha256: sha(raw), truncated: false } };
    input.detail.server.requests.push(receipt); request(i + 1, "POST", label, at, receipt);
  }
  const raw = Buffer.from("ORIGINAL_REPORT_REQUIRES_POST\n");
  const receipt = { sequence: 6, at: 100622, url: "/original-negative/report", method: "GET", status: 405, once: false, range: null, contentType: null,
    finished: true, closed: true, aborted: false, response: { bytes: raw.length, sha256: sha(raw), base64: raw.toString("base64") } };
  input.detail.server.requests.push(receipt); request(6, "GET", "interrupted", 620, receipt);
  for (const [at, receivedBytes, state] of [[100645, 4096, "inProgress"], [100650, 0, "inProgress"], [100670, 0, "canceled"]])
    browserMessage(0, { method: "Browser.downloadProgress", params: { guid: "guid-interrupted", totalBytes: 16384, receivedBytes, state } }, at);
  // Actual NetLog is globally interleaved; source matching must not depend on
  // adjacent rows or accidentally join equal IDs with a different source type.
  input.netlog.events.push({ source: { id: -2147483646, type: 25, start_time: "1" }, time: "1", type: 9000, phase: 1 });
  input.netlog.events.sort((a, b) => Number(a.time) - Number(b.time));
  return input;
}
const getRows = input => input.netlog.events.filter(row => row.source.id === 6);
const getEvent = (input, type, phase = 0) => getRows(input).find(row => row.type === type && row.phase === phase);

test("complete pinned source joins five POSTs, exact resume Referer and original GUID without inferring a path", () => {
  const input = fixture(), original = structuredClone(input), report = assertOriginalNegativeNetlog(input);
  assert.equal(report.passed, true); assert.deepEqual(report.counts, { originalPOSTs: 5, resumeGETs: 1, reportRequests: 6 });
  const resume = report.requests.find(row => row.method === "GET");
  assert.equal(resume.source.id, 6); assert.equal(resume.annotation, 35380758); assert.equal(resume.start.wallTime, 100620);
  assert.equal(resume.rows.length, 6); assert.deepEqual(resume.rows[0].event, input.netlog.events[resume.rows[0].index]);
  assert.equal(report.interrupted.guid, "guid-interrupted"); assert.equal(report.interrupted.pageURL, "http://127.0.0.1:32123/original-negative/page?key=key-interrupted");
  assert.equal(Object.hasOwn(report.interrupted, "filePath"), false); assert.deepEqual(input, original);
  resume.rows[0].event.params.url = "forged"; assert.deepEqual(input, original);
});

test("annotation hash is independently derived from the pinned name", () => {
  let hash = 0; for (const char of "download_manager_resume") hash = (hash * 31 + char.charCodeAt(0)) % 138003713;
  assert.equal(hash, 35380758);
});

for (const [name, mutate, pattern] of [
  ["missing NetLog", input => { delete input.netlog.events; }, /incomplete/],
  ["missing final REQUEST_ALIVE end", input => { input.netlog.events = input.netlog.events.filter(row => !(row.source.id === 6 && row.type === 1 && row.phase === 2)); }, /REQUEST_ALIVE end/],
  ["missing Browser.close ACK", input => { delete input.browserClose.closeResponse; }, /Browser.close ACK/],
  ["browser nonzero close", input => { input.browserClose.code = 1; }, /Browser.close ACK/],
  ["different Chromium revision", input => { input.netlog.constants.clientInfo.cl = "unknown"; }, /unknown Chromium/],
  ["unknown annotation", input => { getEvent(input, 1, 1).params.traffic_annotation++; }, /download_manager_resume/],
  ["forged interrupted Referer", input => { getEvent(input, 3).params.headers[0] = "Referer: http://127.0.0.1:32123/original-negative/page?key=key-warm"; }, /download_manager_resume/],
  ["GET Range", input => { getEvent(input, 3).params.headers.push("Range: bytes=4096-"); }, /range, upload\/body/],
  ["GET upload id", input => { getEvent(input, 2, 1).params.upload_id = "9"; }, /range, upload\/body/],
  ["GET body metadata", input => { getEvent(input, 2, 1).params.post_data = "body"; }, /range, upload\/body/],
  ["GET upload event", input => { const row = structuredClone(getEvent(input, 2, 1)); row.type = 5; input.netlog.events.push(row); }, /range, upload\/body/],
  ["GET gzip encoding", input => { getEvent(input, 3).params.headers[1] = "Accept-Encoding: gzip"; }, /range, upload\/body/],
  ["GET 2xx substitution", input => { getEvent(input, 4).params.headers[0] = "HTTP/1.1 200 OK"; }, /405/],
  ["GET replaced body", input => { input.detail.server.requests.at(-1).response.base64 = Buffer.from("replacement").toString("base64"); }, /replaced or truncated/],
  ["server second GET", input => { input.detail.server.requests.push(structuredClone(input.detail.server.requests.at(-1))); }, /server requires/],
  ["NetLog second GET", input => { const rows = structuredClone(getRows(input)); for (const row of rows) row.source.id = 7; input.netlog.events.push(...rows); }, /NetLog requires/],
  ["same id different source type", input => { getEvent(input, 3).source.type = 2; }, /send headers/],
  ["reused source lifetime", input => { getEvent(input, 3).source.start_time = "1"; }, /source id reused/],
  ["GET before interrupt", input => { input.detail.server.controls[0].at = 100625; }, /strictly between/],
  ["GET after public path", input => { input.detail.checks.operations[0].started.at = 100620; }, /strictly between/],
  ["wrong wall-clock offset", input => { input.netlog.constants.timeTickOffset = "99990"; }, /calibration/],
  ["POST reused fixture identity", input => { input.netlog.events.find(row => row.source.id === 2 && row.type === 3).params.headers[0] = "Referer: http://127.0.0.1:32123/original-negative/page?key=key-warm"; }, /POST was repeated/],
  ["truncated original POST body", input => { input.detail.server.requests[0].body.truncated = true; }, /body is missing or truncated/],
  ["wrong POST nonce", input => { input.detail.server.requests[0].fields.nonce = "forged"; }, /identity or trusted/],
  ["missing same-GUID cancellation", input => { input.detail.relays[0].records.pop(); }, /Browser canceled/],
  ["raw GUID evidence tampering", input => { input.detail.relays[0].records.at(-1).json.params.guid = "other"; }, /Browser canceled/],
  ["raw Browser byte tampering", input => { input.detail.relays[0].records[0].sha256 = "0".repeat(64); }, /bytes\/hash mismatch/],
  ["native cancel confound", input => { input.detail.relays[1].records.push({ json: { method: "Browser.cancelDownload" } }); }, /cancel command/],
  ["NetLog source-row overflow", input => { const row = getEvent(input, 2, 1); for (let i = 0; i < 260; i++) input.netlog.events.push({ ...structuredClone(row), type: 9000 }); }, /source-row capacity/]
]) test(`rejects ${name}`, () => {
  const input = fixture(); mutate(input); assert.throws(() => assertOriginalNegativeNetlog(input), pattern);
});
