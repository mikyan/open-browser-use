// Test transport only: delay one original successful Ctrl-down response.
// The real server receives every command unchanged. No receipt is constructed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const capacity = 128, parseLimit = 512 * 1024;
const positive = value => Number.isSafeInteger(value) && value > 0;
const digest = raw => {
  const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  return { rawSHA256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
};
const parse = raw => {
  if (!(typeof raw === "string" || Buffer.isBuffer(raw)) || Buffer.byteLength(raw) > parseLimit) return null;
  try { return JSON.parse(String(raw)); } catch { return null; }
};
const projectInput = input => {
  const result = {};
  // Do not retain typed text, clipboard data, authentication or page content.
  for (const key of ["type", "action", "key", "code", "windowsVirtualKeyCode", "modifiers", "repeat", "clipboardTransfer"]) {
    const value = input?.[key];
    if (typeof value === "string" && value.length <= 64 || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean") result[key] = value;
  }
  return result;
};

export async function installManagedCopyRejectionRoute(page, viewerURL) {
  const viewer = new URL(viewerURL);
  assert.ok(["http:", "https:"].includes(viewer.protocol) && ["127.0.0.1", "[::1]", "localhost"].includes(viewer.hostname),
    "The route requires the original loopback viewer");
  assert.equal(viewer.username + viewer.password, "", "Viewer URL cannot contain credentials");
  const socketURL = new URL("/ws", viewer.origin);
  socketURL.protocol = viewer.protocol === "https:" ? "wss:" : "ws:";
  const state = { armed: false, scope: null, connections: 0, request: null, response: null, held: false,
    forwardAttempt: null, requests: [], responses: [], overflow: false, errors: [] };
  const requests = new Map();
  let originalRoute = null, heldRaw = null;
  const noteError = message => {
    if (state.errors.length < capacity) state.errors.push(message);
    else state.overflow = true;
  };
  const append = (list, row) => {
    if (list.length >= capacity) { state.overflow = true; return false; }
    list.push(row); return true;
  };
  await page.routeWebSocket(url => url.href === socketURL.href, route => {
    const server = route.connectToServer();
    state.connections++;
    if (!originalRoute) originalRoute = route;
    else noteError("More than one original viewer socket was observed");
    route.onMessage(raw => {
      const value = parse(raw);
      if (state.armed && route === originalRoute && value?.operation === "humanInput" &&
          value.leaseId === state.scope.leaseId && value.generation === state.scope.generation) {
        if (!positive(value.id) || !positive(value.sequence) || requests.has(value.id)) {
          noteError("Invalid or duplicated original input identity");
        } else {
          const row = { id: value.id, operation: value.operation, leaseId: value.leaseId, generation: value.generation,
            sequence: value.sequence, input: projectInput(value.input), ...digest(raw), pageArrivedAt: Date.now() };
          if (append(state.requests, row)) requests.set(row.id, row);
          const input = value.input;
          if (!state.request && !state.overflow && input?.type === "key" && input.action === "down" &&
              input.code === "ControlLeft" && input.key === "Control" && input.windowsVirtualKeyCode === 17 &&
              input.modifiers === 2 && !Object.hasOwn(input, "repeat") && !Object.hasOwn(input, "clipboardTransfer")) state.request = row;
        }
      }
      server.send(raw);
    });
    server.onMessage(raw => {
      const value = parse(raw), request = value?.type === "response" && requests.get(value.id);
      if (request && route === originalRoute) {
        const receipt = value.result?.inputReceipt;
        const row = { id: value.id, ...digest(raw), serverArrivedAt: Date.now(),
          receipt: receipt && { leaseId: receipt.leaseId, generation: receipt.generation,
            sequence: receipt.sequence, acknowledged: receipt.acknowledged } };
        append(state.responses, row);
        if (state.request?.id === value.id) {
          if (state.response) noteError("Duplicated original Ctrl-down response");
          else if (value.error || receipt?.leaseId !== request.leaseId || receipt.generation !== request.generation ||
              receipt.sequence !== request.sequence || receipt.acknowledged !== true) {
            noteError("Original Ctrl-down response did not confirm its exact native input");
          } else if (!state.overflow) {
            state.response = row; state.held = true;
            heldRaw = Buffer.isBuffer(raw) ? Buffer.from(raw) : raw;
            return;
          }
        }
      }
      route.send(raw);
    });
  });
  return {
    arm(scope) {
      assert.equal(state.armed, false, "The rejection gate can be armed only once");
      assert.equal(state.connections, 1, "Arm only after one original viewer socket is connected");
      assert.ok(scope && Object.keys(scope).sort().join(",") === "generation,leaseId" &&
        typeof scope.leaseId === "string" && scope.leaseId.length > 0 && scope.leaseId.length <= 256 &&
        !/[\u0000-\u001f\u007f]/u.test(scope.leaseId) && positive(scope.generation), "Invalid original human scope");
      state.scope = { leaseId: scope.leaseId, generation: scope.generation }; state.armed = true;
    },
    snapshot() { return structuredClone(state); },
    release() {
      if (state.forwardAttempt) return structuredClone(state.forwardAttempt);
      // Cleanup can call release before the case arms or before its ACK arrives.
      // A no-op is not an attempt and does not consume the later exact release.
      if (!state.held || !state.response || heldRaw === null) return null;
      state.forwardAttempt = { id: state.response.id, rawSHA256: state.response.rawSHA256,
        bytes: state.response.bytes, attemptedAt: Date.now() };
      const raw = heldRaw; heldRaw = null; state.held = false;
      // Playwright send() returns void and hides delivery failure. This is only
      // an attempt; the runner must observe the original frame at the viewer.
      try { originalRoute.send(raw); }
      catch (error) { noteError("Forwarding the original response threw"); throw error; }
      return structuredClone(state.forwardAttempt);
    }
  };
}
