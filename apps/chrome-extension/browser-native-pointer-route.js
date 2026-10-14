import { createFrameGeometryRuntime } from "./browser-frame-geometry.js";
import { createNativePointerFeedback } from "./browser-native-pointer-feedback.js";

const geometry = createFrameGeometryRuntime();
const unavailable = () => new Error("OBU_POINTER_ROUTE_UNAVAILABLE: original native pointer route is unavailable");
const objectId = value => typeof value === "string" && value.length > 0 && value.length <= 4096;

// Each candidate owns its original root groups and independent frame leases.
// Input admission, user deadlines and publication remain in the backend; these
// optional reads never attach/migrate a root or enable a protocol domain.
export function createNativePointerRoute({ scope, x, y, check, cleanupAuthority, cleanupExclusive = cleanupAuthority, destroyed, native, registry }) {
  if (!Number.isSafeInteger(scope?.tabId) || scope.tabId < 0 || !scope.attachment ||
      ![check, cleanupAuthority, cleanupExclusive, destroyed, native?.send].every(value => typeof value === "function") ||
      !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  try { check(); } catch { return undefined; }
  const target = Object.freeze({ tabId: scope.tabId });
  const groups = new Map(), children = new Map();
  let rootTargetId, pending, closing = false, cleanupPending;
  const original = () => { if (closing) throw unavailable(); check(); };
  const root = value => value?.tabId === target.tabId && Object.keys(value).length === 1;
  const child = value => {
    const lease = value?.targetId && Object.keys(value).length === 1 && children.get(value.targetId);
    if (!lease) throw unavailable();
    return lease;
  };
  const releaseGroup = group => {
    if (group.attempt) return group.attempt;
    group.closing = true;
    group.attempt = (async () => {
      await Promise.allSettled([...group.pending]);
      if (destroyed()) { group.retired = true; return; }
      try {
        cleanupAuthority();
        await native.send(target, "Runtime.releaseObjectGroup", { objectGroup: group.name });
        group.released = true;
      } catch (failure) {
        // A native root cancellation can precede optional object cleanup. The
        // original opaque target still identifies that same extension client:
        // Chromium FindClientHost compares AgentHost + extension, not whether
        // attach originally used tabId or targetId. Never query a successor by
        // numeric tab ID. Absence is cleanup evidence, not a release ACK.
        // https://github.com/chromium/chromium/blob/156.0.8078.4/chrome/browser/extensions/api/debugger/debugger_api.cc#L963
        cleanupExclusive();
        if (!objectId(rootTargetId)) throw failure;
        let absent = false;
        try { await native.send({ targetId: rootTargetId }, "Target.getTargetInfo", {}); }
        catch (error) {
          group.absenceError = error;
          absent = error?.message === `Debugger is not attached to the target with id: ${rootTargetId}.` ||
            error?.message === `No target with given id ${rootTargetId}.`;
        }
        cleanupExclusive();
        if (!absent) throw failure;
        group.retired = true;
      }
    })();
    group.attempt.then(() => { group.settled = true; }, () => { group.settled = true; group.failed = true; });
    return group.attempt;
  };
  const reader = createNativePointerFeedback({ target, x, y, geometry, adapter: {
    check: original,
    send: (destination, method, params) => {
      original();
      if (!root(destination)) return child(destination).send(method, params);
      const group = params.objectGroup === undefined ? null : groups.get(params.objectGroup);
      if (params.objectGroup !== undefined && (!group || group.closing)) throw unavailable();
      const operation = native.send(target, method, params);
      if (group) {
        group.pending.add(operation);
        operation.then(() => group.pending.delete(operation), () => group.pending.delete(operation));
      }
      return operation.then(result => {
        if (method === "Page.getFrameTree" && result?.frameTree?.frame?.id !== rootTargetId) throw unavailable();
        return result;
      });
    },
    prepareGroup: (destination, name) => {
      original();
      if (!root(destination)) return child(destination).prepareGroup(name);
      if (groups.has(name)) throw unavailable();
      const group = { name, pending: new Set(), attempt: null, released: false, retired: false, settled: false, failed: false, closing: false };
      groups.set(name, group);
      return { releaseGroup: () => releaseGroup(group), close: () => {
        if (!group.released && !group.retired) throw unavailable();
      } };
    },
    acquireChild: ({ parentTarget, parentFrameId, frameId }) => {
      original();
      if (!objectId(rootTargetId) || !registry || children.has(frameId)) return null;
      if (!root(parentTarget)) child(parentTarget).check();
      const lease = registry.acquire({ root: { tabId: target.tabId, attachment: scope.attachment, rootTargetId, check: original },
        targetId: frameId, parentFrameId });
      if (lease) children.set(frameId, lease);
      return lease;
    }
  } });
  if (!reader) return undefined;
  const read = checkScope => {
    if (pending || closing) throw unavailable();
    pending = (async () => {
      original(); checkScope();
      // This read proves the native root without depending on a frame/target ID
      // coincidence, caller parameters or the mutable target inventory.
      const info = (await native.send(target, "Target.getTargetInfo", {}))?.targetInfo;
      original(); checkScope();
      if (info?.type !== "page" || !objectId(info.targetId)) throw unavailable();
      rootTargetId = info.targetId;
      return reader.read(checkScope);
    })();
    return pending;
  };
  const cleanup = () => {
    if (cleanupPending) return cleanupPending;
    closing = true;
    cleanupPending = (async () => {
      // Include the root identity query and any subsequent original reads.
      // Closing during that first query cannot allow a late allocation.
      try { await pending; } catch {}
      await reader.cleanup();
    })().catch(error => { cleanupPending = undefined; throw error; });
    return cleanupPending;
  };
  const retryCleanup = () => {
    // Explicit recovery only resets settled failures. Retain the original IDs;
    // never sweep leases from another read or a successor attachment.
    for (const group of groups.values()) if (group.failed && group.settled) {
      group.attempt = null; group.failed = false; group.settled = false;
    }
    for (const lease of children.values()) registry.prepareCleanupRetry(lease.leaseId);
    return cleanup();
  };
  return { target, check, read, cleanup, retryCleanup, decode: value => value, schedule: "latest" };
}
