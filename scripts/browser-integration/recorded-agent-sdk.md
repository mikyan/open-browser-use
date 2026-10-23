# Passive public SDK recording

This helper records an independent solver's calls to the formal JavaScript SDK.
It contains no browser launcher, task solution, fixture import, selectors, retry
policy, deadline extension or automatic browser cleanup.

Await the factory with the absolute path (or `file:` URL) of the formal
`packages/open-browser-use-js/dist/index.js` module and a **new absolute log
directory**. Its parent must exist. An existing directory is rejected, even if
empty; use a fresh directory for each attempt. All evidence files use exclusive
creation, and a previous attempt is never overwritten.

The recorder explicitly imports `performance` from `node:perf_hooks`, `Buffer`
from `node:buffer` and `URL` from `node:url`. It does not require the host to
expose those globals or `process`, and does not import `node:process`. The SDK
itself still needs the APIs required by its documented runtime.

```js
var recording = await createRecordedAgentSDK({ sdkPath, directory });
var browser = await recording.connect({ socketPath, sessionId });
// Use browser, browser.client, tabs and locator chains as documented by the SDK.
// finalizeTabs keeps its real signature, including full objects:
// await browser.client.finalizeTabs([{ tabId, status: "deliverable" }]);
// Browser cleanup is the solver's explicit responsibility, not the recorder's.
browser.close();
var recordingResult = await recording.closeLog();
```

`connect(options)` invokes the module's original `connectOpenBrowserUse` exactly
once. Exported `OpenBrowserUse*` class instances are proxied; each method runs
with its original instance as `this`, preserving private-field brands. Returned
SDK objects and public SDK properties support locator/frame chains. SDK proxies
inside plain objects and arrays are unwrapped for `and`, `or`, `filter`,
`dragTo` and other arguments. Input data is never mutated; data containers are
copied only where a reference must change. Ordinary unchanged argument and
result objects retain identity. Original synchronous throws and Promise
rejections retain the exact thrown value and are never retried.

This is not arbitrary JavaScript equivalence. A saved method stays bound to its
original instance; `call`/`apply` cannot rebind it to another receiver. The
wrapper Promise is not the identical original Promise. Functions and unknown
class instances are recorded as opaque identities, not source code or private
state. Accessor values are marked unobserved and are never evaluated for logging.
SDK references nested inside arbitrary custom classes/accessors are not
rewritten. For this research attempt, `evaluate` uses a string expression, not
a callback/closure. Object property reads and internal SDK-to-SDK calls are not
separate recorded operations. Notification callbacks are not intercepted. This
log proves public SDK calls and observed results, not every transport RPC or
native event.

## Flush and completion

`await recording.flush()` drains already-enqueued evidence writes and syncs the
log file. It returns `{ calls, pendingCalls, bytes, directory }`. It does not
wait for, cancel, complete or retry any pending SDK operation. A nonempty
`pendingCalls` list is not task completion.

`await recording.closeLog()` requires zero pending calls, writes the single
close record, flushes and closes the log. Concurrent close requests join the
same close operation. Calls through this recorder after close starts are
rejected before SDK dispatch. Closing the log does not close the browser.

Recording failures are sticky: an I/O failure or capacity limit does not replace
the SDK's original result/error or cause a retry, but `flush()` and `closeLog()`
must fail. Such an attempt cannot claim complete evidence. The limits are 10,000
calls, 20,000 serialization nodes and depth 64 per value, 64 MiB per item and
256 MiB aggregate recorded bytes. They are evidence limits, not SDK deadlines.

## Evidence format

- `recording.json`: module URL, entry-file SHA-256, creation clocks, limits and
  scope. Its hash covers only the imported entry file; freeze and verify the
  complete SDK separately.
- `calls.jsonl`: one `start` and one observed `return`/`throw` record per call,
  linked by `callId`, `receiver` and `operation`. Each has wall milliseconds and
  an integer decimal `monotonicNs` string. This is `performance.now()` in
  milliseconds multiplied by 1,000,000 and truncated to integer nanosecond
  **units**, not nanosecond precision. Resolution and floating-point precision
  remain those of the runtime's performance clock; equal successive values are
  valid. Its origin is runtime-specific, not Unix time, and must not be compared
  across runtimes or against older `process.hrtime` recordings. Settlement
  records include both clocks and `elapsedNs`, the integer difference of the
  start and end monotonic values. These measure the wrapper's observed SDK
  duration, not individual native operations or model reasoning. Schema version
  1 and the field types remain unchanged.
- `artifacts/`: original binary byte copies or large string artifacts. Each
  reference has a relative path, encoding, byte length and SHA-256. `bytes`
  artifacts contain the original Buffer/ArrayBuffer-view bytes. `json-string`
  artifacts are UTF-8 JSON string literals: use `JSON.parse` to recover the exact
  string, including isolated UTF-16 surrogates. Screenshot base64 remains the
  original base64 string; the recorder does not decode or alter the image.

Plain values use tagged `{ $type, $id, properties }` records. Arrays preserve
their indices, length and holes; repeated/cyclic containers use `$cycle` to the
same value's `$id`. Undefined, nonfinite numbers, negative zero, bigint, Date,
RegExp, Error and accessors have explicit tags. Errors retain their original
own data properties, including message/stack/cause when present. SDK instances
use `{ $sdkRef, kind, tabId? }`; `tabId` is read only from documented public Tab
or locator/mouse/keyboard properties. No SDK instance fields are enumerated.
Function references are opaque and do not capture callback contents. Symbol
keys use a descriptive label; this is not a lossless arbitrary-symbol protocol.

A separate auditor must check the complete start/settlement/close sequence,
zero pending calls, all referenced artifact bytes/hashes and the original task
outcome. A successful log close alone does not prove a correct report, page
cleanup, original process exit, no focus interference or Browser Use parity.

## Local verification

`node --test scripts/browser-integration/recorded-agent-sdk.test.mjs` covers
private-field classes, original connection/method failures, unchanged finalized
tab objects, nested locator arguments, cycles, data preservation, pending calls,
I/O/limit failures, exclusive attempt creation and concurrent close. One test
removes the host `process`, `performance`, `Buffer` and `URL` globals in an
isolated worker, then checks factory creation, original mock calls, a real
asynchronous duration, byte artifacts and the final close record. Another test
uses the current formal SDK dist classes with an explicitly stubbed local
client transport to check actual locator/drag/finalize shapes. It is not a
browser or Native Messaging acceptance test.
