# Security Policy

Open Browser Use connects automation clients to the user's real Chrome profile through a Chrome extension, Chrome Native Messaging, and a local native host. Treat it as local browser control infrastructure, not as a sandbox boundary.

## Supported Scope

Security fixes are expected to cover the current Chrome route:

- MV3 Chrome extension under `apps/chrome-extension/`.
- Go native host and CLI under `cmd/open-browser-use/` and `internal/`.
- JavaScript, Python, and Go SDK packages under `packages/`.
- Installer, manifest, release, and skill documentation that affects how users enable browser control.

Experimental references, reverse-engineering notes, and archived planning material are useful context, but they are not independently supported interfaces unless they are wired into the current route.

## Reporting Vulnerabilities

If you find a security issue, do not open a public issue with exploit details. Report it privately to the maintainers first.

Please include:

- A short description of the impact.
- Affected component and version, commit, or release.
- Reproduction steps or proof of concept, with secrets and personal browsing data removed.
- Whether the issue requires local access, extension installation, a malicious web page, or a malicious automation client.

Do not include real credentials, private cookies, personal browsing history, or unredacted local paths in reports. Maintainers should coordinate disclosure timing before publishing technical details.

## Security Boundaries

The Chrome route intentionally exposes powerful browser automation primitives to local callers that can reach the Open Browser Use socket.

- The extension accepts an explicit set of public RPC methods and checks task ownership for tab/target operations. In the default all-websites mode, arbitrary CDP within an owned target remains powerful. Optional website restrictions check the complete live document tree and disable unaudited raw/data channels; see [website access settings](references/site-access-policy.md). This is not a network firewall or security sandbox.
- Persistent control epochs reject obsolete turns. Session IDs identify routing and ownership records; they are not authentication credentials.
- AI snapshot refs are bound to the current capture and native Element metadata, not parsed from page text. New snapshots, frame lifecycle or control changes expire them; native ref selectors require that capture context. These checks prevent accidental stale-element reuse, not arbitrary CDP access or hostile local clients. See [bounded observations](references/browser-action-protocol.md#bounded-recursive-observations).
- Upper-layer runtimes are responsible for deciding which sites, methods, downloads, clipboard operations, and destructive actions are allowed.
- The native host and extension are not a general-purpose sandbox for untrusted code.
- Any integration that accepts remote instructions must add its own authentication, authorization, audit logging, and confirmation policy before invoking Open Browser Use.

## Local Transport

The Go native host bridges Chrome Native Messaging stdio to local IPC: Unix sockets on Unix systems and a current-user-SID restricted named pipe on Windows.

- The default registry is `/tmp/open-browser-use` on Unix and the platform temporary directory's `open-browser-use` child on Windows; descriptors and `active.json` contain the actual endpoint.
- Files request owner-only permissions on Unix; Windows pipe access is limited to the current user's SID. Descriptor files remain subject to their directory's Windows ACL.
- The CLI may discover endpoints through the registry. Access-denied, busy, or timeout results are not evidence that an endpoint is stale and must be removed.
- Scoped CDP/download notifications go only to connections that explicitly used the corresponding session. Unknown response IDs and unscoped event notifications are dropped; heartbeats are global.
- Bounded per-client writers isolate slow readers. Overflow or a write deadline closes that connection and clears its pending responses; it never silently drops an individual response and continues the stream.
- Callers should treat access to the user's local account as access to the browser automation channel. These controls do not authenticate separate applications running as that user.

Application-level client authentication remains unimplemented. User-configured document-access policies do not authenticate local clients or block a website's own network traffic. Transport behavior and tested failure boundaries are documented in [Local IPC transport](references/local-ipc-transport.md).

## User Pause

Experimental Windows managed sessions use a separate profile, private native
registration and current-user management pipe. A live supervisor may expose
status, view and stop for its exact run; it does not add Pause/Resume authority to
the task RPC interface. The experimental viewer uses a separate one-use fragment
ticket, exact loopback Host/Origin, and one active WebSocket. Run/view may show
that ticket to the local human; Info, status and lifecycle records must not.
Its fixed worker bridge validates the original run, native binding, worker/context
and channel identity. It exposes only typed user operations, not arbitrary CDP;
ordinary popup authorization remains unchanged. In-place login handoff is not implemented.
Its profile and native environment are separate from ordinary
installed profiles, but are not a sandbox against arbitrary code running as the
same OS user. Startup rejects unknown nonempty directories and reparse paths;
cleanup acts on the retained owned Job and original handles, never a PID file.
See [managed sessions](references/managed-browser-session.md).

The development `managed setup` path is an explicit visible login-preparation
mode. It disables extensions, creates no native host registration or task endpoint,
and is rejected by CLI/MCP task selection. It uses the same exclusive profile lock
as run; neither mode starts the other automatically. Setup starts at about:blank,
accepts no login URL/password flags, and discards browser stdout/stderr instead of
creating browser logs. Persistent site data stays in the dedicated profile under
the same OS user. This does not transfer active documents or prove compatibility
with a particular site's SSO/MFA, nor isolate data from arbitrary same-user code.

The production runtime disables CRX's implicit `tabs.onCreated` popup attachment.
New Pages must pass backend ownership/admission hooks; iframe child sessions
continue through the existing owned-root route. This prevents a popup from
bypassing input tracking and pause cleanup, but does not prevent Chromium from
activating a native popup or provide website-origin isolation.

Explicit popup claims preserve the original window and commit ownership through
a bounded trusted-context `chrome.storage.session` store. An unvalidated ordinary
tab reservation grants no authority to detach another session's attachment.
Moving an auxiliary tab quarantines its old claim before cleanup; failed cleanup
retains the reverse lock. End/Pause retain durable membership while releasing
control. This state survives worker replacement, not a full browser restart.
Claim timeout leaves real unresolved writes tracked; session end remains fenced
in `closing` until those writes settle. See [popup ownership](references/popup-ownership-design.md).

The browser action popup can pause all Agent sessions. Pause blocks new work,
invalidates old control epochs, and releases tracked native input before
detaching. It does not close or move pages. Failed cleanup stays blocked; Resume
requires confirmed cleanup, and callers must explicitly begin a new turn.
Persisted paused state survives a worker restart. It cannot undo an input that
already reached a page or stop that page's own timers, network, or downloads.

The native RPC interface has no Pause/Resume setter. Mutation messages require
the extension's real action popup. Automation also rejects this extension's own
control pages and raw Target attach/tunneling commands that bypass an owned tab.
These guards protect the normal user-control path; they do not sandbox arbitrary
CDP or authenticate hostile programs running under the same local account.
See [control lifecycle](references/control-lifecycle.md) for exact sender checks,
command compatibility limits, cleanup deadlines, and restart recovery limits.

## Chrome Extension Permissions

The MV3 extension uses high-privilege Chrome APIs because browser control requires them:

The development build declares Chromium 125 as its minimum API baseline: flat
child debugger sessions require [Chrome 125](https://developer.chrome.com/docs/extensions/reference/api/debugger#type-DebuggerSession),
and the user-control popup identity check uses
[runtime.getContexts](https://developer.chrome.com/docs/extensions/reference/api/runtime#method-getContexts).
This declaration is an API requirement, not evidence that every Chromium-based
browser at that version has been tested. Current native acceptance is recorded
separately in the capability matrix and Edge installation reference.

- `chrome.debugger` for CDP access.
- `tabs` and `tabGroups` for tab and session management.
- `history` for history lookup.
- `downloads` for scoped download observation and explicit HTTP(S) GET downloads.
- Native Messaging to communicate with the local host.

Users must understand that installing and enabling the extension allows Open Browser Use to inspect and operate real Chrome tabs in their active profile. The native messaging host manifest must keep `allowed_origins` restricted to the expected Open Browser Use extension ID.

## Clipboard, Downloads, And Files

Clipboard, download, and file chooser features are sensitive.

- Clipboard helpers require an owned HTTP(S) tab and current control epoch, but
  execute in a packaged offscreen document over an authenticated private Port.
  The native clipboard remains shared across applications and sessions; only
  explicit clipboard workflows should call them. Page JavaScript does not
  receive clipboard payloads, and website-restricted modes reject the helpers.
  Payloads are bounded, never persisted, and a native write is never replayed
  after timeout or recovery. Unknown cleanup state blocks further work; see
  [clipboard](references/clipboard.md) for the contract and test limits.
- File chooser and download paths can reveal private filesystem structure; do not log them unless needed, and redact them from shared reports. Explicit `downloadURL` binds only the numeric ID returned by its native API call; path/cancel operations revalidate the original control scope. Its GET uses browser cookies, permits HTTP(S) without embedded credentials, and requests a unique filename without accepting dangerous downloads or opening the file. Browser settings and policy can still require UI.
- Page-triggered download paths require an explicitly authorized, exclusive Browser root binding. A random challenge binds that connection to the actual extension worker and Native Port; only the original extension-validated GUID/frame/control scope can claim a completed native event path. Path delivery checks a readable regular file and revalidates scope. Unbound installs remain unavailable; URL/timing guesses and live History reads are never fallback mappings. Validation does not freeze the file against later changes. See [original page downloads](references/original-page-download-delivery.md).
- Chooser records retain their originating tab, frame, attachment and control epoch; stale or foreign records are rejected. See [File transfers](references/file-transfers.md) for deadlines and unsupported cases.
- Integrations should confirm uploads, downloads, file selection, form submission, purchases, deletion, and external message sending before execution.

## Secrets And Data Handling

Native message fragments are accepted only on the extension's actual host port.
Local SDK clients cannot inject the private transport methods. A complete bounded
assembly enters the same public method and control checks as a small request;
fragments do not authorize actions. Disconnect, invalid framing and expired
assembly discard the buffer without replay. Logical/physical byte limits and
memory/deadline qualifications are documented in
[native message transport](references/native-message-transport.md).

Network wait handles bind to their original session, turn, epoch, tab and
attachment. Every collect revalidates that scope; Pause, control end, transfer,
detach and restart invalidate the handle. IDs are routing references rather than
credentials. Matchers accept finite literal URL/method/status fields, and results
contain bounded metadata without headers or bodies. URLs can still contain private
query values, so treat these results as page data and redact before sharing.
Restricted website waits additionally bind original native request/document/
loader and ancestor identities, the complete redirect chain and the original
policy generation/revision. A live allowed URL cannot authorize a response from
a replaced document or denied request origin. Unproven emitters fail closed.
Ready and cancellation await the actual server-local event-filter acknowledgement;
delivery rechecks original authority after cleanup. The real cleanup stays tracked
after a caller times out or the public record is removed. These checks constrain
returned metadata, not traffic initiated by the page.
Pending and retained waits have fixed capacity, deadlines and terminal expiry;
see [network waits](references/network-waits-design.md).

Restricted diagnostics retain original event provenance rather than trusting a
console source URL or the current tab URL. Console/errors require the original
native execution context and document; network entries and body references use
the original request, ancestor and redirect proof. Unknown sources are omitted
and counted in `dropped`. A policy change or replacement document revokes old
authority. Final checks cover asynchronous permission reads before returning
metadata or original response bytes. Body reads never refetch a URL, and pending
native reads and subscription cleanup remain tracked after caller timeout.
See [website access](references/site-access-policy.md) and
[original response bodies](references/original-response-bodies.md).

- Never commit credentials, cookies, API keys, browser profile data, native host manifests with private machine-specific paths, or captured user data.
- Keep examples synthetic and minimal.
- Redact local usernames, home directories, tokens, session IDs, and private browsing history from docs, history entries, release notes, and issue reports.
- Prefer environment variables or local config files ignored by Git for development secrets.

## Supply Chain

Repository-level dependency, SBOM, provenance, and release artifact expectations live in `docs/SUPPLY_CHAIN_SECURITY.md`. Security-sensitive dependency or release changes should update that document in the same change when expectations move.

## Maintainer Checklist

For security-affecting changes, verify:

- Manifest origins remain constrained to the intended extension.
- Native host install paths and generated manifests do not leak private local state.
- Socket files, registries, temp files, and release artifacts use the intended permissions.
- Tests cover authorization, stale transport state, and failure paths where practical.
- User-facing setup docs describe the real permissions and risks.
