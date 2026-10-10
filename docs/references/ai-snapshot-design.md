# Bounded page observations and capture-scoped references

Status: implemented in the production source and the JavaScript, Python and Go
SDKs. `snapshotAI` provides bounded recursive observations and capture-scoped
element references. Windows Chromium acceptance passed all 31 cases for this
slice; that coverage does not establish full Codex parity.
The historical experiments below explain the adaptations. The current wire
contract is [Browser action protocol](browser-action-protocol.md).

## Objective and comparison boundary

The immediate P04 need is a complete, bounded observation of the root document
and its frames, with a reliable way to address observed elements. The existing
`snapshot` remains real Playwright ARIA YAML for a selected element or frame
body. `snapshotAI` is the separate recursive path; it does not change that
existing method's traversal or return type.

The actual Codex browser surface inspected during this task expanded same-origin
and cross-origin iframe subtrees in `playwright.domSnapshot()`, without printing
AI reference tokens. Its inspected locator surface did not advertise
`snapshotAI` or `getByRef`; a separate accessibility interface exposed numeric
indices. These are observations of that runtime, not a claim about all Codex
versions. The reference API below is an Open Browser Use contract, not a claim
to reproduce a Codex method with the same name. See the
[limited read-only baseline](codex-observation-baseline.md) for its fixture and
scope; it measured neither input tasks nor comparative performance.

The fixed runtime is Playwright CRX 0.15.0, embedding Playwright 1.53.0, licensed
Apache-2.0. This implementation retains those pinned versions and the checked
upstream bundle digest. Later public Playwright snapshot options are not
silently accepted here.

- [CRX package definition](https://github.com/ruifigueira/playwright-crx/blob/main/package.json)
- [Embedded Playwright package](https://github.com/ruifigueira/playwright-crx/blob/main/playwright/packages/playwright-core/package.json)
- [Current Playwright snapshot documentation](https://playwright.dev/docs/api/class-locator#locator-aria-snapshot)

## Unmodified runtime and reasons for adaptation

The bundled JavaScript Page client has `_snapshotForAI()` even though it is not
part of the public Page TypeScript interface exported by CRX. It calls the
private `Page.snapshotForAI` channel. The unmodified schema accepts an optional
empty object and returns `{ snapshot: string }`; it has no limit or timeout
arguments. OBU adds an opt-in bounded metadata form while preserving this
original string client's behavior.

The server's `snapshotFrameForAI` calls the real injected ARIA implementation
with `forAI: true`, recursively enters iframe documents, and renders references.
The native `aria-ref` selector resolves an element from the last injected ARIA
snapshot map. This is a real selector engine, not a CSS approximation.

These unmodified behaviors required explicit handling before public exposure:

- Every ordinary `ariaSnapshot()` also replaces `_lastAriaSnapshot`. A later
  ordinary snapshot can invalidate a previously generated AI reference map.
- References are cached on each Element as `_ariaRef`, with a frame ordinal
  prefix. The renderer can retain these prefixes across observations.
- Page `snapshotForAI` originally reset `lastSnapshotFrameIds` on every call.
  Reordering that lookup independently of cached references can misroute a
  reference from a newly returned observation.
- Child capture exceptions are caught and reduced to a bare iframe line. A
  result can therefore omit child content without reporting incompleteness.
- Capture constructs the complete tree/string. There is no native result-size,
  reference-count, node-count, depth, or frame-count limit on this path.

## Historical native evidence

The POC used an isolated Edge 153 profile, the real Go native host, and the public
JavaScript SDK. Only the staged extension changed: a no-locator `snapshot`
temporarily called the real Page `_snapshotForAI()`. It did not inject a custom
ARIA algorithm. A later staged build added stable frame slots. The runner used
raw CDP only for the extension worker and fixture preparation, not a second
Playwright connection to the controlled page. An active sentinel tab remained
unchanged. Test-specific native registration was removed and checked afterward.

| Experiment | Observed result |
| --- | --- |
| Initial root, open shadow root, same-origin frame, OOPIF, nested frame | All returned native refs; each ref read the expected element through the SDK |
| Another snapshot of unchanged documents | Existing Element refs were reused |
| Replace a DOM node before another snapshot | Its old ref matched zero elements; the replacement received a new ref |
| Change a node's name in place | Before the next snapshot, its old ref still addressed the same renamed node; a new snapshot assigned a different ref |
| Ordinary scoped ARIA snapshot after AI snapshot | Old root refs matched zero elements |
| Prepend a new sibling iframe, then capture again, unmodified runtime | Both `Inserted action` and `Same action` appeared as `f1e2`; reading the newly returned Same ref returned Inserted. Cross ref matched zero and the nested subtree was omitted |
| Replace iframe owner or navigate the root, then capture | Native ref strings were reused for new documents, e.g. old `e2` read the new root button and old `f2e2` read the replacement iframe button |
| End epoch, reattach, capture | Native ref strings could be reused across attachments |
| 3,000 buttons | 405,811 UTF-8 bytes, 3,001 printed refs; approximately 250 ms, no built-in result cap |
| SVG iframe with no HTML body | A 600 ms outer engine deadline failed in approximately 610 ms; it did not return a successful partial capture |
| End control after root/child snapshot evaluation started | Pending capture failed with Page closed; `turnEnded` completed in 15 ms |
| Transfer ownership while child capture waited | New owner's attachment canceled the old capture; old owner was denied and new owner could not read the old map |

Local evidence was recorded in ignored `.tmp/runtime-parity-audit/` artifacts:
`ai-ref-TJgQjp`, `ai-ref-stable-Guo4W7`, and `ai-ref-lifecycle-cUW88Z`.
The corresponding `ai-ref-probe.mjs`, `ai-ref-stable-probe.mjs`, and
`ai-ref-lifecycle-probe.mjs` are exploratory local scripts, not committed CI
coverage. A report marked `passed` means its stated experimental assertions
completed; the unmodified-runtime report deliberately records incorrect routing.

## Implemented frame routing

The production patch maintains `lastSnapshotFrameIds` as stable slots for live
Frame identities:

1. At capture start, mark slots for detached frame IDs empty and trim trailing
   empty slots. Preserve slots for still-live frames.
2. When visiting a child, reuse its existing slot. Otherwise reuse an empty slot
   before appending a new one.
3. Continue using the original ARIA renderer and `aria-ref` selector. Do not
   rewrite accessible names, roles, or selector semantics.

With this temporary adaptation, prepend and atomic DOM `moveBefore` reorder
returned refs that all resolved to the intended elements. One hundred repeated
snapshots held four live frame slots. Six create/remove cycles reused a fifth
slot rather than growing the array. Replacement and navigation remained correct
within the new capture, while native ref strings could still be reused; capture
invalidation is therefore independently required.

Slot count and live frames are bounded by the frame limit. Detached holes are
reused and trailing holes removed. Existing native attachment identities and
the OOPIF transport remain in use.

## Implemented public contract

The name `snapshotAI` is specific to Open Browser Use. It is advertised by
`engineInfo.capabilities.snapshotAI === 1` and `captureRefs === 1`, with ceilings
in `engineInfo.snapshotLimits`; browser action protocol version 1 is unchanged.

```json
{
  "action": "snapshotAI",
  "args": {"maxBytes": 262144, "maxNodes": 5000, "maxRefs": 2000, "maxFrames": 32, "maxDepth": 64},
  "timeoutMs": 10000
}
```

Result, within the normal browserAction envelope:

```json
{
  "captureId": "opaque-random-id",
  "snapshot": "- button \"Continue\" [ref=e2]",
  "refs": ["e2"],
  "stats": {"bytes": 28, "nodes": 3, "refs": 1, "frames": 1},
  "complete": true
}
```

The example stats are illustrative. Actual counts come from capture traversal
and UTF-8 encoding. `refs` contains only references actually emitted by the
native renderer. Internal frame IDs and ancestor handles remain private.

A ref locator is a singleton descriptor:

```json
[{"kind": "ref", "captureId": "opaque-random-id", "ref": "e2"}]
```

The singleton cannot be chained with CSS, ordinal, filter, or frame steps. The
engine requires exact membership in the current capture's emitted refs. Actions
still use real Playwright locators and the ordinary ownership checks, queue,
rendering lease, deadline, and input cancellation. Capture IDs prevent accidental
reuse; they are not authentication credentials or a restriction on raw CDP.
Ordinary CSS/frame selector strings cannot invoke the native `aria-ref` engine,
including inside composite or nested selectors. The guard uses the pinned
Playwright parser, so CSS attributes and text containing the literal
`aria-ref=` remain valid.

JS exposes `snapshotAI()` and `getByRef(captureId, ref)`; Python uses
`snapshot_ai()` and `get_by_ref(capture_id, ref)`; Go uses `SnapshotAI()` and
`GetByRef(captureID, ref)`. CLI and MCP use the same `browserAction` envelope.
The SDKs validate options and returned metadata rather than extracting refs
from YAML or falling back to the old snapshot method.

At most one capture per attached Page is valid, bound to attachment generation,
session, control epoch and frame/document generation. It is invalidated before
any subsequent AI or ordinary snapshot begins, and on any frame attach,
detach, or navigation, Page close, detach, ownership transfer, epoch end, pause,
or worker restart. Failed replacement capture leaves no previous valid capture.
During capture, frame events invalidate the attempt; the engine checks that
generation again before publishing its ID. This is not an atomic DOM snapshot
across documents.

DOM changes within the same document do not imply that every reference is
retargeted by meaning. A ref denotes the same connected Element, not a frozen
accessible name or a live selector that finds a replacement. Removed nodes must
fail; renamed nodes may remain the same Element.

Errors include `OBU_CAPTURE_EXPIRED`, `OBU_REF_NOT_IN_CAPTURE`,
`OBU_SNAPSHOT_LIMIT`, and `OBU_SNAPSHOT_INCOMPLETE`. An expired capture does not
trigger recapture, replacement-node selection or input replay. An already
started ref click can successfully cause navigation; that invalidates later
uses without converting the completed click into a retryable failure. A ref
can also perform one ordinary ARIA snapshot, which invalidates its capture for
subsequent operations.

## Trusted metadata and bounded capture adaptation

Refs are collected at the native renderer's genuine-ref output branch, never
by a global regex over YAML. Accessible names and page text may themselves
contain `[ref=...]`; those strings do not register references.

The adaptation touches these fixed-runtime anchors:

| Anchor | Implemented adaptation |
| --- | --- |
| `scheme.PageSnapshotForAIParams/Result` | Add finite optional capture settings and optional structured metadata; retain the string snapshot field |
| Page dispatcher `snapshotForAI(params, metadata)` | Forward bounded settings and return typed metadata |
| Server Page `snapshotForAI` | Stable frame slots, shared deadline and aggregate budgets, explicit incomplete failure |
| Bounded recursive capture helper | Carry budgets into each child, collect its actual Frame identity, propagate errors instead of silently emitting a bare iframe |
| Injected `generateAriaTree` | Count visited nodes/depth during traversal and fail when their budgets are exhausted |
| `renderAriaTree` genuine-ref branch | Collect emitted refs from real nodes and enforce the UTF-8 output budget while building lines |
| Injected `ariaSnapshot` | Return a metadata form only for the dedicated private request; preserve ordinary ARIA snapshot behavior |
| Extension runtime adapter | Call this one known private channel; return a checked structure rather than arbitrary channel/property access |

Bounded iframe nodes use the native collection rendering branch, so fallback
text and the actual child document occupy a valid YAML child list. The server
does not guess structure by appending punctuation to rendered lines. Ordinary
unbounded ARIA rendering remains unchanged.

The original client `_snapshotForAI()` continues returning its string field.
A dedicated runtime adapter consumes the extended channel result. Metadata
collection is an adaptation of the original algorithm, not an independent ARIA
tree generator. Generated injection source, private schema and server/client
dispatch are adapted together.

Hard ceilings are 256 KiB of YAML, 5,000 visited DOM nodes, 2,000 emitted refs,
32 frames including the root, and depth 64. Callers can choose smaller positive
integer budgets; zero, excessive or unknown settings fail. The existing
1–120,000 ms action deadline includes setup and queue time. Limit failures reject
the capture instead of truncating YAML or advertising unusable refs. UTF-8 byte
counts include cross-frame indentation and joined output. Metadata arrays and
internal registries are also bounded.

These limits bound traversal and returned/stored data; they do not constitute a
hard memory or CPU sandbox for the browser's existing accessible-name algorithm.
For example, a single huge text value may be computed before the output check.
Any claim of a strict browser-memory bound needs separate work and evidence.

The patched source retains the pinned upstream digest check, unique shape
assertions, Apache notices and a `MODIFICATIONS.txt` entry. It does not upgrade
CRX or substitute another Playwright version.

Implementation locations:

- `scripts/patch-ai-snapshot.mjs`: private schema, bounded native traversal,
  recursive assembly, stable slots and native selector guard.
- `apps/chrome-extension/browser-ai-snapshot.js`: checked channel result and
  native Frame identities for ref screenshot preflight.
- `apps/chrome-extension/browser-observation.js`: current capture, membership
  and lifecycle invalidation.
- `apps/chrome-extension/browser-action-engine.js`: public validation,
  authorization, queue/deadline integration and ref dispatch.
- `packages/open-browser-use-{js,python,go}`: public SDKs and wire validation.

## Frame-aware ref actions and screenshots

Explicit `frame` descriptor screenshots pre-scroll owner elements from outside
in before taking the real element screenshot. Ref screenshots perform the
equivalent preparation using the capture's actual Frame objects.

The adapter resolves live ancestor frame elements through real Playwright and
scrolls outside-in within the same rendering lease. It checks capture validity,
ownership and remaining deadline around each wait, then runs the original
element screenshot. It does not cache coordinates, infer ancestor CSS selectors
or activate the page. Frame changes during preparation fail the capture rather
than rebind the ref.

## Acceptance coverage and remaining scope

Targeted SDK, engine, adapter and build checks cover contract validation and
failure handling. The repository [browser harness](../../scripts/browser-integration/README.md)
contains formal fixture checks for the public end-to-end path. Windows Chromium
156 run `run-rC27uZ` passed all 31 cases with no active-tab events, including the
three new AI observation cases and snapshot/ref reads and trusted clicks through
JS, Python, Go, CLI and MCP. Extension/build checks passed 255 tests; JS passed
55, Python passed 32, and the Go package suite passed. JS/Python checks included
the real host integration. Coverage includes:

- Root, open shadow, same-origin, OOPIF and nested refs, including a real trusted
  input event through a ref locator.
- Frame prepend, atomic reorder, detach/replace and navigation; repeated
  snapshots and churn must not grow the slot/registry count without bound.
- Malicious-looking text containing fake ref tokens cannot become a valid ref.
- Direct and nested native `aria-ref` selector strings are rejected without
  rejecting matching literal CSS/text values; iframe fallback text remains valid
  YAML alongside its child document.
- New/ordinary snapshots, root/child navigation, iframe replacement, turn end
  and ownership transfer expire captures in the real browser. Frame-event races,
  Page disposal and late publication have unit coverage; global pause/worker
  restart retain their existing complete-suite checks.
- No-body and navigating children: bounded failure or explicitly complete
  observation, never an unmarked partial subtree.
- Byte/node/ref/frame/depth limits, Unicode byte accounting, deadline including
  queue/attach/capture, and no late successful publication after cancellation.
- Offscreen OOPIF/nested element screenshot through a ref, with an unchanged
  active sentinel tab.
- The same finite protocol through JS, Python, Go, CLI and MCP; metadata/schema
  negotiation must report the feature only after the complete path is enabled.

The historical POCs prove specific building blocks. Neither they nor OBU's own
fixture suite establish full behavior or performance parity with Codex; that
requires a separate matched task comparison.
