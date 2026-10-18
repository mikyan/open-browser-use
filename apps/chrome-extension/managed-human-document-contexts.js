const fail = () => new Error("OBU_HUMAN_DIALOG_UNSUPPORTED: original child document context is unavailable");
const text = (value, limit) => typeof value === "string" && value.length > 0 && value.length <= limit;
function origin(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value ? value : null;
  } catch { return null; }
}

// One original attachment owns this ledger. Page.Frame.securityOrigin is
// derived from loader URLs; only native default contexts prove actual origins.
// Native unique IDs remain tombstoned until the whole attachment is discarded.
export class ManagedHumanDocumentContexts {
  constructor() {
    this.records = new Map(); this.current = new Map(); this.alive = new Set();
    this.bindings = new WeakMap(); this.snapshots = new WeakSet(); this.proofs = new WeakSet(); this.identities = new WeakMap();
    this.revision = 0; this.blocked = false;
  }
  checkpoint() { return this.revision; }
  // Identity-only fences do not grant dialog origin or document authority.
  // Capture before preparation reads and assert the same fence afterwards;
  // a first new default context is a change too, isolated worlds are not.
  captureIdentity() {
    if (this.blocked) throw fail();
    const fence = Object.freeze({}); this.identities.set(fence, new Map(this.current)); return fence;
  }
  assertIdentity(fence) {
    const contexts = this.identities.get(fence);
    if (!contexts || this.blocked || contexts.size !== this.current.size) throw fail();
    for (const [frameId, context] of contexts) if (this.current.get(frameId) !== context ||
        !this.alive.has(context) || this.records.get(context.uniqueId) !== context) throw fail();
  }
  retire(context) {
    this.alive.delete(context);
    if (this.current.get(context.frameId) === context) this.current.delete(context.frameId);
  }
  observe(method, params = {}) {
    if (!["Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared",
      "Page.frameStartedNavigating", "Page.frameNavigated", "Page.documentOpened", "Page.navigatedWithinDocument",
      "Page.frameAttached", "Page.frameDetached"].includes(method)) return false;
    if (++this.revision >= Number.MAX_SAFE_INTEGER) this.blocked = true;
    if (method === "Runtime.executionContextCreated") {
      const value = params.context, frameId = value?.auxData?.frameId;
      if (value?.auxData?.isDefault !== true) return true;
      if (!text(frameId, 256) || !Number.isSafeInteger(value.id) || !text(value.uniqueId, 256) ||
          typeof value.origin !== "string" || value.origin.length > 8192) {
        this.blocked = true; return true;
      }
      if (this.records.has(value.uniqueId)) return true;
      const previous = this.current.get(frameId); if (previous) this.retire(previous);
      if (this.blocked || this.records.size >= 4096) { this.blocked = true; return true; }
      const context = Object.freeze({ id: value.id, uniqueId: value.uniqueId, frameId, origin: value.origin, token: Object.freeze({}) });
      this.records.set(context.uniqueId, context); this.current.set(frameId, context); this.alive.add(context);
    } else if (method === "Runtime.executionContextDestroyed") {
      for (const context of this.alive) if (context.id === params.executionContextId &&
          (!params.executionContextUniqueId || context.uniqueId === params.executionContextUniqueId)) this.retire(context);
    } else if (method === "Runtime.executionContextsCleared") {
      for (const context of this.alive) this.retire(context);
    } else if (!["Page.navigatedWithinDocument", "Page.frameStartedNavigating"].includes(method)) {
      const frameId = params.frame?.id ?? params.frameId;
      const root = ["Page.frameNavigated", "Page.documentOpened"].includes(method) && !params.frame?.parentId;
      for (const context of this.alive) {
        const binding = this.bindings.get(context);
        // Unbound descendants cannot be identified across a replacement. They
        // must never be attached to a later loader merely by matching frameId.
        if (root || !binding || context.frameId === frameId || binding.ancestors.includes(frameId)) this.retire(context);
      }
    }
    return true;
  }
  snapshot(document, revision) {
    if (this.blocked || revision !== this.revision) return null;
    const frames = JSON.parse(document), rows = new Map(frames.map(frame => [frame[0], frame]));
    const contexts = new Map();
    for (const frame of frames) {
      const context = this.current.get(frame[0]);
      if (!context || !this.alive.has(context)) continue;
      const existing = this.bindings.get(context);
      if (existing && (existing.frameId !== frame[0] || existing.parent !== frame[1] || existing.loaderId !== frame[2])) {
        this.retire(context); continue;
      }
      if (!existing) {
        const ancestors = []; let parent = rows.get(frame[1]);
        while (parent) { ancestors.push(parent[0]); parent = rows.get(parent[1]); }
        this.bindings.set(context, Object.freeze({ frameId: frame[0], parent: frame[1], loaderId: frame[2], token: context.token,
          ancestors: Object.freeze(ancestors) }));
      }
      contexts.set(frame[0], context);
    }
    const snapshot = Object.freeze({ document, rows, contexts }); this.snapshots.add(snapshot); return snapshot;
  }
  capture(snapshot, frameId) {
    if (!snapshot || !this.snapshots.has(snapshot) || this.blocked) throw fail();
    const path = []; let frame = snapshot.rows.get(frameId);
    if (!frame) throw fail();
    while (frame) {
      const context = snapshot.contexts.get(frame[0]);
      if (!context) throw fail();
      path.push(Object.freeze({ context, binding: this.bindings.get(context) }));
      frame = snapshot.rows.get(frame[1]);
    }
    const actualOrigin = origin(path.at(-1).context.origin);
    if (!actualOrigin || path.some(item => item.context.origin !== actualOrigin)) throw fail();
    const proof = Object.freeze({ path: Object.freeze(path) }); this.proofs.add(proof); this.assert(proof); return proof;
  }
  // A document graph owns cross-session ancestry. This narrower proof grants
  // one original frame only; it never infers ancestors or changes capture's
  // existing same-origin path contract.
  captureFrame(snapshot, frameId) {
    if (!snapshot || !this.snapshots.has(snapshot) || this.blocked) throw fail();
    const context = snapshot.contexts.get(frameId), actualOrigin = origin(context?.origin);
    if (!context || !actualOrigin) throw fail();
    const proof = Object.freeze({ path: Object.freeze([Object.freeze({ context, binding: this.bindings.get(context) })]), actualOrigin });
    this.proofs.add(proof); this.assert(proof); return proof;
  }
  assert(proof) {
    if (!proof || !this.proofs.has(proof) || this.blocked) throw fail();
    for (const { context, binding } of proof.path) if (!this.alive.has(context) || this.current.get(context.frameId) !== context ||
        this.records.get(context.uniqueId) !== context || this.bindings.get(context) !== binding || binding.token !== context.token) throw fail();
  }
}
