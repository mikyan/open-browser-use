# Bounded page observations and capture-scoped references

Status: design and isolated native proof of concept only. No `snapshotAI`,
`captureId`, or `ref` locator has been added to the production protocol. The
temporary runtime adaptations described below are not release artifacts.

## Objective and comparison boundary

The immediate P04 need is a complete, bounded observation of the root document
and its frames, with a reliable way to address observed elements. The current
production `snapshot` is real Playwright ARIA YAML. Its default traversal does
not expand iframe documents; callers can explicitly select a frame.

The actual Codex browser surface inspected during this task expanded same-origin
and cross-origin iframe subtrees in `playwright.domSnapshot()`, without printing
AI reference tokens. Its inspected locator surface did not advertise
`snapshotAI` or `getByRef`; a separate accessibility interface exposed numeric
indices. These are observations of that runtime, not a claim about all Codex
versions. The proposed reference API below is an Open Browser Use design, not a
claim to reproduce a Codex method with the same name.

The fixed runtime is Playwright CRX 0.15.0, embedding Playwright 1.53.0, licensed
Apache-2.0. The official npm `latest` and CRX main package definitions checked for
this investigation still had those versions. Modern public Playwright exposes
additional snapshot options in later versions; those options are not silently
accepted here.

- [CRX package definition](https://github.com/ruifigueira/playwright-crx/blob/main/package.json)
- [Embedded Playwright package](https://github.com/ruifigueira/playwright-crx/blob/main/playwright/packages/playwright-core/package.json)
- [Current Playwright snapshot documentation](https://playwright.dev/docs/api/class-locator#locator-aria-snapshot)

## What the fixed runtime actually contains

The bundled JavaScript Page client has `_snapshotForAI()` even though it is not
part of the public Page TypeScript interface exported by CRX. It calls the
private `Page.snapshotForAI` channel. Its current schema accepts an optional
empty object and returns `{ snapshot: string }`; it has no limit or timeout
arguments.

The server's `snapshotFrameForAI` calls the real injected ARIA implementation
with `forAI: true`, recursively enters iframe documents, and renders references.
The native `aria-ref` selector resolves an element from the last injected ARIA
snapshot map. This is a real selector engine, not a CSS approximation.

There are important differences between finding these functions and offering a
safe public feature:

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

## Native evidence

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

## Smallest demonstrated frame-routing adaptation

Maintain `lastSnapshotFrameIds` as stable slots for live Frame identities:

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

Slot count must also be bounded by the live-frame limit. A high-water array that
retains detached frames indefinitely is not acceptable. The production patch
must preserve the existing native attachment identities and OOPIF transport.

## Proposed public contract

The name `snapshotAI` below is provisional and specific to Open Browser Use.
Keep the existing YAML `snapshot` contract unchanged.

```json
{
  "action": "snapshotAI",
  "args": {"maxBytes": 262144, "maxNodes": 5000, "maxRefs": 2000, "maxFrames": 32, "maxDepth": 64},
  "timeoutMs": 10000
}
```

Suggested result, within the normal browserAction envelope:

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

For the first version, reject chaining it with CSS, ordinal, filter, or frame
steps. Require exact membership in the current capture's refs; do not merely
validate a token regex or accept another capture's native ref string. Actions
still use real Playwright locators and the ordinary ownership checks, queue,
rendering lease, deadline, and input cancellation. Capture IDs prevent accidental
reuse; they are not authentication credentials or a restriction on raw CDP.

Store at most one valid capture per attached Page. Bind it to attachment
generation, session, control epoch, and frame/document generation. Invalidate it
before any subsequent AI or ordinary snapshot begins, and on any frame attach,
detach, or navigation, Page close, detach, ownership transfer, epoch end, pause,
or worker restart. Failed replacement capture leaves no previous valid capture.
During capture, frame events invalidate the attempt; check that generation again
before publishing its ID. This is not an atomic DOM snapshot across documents.

DOM changes within the same document do not imply that every reference is
retargeted by meaning. A ref denotes the same connected Element, not a frozen
accessible name or a live selector that finds a replacement. Removed nodes must
fail; renamed nodes may remain the same Element. Document this distinction.

Use explicit errors such as `OBU_CAPTURE_EXPIRED`, `OBU_REF_NOT_IN_CAPTURE`,
`OBU_SNAPSHOT_LIMIT`, and `OBU_SNAPSHOT_INCOMPLETE`. Do not convert an expired
capture to a fresh capture, retry an action on a replacement node, or replay
input after cancellation.

## Trusted metadata and bounded capture adaptation

Do not extract refs with a global regex over the YAML string. Accessible names
and page text may themselves contain `[ref=...]`. The existing renderer knows
exactly when it emits a genuine ref and still has the native Element map.

The smallest credible metadata extension touches these fixed-runtime anchors:

| Anchor | Required change |
| --- | --- |
| `scheme.PageSnapshotForAIParams/Result` | Add finite optional capture settings and optional structured metadata; retain the string snapshot field |
| Page dispatcher `snapshotForAI(params, metadata)` | Forward bounded settings and return typed metadata |
| Server Page `snapshotForAI` | Stable frame slots, shared deadline and aggregate budgets, explicit incomplete failure |
| `snapshotFrameForAI` | Carry budgets into each child, collect its actual Frame identity, propagate errors instead of silently emitting a bare iframe |
| Injected `generateAriaTree` | Count visited nodes/depth during traversal and fail when their budgets are exhausted |
| `renderAriaTree` genuine-ref branch | Collect emitted refs from real nodes and enforce the UTF-8 output budget while building lines |
| Injected `ariaSnapshot` | Return a metadata form only for the dedicated private request; preserve ordinary ARIA snapshot behavior |
| Extension runtime adapter | Call this one known private channel; return a checked structure rather than arbitrary channel/property access |

The original client `_snapshotForAI()` can continue returning its string field.
A dedicated runtime adapter can consume the extended channel result. Metadata
collection is an adaptation of the original algorithm, not an independent ARIA
tree generator. Generated injection source, private schema and server/client
dispatch must be changed together; changing only a convenient server function
is insufficient.

Proposed hard ceilings for the first version are 256 KiB of YAML, 5,000 visited
DOM nodes, 2,000 emitted refs, 32 frames including the root, and depth 64. Allow
callers to choose smaller positive budgets; reject zero, excessive or unknown
settings. Keep the existing 1–120,000 ms overall action deadline. Fail explicitly
on a limit instead of truncating YAML mid-node or advertising unusable refs.
Count UTF-8 bytes, including cross-frame indentation and joined output. Bound
metadata arrays and internal registries independently of the output string.

These limits bound traversal and returned/stored data; they do not constitute a
hard memory or CPU sandbox for the browser's existing accessible-name algorithm.
For example, a single huge text value may be computed before the output check.
Any claim of a strict browser-memory bound needs separate work and evidence.

The patched source must retain the pinned upstream digest check, unique shape
assertions, Apache notices and a precise `MODIFICATIONS.txt` entry. Do not upgrade
CRX or silently use an incompatible public Playwright version as part of this
slice.

## Frame-aware ref actions and screenshots

The current screenshot fix pre-scrolls explicit `frame` descriptor owners from
outside in before taking the real element screenshot. A singleton ref descriptor
contains no such steps and would bypass that fix if translated directly to
`aria-ref=fNeX`.

Capture metadata must therefore retain the actual Frame and ancestor identities.
A ref screenshot needs equivalent owner preflight, resolving each live ancestor
frame element through real Playwright, then scrolling outside-in within the same
rendering lease. Check capture validity, ownership and remaining deadline before
and after every wait, then run the original element screenshot. Do not cache
coordinates, infer ancestor CSS selectors, or activate the page to make it work.
Frame changes during this process fail the capture rather than rebind the ref.

## Delivery gate for a complete slice

Before enabling the public API, commit tests covering:

- Root, open shadow, same-origin, OOPIF and nested refs, including a real trusted
  input event through a ref locator.
- Frame prepend, atomic reorder, detach/replace and navigation; repeated
  snapshots and churn must not grow the slot/registry count without bound.
- Malicious-looking text containing fake ref tokens cannot become a valid ref.
- All listed invalidation events, ordinary ARIA snapshot interleaving, and
  cross-session/epoch rejection without automatic recapture or action replay.
- No-body and navigating children: bounded failure or explicitly complete
  observation, never an unmarked partial subtree.
- Byte/node/ref/frame/depth limits, Unicode byte accounting, deadline including
  queue/attach/capture, and no late successful publication after cancellation.
- Offscreen OOPIF/nested element screenshot through a ref, with an unchanged
  active sentinel tab.
- The same finite protocol through JS, Python, Go, CLI and MCP; metadata/schema
  negotiation must report the feature only after the complete path is enabled.

The stable-slot and lifecycle POCs prove specific building blocks. They do not
complete the metadata, limits, capture registry, public facades or these release
acceptance checks.
