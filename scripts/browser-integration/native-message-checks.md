# Real native-message acceptance

`native-message-checks.mjs` is a separate Windows acceptance runner. Unlike
`run.mjs`, it leaves `chrome.runtime.connectNative` intact and lets Edge/Chrome
launch the real native host. It has not passed native acceptance merely because
its syntax or synthetic payload checks pass.

Build the host and JS SDK, then run from the repository root:

```powershell
$env:OBU_TEST_HOST_BINARY = (Resolve-Path .tmp/open-browser-use.exe).Path
node scripts/browser-integration/native-message-checks.mjs
```

The default is installed Edge Stable. `OBU_TEST_NATIVE_BROWSER=edge|chrome`
selects the matching registry namespace; `OBU_TEST_CHROMIUM_BINARY` overrides
the executable and must support unpacked-extension loading. Chrome is optional
and requires its own successful run before claiming support for this test path.

Each of the two cases creates its own profile and process environment under
`.tmp/browser-integration/native-*/`. The runner registers a unique, previously
absent HKCU native-host name, verifies its manifest, and deletes only that exact
temporary key in `finally`. It does not replace an installed host registration,
write HKLM/policy, or use a daily browser profile. A registry value changed by
another actor is retained and reported as cleanup failure. Artifacts are kept.

The modern case builds the production extension and changes only its test host
name and public unpacked-extension key. Two SDK clients each submit a payload
over 2 MiB containing Chinese text, emoji, HTML and slashes through public
`tab.evaluate`. Page-computed UTF-8 length, SHA-256 and execution count must match
the independent Node values. Small evaluations and pings follow, with the same
native PID, executable identity and endpoint. Tab activation and window-focus
ledgers must remain empty while the original sentinel stays active.

The legacy case has a deliberately minimal isolated extension that never sends
the transport hello. A large SDK request must receive
`OBU_NATIVE_MESSAGE_TOO_LARGE`, never reach its handler, and leave a subsequent
small ping working on the same native process. It does not simulate a production
browser action or a broken modern receiver.

The runner records source/build/staged hashes, exact payload byte counts and
digests, process/status checkpoints, raw foreground ledgers, browser/native logs
where available, registration-before/cleanup records, and host process exit.
No payload is substituted by a local file path, screenshot response or WebSocket
bridge. Inspect both case results and cleanup evidence before reporting success.

Verified on 2026-10-11 with installed Edge 153 on Windows in isolated run
`native-u7vkkz`: both modern and legacy cases passed. The two modern content
payloads contained 2,097,173 and 2,097,174 UTF-8 bytes; serialized CDP parameters
exceeded 2.5 MB each. Each page digest matched Node and each execution count was
one. Both clients' later small evaluations and pings kept the original native
PID and endpoint. The legacy large request returned
`OBU_NATIVE_MESSAGE_TOO_LARGE`, its handler count stayed zero, and its later ping
succeeded on the same host process. Both raw activation/focus ledgers stayed
empty. Both isolated browsers and hosts exited, and both unique registration
keys were independently checked absent after cleanup. This evidence does not
constitute a Chrome-specific run or replace the separate full browser suite.
