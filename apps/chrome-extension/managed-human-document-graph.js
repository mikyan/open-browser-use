import { ManagedHumanDocumentContexts } from "./managed-human-document-contexts.js";
import { ManagedHumanDocumentEvents, humanDialogSource } from "./managed-human-document-events.js";

const fail = () => new Error("OBU_HUMAN_DIALOG_UNSUPPORTED: original remote document graph is unavailable");
const cancelled = new Error("OBU_HUMAN_DIALOG_STALE: original graph setup withdrawn before native dispatch");
const text = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const AUTO_ATTACH = Object.freeze({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
  filter: Object.freeze([Object.freeze({ type: "iframe", exclude: false })]) });
const FRAME_EVENTS = new Set(["Page.frameStartedNavigating", "Page.frameNavigated", "Page.documentOpened",
  "Page.navigatedWithinDocument", "Page.frameAttached", "Page.frameDetached"]);

function readTree(value, session) {
  const rows = [], ids = new Set();
  const visit = (node, parent, depth) => {
    const frame = node?.frame;
    if (depth > 1000 || rows.length >= 1000 || !frame || !text(frame.id) || !text(frame.loaderId) ||
        typeof frame.url !== "string" || frame.url.length > 8192 ||
        (frame.urlFragment !== undefined && typeof frame.urlFragment !== "string") ||
        (frame.securityOrigin !== undefined && typeof frame.securityOrigin !== "string") || ids.has(frame.id)) throw fail();
    if (frame.parentId !== undefined && frame.parentId !== parent) throw fail();
    if (parent !== null && !text(parent)) throw fail();
    ids.add(frame.id);
    rows.push(Object.freeze([frame.id, parent, frame.loaderId, frame.url, frame.urlFragment ?? "", frame.securityOrigin ?? null]));
    if (node.childFrames !== undefined && !Array.isArray(node.childFrames)) throw fail();
    for (const child of node.childFrames ?? []) visit(child, frame.id, depth + 1);
  };
  const root = value?.frameTree?.frame;
  const parent = session.id === undefined ? null : root?.parentId;
  if (session.id !== undefined && (root?.id !== session.targetId || !text(parent) ||
      (session.parentFrameId !== undefined && session.parentFrameId !== parent))) throw fail();
  visit(value?.frameTree, parent, 0);
  return Object.freeze({ rows: Object.freeze(rows), document: JSON.stringify(rows) });
}

// Owns only flat iframe sessions born under one current human attachment.
// The caller verifies the outer root debuggee envelope before observe(); child
// IDs never select an independent chrome.debugger attachment. send must invoke
// its synchronous admission check immediately before actual native dispatch.
export class ManagedHumanDocumentGraph {
  constructor({ send, check, onFailure = () => {}, onChange = () => {}, prepareSession = async () => {}, assertCandidate = () => { throw fail(); } }) {
    Object.assign(this, { send, check, onFailure, onChange, prepareSession });
    this.sessions = new Map(); this.seen = new Set(); this.pending = new Set(); this.commands = new Set();
    this.snapshots = new WeakMap(); this.proofs = new WeakMap(); this.identities = new WeakMap();
    this.preparationIdentities = new WeakMap();
    this.rootHints = new WeakMap();
    this.revision = 0; this.structure = 0; this.contextIdentities = 0; this.revoked = false; this.ended = false;
    this.failure = null; this.started = false; this.starting = null;
    this.root = this.createSession(undefined, null, null);
    this.events = new ManagedHumanDocumentEvents({ root: this.root, current: session => this.current(session),
      check: () => this.assertActive(), assertCandidate });
  }
  createSession(id, parent, targetId, parentFrameId) {
    const session = { id, parent, targetId, parentFrameId, token: Object.freeze({}), alive: true, eligible: true,
      contexts: new ManagedHumanDocumentContexts(), resources: new Map(), destroyedContexts: new WeakSet(), ready: id === undefined };
    this.sessions.set(id, session); this.seen.add(id); return session;
  }
  owns(id) { return !this.ended && this.sessions.get(id)?.alive === true; }
  current(session) { return !this.ended && session.alive && this.sessions.get(session.id) === session; }
  assertActive() {
    this.check();
    if (this.revoked || this.ended || this.failure) throw fail();
  }
  invalidate(error = fail()) {
    if (this.failure) return;
    this.failure = error;
    try { this.onFailure(error); } catch { /* The original failure remains owned. */ }
  }
  advance(structural = false) {
    if (++this.revision >= Number.MAX_SAFE_INTEGER || structural && ++this.structure >= Number.MAX_SAFE_INTEGER) this.invalidate();
  }
  change(session, method) {
    try { this.onChange({ sessionId: session.id, method, frameId: session.targetId, root: false }); }
    catch (error) { this.invalidate(error); }
  }
  retire(session) {
    if (!session.alive) return;
    session.alive = false;
    session.contexts.observe("Runtime.executionContextsCleared");
    for (const child of this.sessions.values()) if (child.parent === session) this.retire(child);
    // IDs stay tombstoned for the original attachment, never reassigned.
  }
  clearDocuments(session) {
    // The native session still belongs to cleanup, but a late first Created
    // event on another session cannot prove migration to a new parent loader.
    session.eligible = false;
    session.contexts.observe("Runtime.executionContextsCleared");
    for (const child of this.sessions.values()) if (child.parent === session && child.alive) this.clearDocuments(child);
  }
  observe(id, method, params = {}) {
    const session = this.sessions.get(id);
    if (!session || !this.current(session)) return false;
    if (!params || typeof params !== "object" || Array.isArray(params)) { this.invalidate(); return false; }
    if (method === "Target.attachedToTarget") {
      const childId = params.sessionId, target = params.targetInfo;
      this.advance(true);
      this.events.advance();
      if (!text(childId) || target?.type !== "iframe" || !text(target?.targetId) || params.waitingForDebugger === true ||
          (target.parentFrameId !== undefined && !text(target.parentFrameId)) || this.seen.has(childId) ||
          this.seen.size >= 4096 || [...this.sessions.values()].filter(value => value.alive).length >= 1000 ||
          [...this.sessions.values()].some(value => value.alive && value.targetId === target.targetId)) {
        this.invalidate(); return true;
      }
      const child = this.createSession(childId, session, target.targetId, target.parentFrameId);
      // Even after revoke, retain exact cleanup ownership of a late automatic
      // attachment. Do not enable it or publish any new document authority.
      if (!this.revoked && !this.failure) this.setup(child);
      this.change(child, method); return true;
    }
    if (method === "Target.detachedFromTarget") {
      const child = this.sessions.get(params.sessionId);
      if (!child || child.parent !== session || !this.current(child) ||
          (params.targetId !== undefined && params.targetId !== child.targetId)) return false;
      this.advance(true); this.events.advance(); this.retire(child); this.change(child, method); return true;
    }
    const value = params.context;
    if (method === "Runtime.executionContextCreated" && value?.auxData?.isDefault === true &&
        !session.contexts.records.has(value.uniqueId) && this.contextIdentities >= 4096) {
      this.advance(); this.invalidate(); return true;
    }
    const count = session.contexts.records.size;
    const observed = session.contexts.observe(method, params);
    // Resource lifetime is deliberately independent of the authority ledger:
    // parent navigation may conservatively retire a child proof while its
    // original isolated objects still require real cleanup in that session.
    if (method === "Runtime.executionContextCreated" && value?.auxData?.isDefault === true) {
      const context = session.contexts.records.get(value.uniqueId);
      if (context && !session.resources.has(context.uniqueId)) session.resources.set(context.uniqueId, context);
    } else if (method === "Runtime.executionContextsCleared") {
      for (const context of session.resources.values()) session.destroyedContexts.add(context);
    } else if (method === "Runtime.executionContextDestroyed") {
      const matches = [...session.resources.values()].filter(context => context.id === params.executionContextId &&
        (!params.executionContextUniqueId || context.uniqueId === params.executionContextUniqueId));
      if (params.executionContextUniqueId || matches.length === 1)
        for (const context of matches) session.destroyedContexts.add(context);
    }
    this.contextIdentities += session.contexts.records.size - count;
    if (observed) {
      this.advance(FRAME_EVENTS.has(method));
      // A parent document replacement retires descendant document authority,
      // retaining native session ownership until actual detach.
      if (FRAME_EVENTS.has(method) && !["Page.navigatedWithinDocument", "Page.frameStartedNavigating"].includes(method)) {
        const frameId = params.frame?.id ?? params.frameId;
        const wholeSession = ["Page.frameNavigated", "Page.documentOpened"].includes(method) &&
          (session.id === undefined ? !params.frame?.parentId : params.frame?.id === session.targetId);
        for (const child of this.sessions.values()) if (child.parent === session && child.alive &&
            (wholeSession || child.boundAncestors?.includes(frameId) || child.parentFrameId === frameId || !child.boundAncestors)) this.clearDocuments(child);
      }
      try { this.events.observe(session, method, params); }
      catch { this.events.blocked = true; }
    }
    return observed;
  }
  command(session, method, params) {
    const admission = () => {
      if (this.revoked || this.ended || !this.current(session)) throw cancelled;
      this.assertActive();
    };
    admission();
    const actual = Promise.resolve(this.send(session.id, method, params, admission));
    this.commands.add(actual);
    const settled = () => this.commands.delete(actual);
    actual.then(settled, settled); return actual;
  }
  setup(session) {
    const operation = (async () => {
      await this.command(session, "Page.enable");
      await this.prepareSession(session.id, () => { this.assertActive(); if (!this.current(session)) throw cancelled; });
      await this.command(session, "Runtime.enable");
      await this.command(session, "Target.setAutoAttach", AUTO_ATTACH);
      if (this.current(session) && !this.revoked && !this.failure) session.ready = true;
    })();
    this.pending.add(operation);
    operation.then(() => this.pending.delete(operation), error => {
      this.pending.delete(operation);
      if (error !== cancelled) this.invalidate(error);
    });
    return operation;
  }
  start(initialCandidate) {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.assertActive();
      // The owner calls start only after this attachment's root Page and
      // Runtime enable ACKs, with its lifecycle listener already installed.
      this.events.reserve(initialCandidate);
      this.events.rootReady = true;
      await this.prepareSession(undefined, () => this.assertActive());
      await this.command(this.root, "Target.setAutoAttach", AUTO_ATTACH);
      await this.drain(); this.assertActive(); this.started = true;
    })();
    this.starting.catch(error => { if (error !== cancelled) this.invalidate(error); });
    return this.starting;
  }
  async drain() {
    // Recursive attachment may append setup while its parent's enable awaits.
    // A cancelled public caller never removes the actual setup Promise.
    while (this.pending.size || this.commands.size) await Promise.allSettled([...this.pending, ...this.commands]);
  }
  async snapshot(candidate) {
    this.assertActive();
    if (!this.started) throw fail();
    await this.drain(); this.assertActive();
    const revision = this.revision, structure = this.structure;
    const sessions = [...this.sessions.values()].filter(session => this.current(session));
    if (sessions.some(session => !session.ready)) return null;
    const contexts = new Map(sessions.map(session => [session, session.contexts.checkpoint()]));
    const read = async () => {
      const trees = new Map();
      for (const session of sessions) {
        const value = await this.command(session, "Page.getFrameTree");
        this.assertActive();
        if (this.revision !== revision || !this.current(session)) return null;
        trees.set(session, readTree(value, session));
      }
      return trees;
    };
    const first = await read(); if (!first) return null;
    const second = await read(); if (!second || this.revision !== revision) return null;
    const frames = new Map(), ledgers = new Map();
    for (const session of sessions) {
      const tree = second.get(session);
      if (tree.document !== first.get(session).document) return null;
      for (const row of tree.rows) {
        if (frames.has(row[0]) || frames.size >= 1000) throw fail();
        frames.set(row[0], Object.freeze({ session, row }));
      }
    }
    const rootId = second.get(this.root).rows[0][0];
    for (const session of sessions) {
      const tree = second.get(session);
      if (session !== this.root) {
        const parent = frames.get(tree.rows[0][1]);
        if (!parent || parent.session !== session.parent || !this.current(session.parent)) throw fail();
      }
      for (const row of tree.rows) {
        const seen = new Set(); let current = frames.get(row[0]);
        while (current.row[1] !== null) {
          if (seen.has(current.row[0])) throw fail();
          seen.add(current.row[0]); current = frames.get(current.row[1]);
          if (!current) throw fail();
        }
        if (current.row[0] !== rootId) throw fail();
      }
      if (session.eligible && session.lineage?.some(ancestor => {
        const current = frames.get(ancestor.frameId);
        return !current || current.session !== ancestor.session || current.row[1] !== ancestor.parent || current.row[2] !== ancestor.loaderId;
      })) this.clearDocuments(session);
      const snapshot = session.contexts.snapshot(tree.document, contexts.get(session));
      if (!snapshot) return null;
      ledgers.set(session, snapshot);
    }
    if (this.revision !== revision) return null;
    for (const session of sessions) if (session !== this.root) {
      const ancestors = [], lineage = []; let row = frames.get(second.get(session).rows[0][1]);
      while (row) {
        ancestors.push(row.row[0]); lineage.push(Object.freeze({ session: row.session, frameId: row.row[0], parent: row.row[1], loaderId: row.row[2] }));
        row = frames.get(row.row[1]);
      }
      session.boundAncestors = Object.freeze(ancestors);
      session.lineage ??= Object.freeze(lineage);
    }
    const snapshot = Object.freeze({ rootDocument: second.get(this.root).document });
    this.snapshots.set(snapshot, { frames, ledgers, structure });
    // The event-only readiness route is stricter about cold/ordered witnesses.
    // Missing readiness evidence must not downgrade the existing active graph.
    try { this.events.seed(frames, candidate); }
    catch { this.events.blocked = true; }
    return snapshot;
  }
  checkpointReadiness(opening) {
    this.assertActive();
    if (!this.started) throw fail();
    return this.events.checkpoint(opening);
  }
  captureReadiness(fence, candidate, opening) { this.assertActive(); return this.events.capture(fence, candidate, opening); }
  assertReadiness(proof) { this.assertActive(); this.events.assert(proof); }
  checkpointRootDocumentHint(expected) {
    this.assertActive();
    const root = this.events.checkpointRootDocumentHint(expected);
    if (!this.started || !root) return null;
    const ticket = Object.freeze({});
    this.rootHints.set(ticket, { root, identity: this.captureIdentity() }); return ticket;
  }
  assertRootDocumentHint(ticket, actual) {
    this.assertActive();
    const saved = this.rootHints.get(ticket);
    if (!saved) throw fail();
    this.assertIdentity(saved.identity); this.events.assertRootDocumentHint(saved.root, actual);
  }
  checkpointPreparationIdentity() {
    this.assertActive();
    const gaps = this.events.checkpointPreparation(), ticket = Object.freeze({});
    // No known committed gap means exactly the old strict contract, including
    // cold/partial snapshots. It cannot be repaired by an unobserved document.
    const saved = gaps ? { gaps, structure: this.structure,
      path: [...this.sessions.values()].filter(session => this.current(session))
        .map(session => ({ session, contexts: new Map(session.contexts.current) })) } : { identity: this.captureIdentity() };
    this.preparationIdentities.set(ticket, saved);
    this.capturePreparationIdentity(ticket); return ticket;
  }
  capturePreparationIdentity(ticket) {
    this.assertActive();
    const saved = this.preparationIdentities.get(ticket);
    if (!saved) throw fail();
    if (saved.identity) { this.assertIdentity(saved.identity); return saved.identity; }
    if (saved.structure !== this.structure) throw fail();
    const gaps = this.events.preparationContexts(saved.gaps);
    let waiting = false;
    for (const { session, contexts } of saved.path) {
      if (!this.current(session) || session.contexts.blocked) throw fail();
      const expected = new Map(contexts);
      for (const [frameId, context] of gaps.get(session) ?? []) {
        if (expected.has(frameId)) throw fail();
        if (context) expected.set(frameId, context); else waiting = true;
      }
      if (expected.size !== session.contexts.current.size) throw fail();
      for (const [frameId, context] of expected) if (session.contexts.current.get(frameId) !== context ||
          !session.contexts.alive.has(context) || session.contexts.records.get(context.uniqueId) !== context) throw fail();
    }
    if (waiting) return null;
    // The first complete set is fixed synchronously. Subsequent calls return
    // that same strict fence; they never add another context to it.
    saved.identity = this.captureIdentity(); return saved.identity;
  }
  captureIdentity() {
    this.assertActive();
    const path = [...this.sessions.values()].filter(session => this.current(session))
      .map(session => Object.freeze({ session, fence: session.contexts.captureIdentity() }));
    const fence = Object.freeze({});
    this.identities.set(fence, { structure: this.structure, path: Object.freeze(path) }); return fence;
  }
  assertIdentity(fence) {
    this.assertActive();
    const original = this.identities.get(fence);
    if (!original || original.structure !== this.structure) throw fail();
    for (const { session, fence: identity } of original.path) {
      if (!this.current(session)) throw fail();
      session.contexts.assertIdentity(identity);
    }
  }
  capture(snapshot, { frameId, url } = {}) {
    this.assertActive();
    const saved = this.snapshots.get(snapshot), emitter = saved?.frames.get(frameId);
    if (!saved || saved.structure !== this.structure || !emitter || typeof url !== "string" || url !== emitter.row[3] + emitter.row[4]) throw fail();
    const path = []; let frame = emitter;
    while (frame) {
      const { session, row } = frame;
      if (!this.current(session) || !session.eligible) throw fail();
      path.push(Object.freeze({ session, row, proof: session.contexts.captureFrame(saved.ledgers.get(session), row[0]) }));
      frame = saved.frames.get(row[1]);
    }
    for (let index = 0; index < path.length; index++) {
      const { row, proof: context } = path[index];
      let parsed; try { parsed = new URL(row[3]); } catch { throw fail(); }
      if (["http:", "https:"].includes(parsed.protocol)) {
        if (parsed.origin !== context.actualOrigin) throw fail();
      } else if (!["about:blank", "about:srcdoc"].includes(row[3]) ||
          !path[index + 1] || path[index + 1].proof.actualOrigin !== context.actualOrigin) throw fail();
    }
    const actualOrigins = Object.freeze(path.map(value => value.proof.actualOrigin));
    const proof = Object.freeze({ actualOrigins, source: humanDialogSource(actualOrigins) });
    this.proofs.set(proof, { path, structure: saved.structure }); this.assert(proof); return proof;
  }
  assert(proof) {
    this.assertActive();
    const saved = this.proofs.get(proof);
    if (!saved || saved.structure !== this.structure) throw fail();
    for (const { session, proof: context } of saved.path) {
      if (!this.current(session) || !session.eligible) throw fail();
      session.contexts.assert(context);
    }
  }
  captureSource(snapshot, { sessionId, frameId } = {}) {
    const emitter = this.snapshots.get(snapshot)?.frames.get(frameId);
    if (!emitter || emitter.session.id !== sessionId) throw fail();
    const proof = this.capture(snapshot, { frameId, url: emitter.row[3] + emitter.row[4] });
    return proof;
  }
  sourceAddressable(proof) {
    // Cleanup needs the original remote objects, not renewed user authority or
    // a new graph snapshot. A topology change elsewhere does not erase them.
    const emitter = this.proofs.get(proof)?.path[0];
    return Boolean(emitter && this.current(emitter.session) &&
      emitter.proof.path.every(({ context }) => !emitter.session.destroyedContexts.has(context)));
  }
  sourceRetirement(proof) {
    const emitter = this.proofs.get(proof)?.path[0];
    if (!emitter) throw fail();
    if (emitter.proof.path.some(({ context }) => emitter.session.destroyedContexts.has(context))) return "document";
    return this.current(emitter.session) ? null : "session";
  }
  revoke() { this.revoked = true; }
  detached() {
    // Only the owner's actual root-detach ACK or confirmed original target
    // destruction calls this. It is not an answer/input acknowledgement.
    this.revoked = true; this.ended = true;
    for (const session of this.sessions.values()) this.retire(session);
  }
}
