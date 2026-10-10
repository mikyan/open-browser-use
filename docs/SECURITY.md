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

- The extension accepts an explicit set of public RPC methods and checks task ownership for tab/target operations. Arbitrary CDP within an owned target remains powerful; this is not a site policy or a security sandbox.
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

Application-level client authentication and user-configured site policies remain unimplemented. Transport behavior and tested failure boundaries are documented in [Local IPC transport](references/local-ipc-transport.md).

## User Pause

The production runtime disables CRX's implicit `tabs.onCreated` popup attachment.
New Pages must pass backend ownership/admission hooks; iframe child sessions
continue through the existing owned-root route. This prevents a popup from
bypassing input tracking and pause cleanup, but does not prevent Chromium from
activating a native popup or provide website-origin isolation.

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
- `downloads` for download observation.
- Native Messaging to communicate with the local host.

Users must understand that installing and enabling the extension allows Open Browser Use to inspect and operate real Chrome tabs in their active profile. The native messaging host manifest must keep `allowed_origins` restricted to the expected Open Browser Use extension ID.

## Clipboard, Downloads, And Files

Clipboard, download, and file chooser features are sensitive.

- Clipboard helpers run through the controlled page context and should only be called for explicit user workflows.
- File chooser paths can reveal private filesystem structure; do not log them unless needed, and redact them from shared reports. The current download API tracks owned CDP GUIDs but cannot reliably map them to a local path, so `downloadPath` explicitly reports unsupported instead of guessing from global browser downloads.
- Chooser records retain their originating tab, frame, attachment and control epoch; stale or foreign records are rejected. See [File transfers](references/file-transfers.md) for deadlines and unsupported cases.
- Integrations should confirm uploads, downloads, file selection, form submission, purchases, deletion, and external message sending before execution.

## Secrets And Data Handling

Network wait handles bind to their original session, turn, epoch, tab and
attachment. Every collect revalidates that scope; Pause, control end, transfer,
detach and restart invalidate the handle. IDs are routing references rather than
credentials. Matchers accept finite literal URL/method/status fields, and results
contain bounded metadata without headers or bodies. URLs can still contain private
query values, so treat these results as page data and redact before sharing.
Pending and retained waits have fixed capacity, deadlines and terminal expiry;
see [network waits](references/network-waits-design.md).

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
