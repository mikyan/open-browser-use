const fail = () => new Error("OBU_HUMAN_DIALOG_UNSUPPORTED: original event document is not proved");
const text = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const origin = value => {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && url.origin === value ? value : null; }
  catch { return null; }
};
// This display value is made only after the original native context path is
// proved. It carries no target, session or permission authority to the viewer.
export function humanDialogSource(actualOrigins) {
  const emitter = actualOrigins[0];
  if (!origin(emitter) || new TextEncoder().encode(emitter).length > 2048) throw fail();
  return Object.freeze({ origin: emitter, frame: actualOrigins.length === 1 ? "top-level" : "child" });
}
const rowFor = frame => {
  if (!frame || !text(frame.id) || !text(frame.loaderId) ||
      frame.parentId !== undefined && !text(frame.parentId) || typeof frame.url !== "string" || frame.url.length > 8192 ||
      frame.urlFragment !== undefined && (typeof frame.urlFragment !== "string" || frame.urlFragment.length > 8192) ||
      frame.securityOrigin !== undefined && typeof frame.securityOrigin !== "string") throw fail();
  return Object.freeze([frame.id, frame.parentId ?? null, frame.loaderId, frame.url, frame.urlFragment ?? "", frame.securityOrigin ?? null]);
};
const hintIdentity = value => {
  if (!value || typeof value !== "object" || Array.isArray(value) || !text(value.documentId) ||
      typeof value.url !== "string" || !value.url || value.url.length > 8192) throw fail();
  return Object.freeze({ documentId: value.documentId, url: value.url });
};

// This is an internal seam of the owned document graph, not a second native
// observer. Sessions and context objects are supplied only by that graph. No
// renderer query is issued here, and a later same-URL document cannot refill a
// fence captured at an original Opening.
export class ManagedHumanDocumentEvents {
  constructor({ root, current, check, assertCandidate }) {
    Object.assign(this, { root, current, check, assertCandidate });
    this.frames = new Map(); this.seen = new Map(); this.pending = new Map();
    this.fences = new WeakMap(); this.proofs = new WeakMap(); this.bindings = new WeakMap();
    this.rootHints = new WeakMap();
    this.preparations = new WeakMap(); this.preparationVersion = 0;
    this.rootDocuments = new Map(); this.revision = 0; this.identities = 0;
    this.rootReady = false; this.blocked = false;
  }
  advance() { if (++this.revision >= Number.MAX_SAFE_INTEGER) this.blocked = true; }
  retirePreparation() { if (++this.preparationVersion >= Number.MAX_SAFE_INTEGER) this.blocked = true; }
  active() { this.check(); if (this.blocked) throw fail(); }
  ready(session) { return this.current(session) && session.eligible && (session === this.root ? this.rootReady : session.ready); }
  reserve(candidate) {
    if (candidate === undefined) return;
    if (!text(candidate?.documentId)) throw fail();
    // Before the first native tree, the initial browser identity is known but
    // has no native loader mapping. An observed new commit may not adopt it.
    this.rootDocuments.set(candidate.documentId, null);
  }
  sessionFrames(session) {
    let rows = this.frames.get(session);
    if (!rows) { rows = new Map(); this.frames.set(session, rows); }
    return rows;
  }
  parent(session, row) {
    if (row[1] === null) return session === this.root ? null : undefined;
    const local = this.frames.get(session)?.get(row[1]);
    if (local) return local;
    if (session === this.root || row[0] !== session.targetId ||
        session.parentFrameId !== undefined && session.parentFrameId !== row[1]) return undefined;
    return this.frames.get(session.parent)?.get(row[1]);
  }
  retire(session, frameId, whole = false) {
    const retired = new Set();
    for (const rows of this.frames.values()) for (const record of rows.values())
      if (record.session === session && (whole || record.row[0] === frameId)) retired.add(record);
    let changed;
    do {
      changed = false;
      for (const rows of this.frames.values()) for (const record of rows.values())
        if (record.parent && retired.has(record.parent) && !retired.has(record)) { retired.add(record); changed = true; }
    } while (changed);
    for (const record of retired) if (this.frames.get(record.session)?.get(record.row[0]) === record)
      this.frames.get(record.session).delete(record.row[0]);
  }
  remember(session, row, context, source) {
    let history = this.seen.get(session);
    if (!history) { history = new Map(); this.seen.set(session, history); }
    let loaders = history.get(row[0]);
    if (!loaders) { loaders = new Map(); history.set(row[0], loaders); }
    const old = this.frames.get(session)?.get(row[0]);
    if (old && old.row[2] === row[2] && JSON.stringify(old.row) === JSON.stringify(row) &&
        (!context || old.context === context)) return old;
    // A loader identity can only refer to its one original document record.
    // Tombstones are bounded, retained across replacement and never recycled.
    if (loaders.has(row[2])) return null;
    if (++this.identities > 4096) { this.blocked = true; throw fail(); }
    const parent = this.parent(session, row);
    const record = { session, row, parent, context, source, eventCommit: source === "event", usable: this.ready(session) && parent !== undefined };
    loaders.set(row[2], record); this.sessionFrames(session).set(row[0], record);
    return record;
  }
  observe(session, method, params) {
    if (method === "Runtime.executionContextCreated") {
      if (params.context?.auxData?.isDefault !== true) return;
      this.advance();
      const record = this.frames.get(session)?.get(params.context.auxData.frameId);
      const context = session.contexts.current.get(params.context.auxData.frameId);
      // Only the first fresh default context after this original commit may
      // complete an event record. Replacement requires another actual commit.
      if (record && record.source === "event" && !record.context && record.usable && this.ready(session) &&
          context?.uniqueId === params.context.uniqueId) record.context = context;
      return;
    }
    if (["Runtime.executionContextDestroyed", "Runtime.executionContextsCleared"].includes(method)) {
      this.retirePreparation();
      this.advance(); return;
    }
    if (method === "Page.frameStartedNavigating") {
      this.retirePreparation();
      if (!text(params.frameId) || !text(params.loaderId)) throw fail();
      this.advance(); this.retire(session, params.frameId);
      this.pending.set(session, this.pending.get(session) ?? new Map());
      if (!this.pending.get(session).has(params.frameId) && this.pending.get(session).size >= 1000) { this.blocked = true; throw fail(); }
      this.pending.get(session).set(params.frameId, { loaderId: params.loaderId, ready: this.ready(session) });
      if ([...this.pending.values()].reduce((count, pending) => count + pending.size, 0) > 1000) { this.blocked = true; throw fail(); }
      return;
    }
    if (["Page.frameNavigated", "Page.documentOpened"].includes(method)) {
      this.retirePreparation();
      this.advance();
      const row = rowFor(params.frame), whole = session === this.root ? row[1] === null : row[0] === session.targetId;
      this.retire(session, row[0], whole);
      const started = this.pending.get(session)?.get(row[0]);
      this.pending.get(session)?.delete(row[0]);
      // Without an observed, already-enabled start/commit pair a cold event
      // cannot stand in for the existing double-tree snapshot bootstrap.
      const record = this.remember(session, row, null, "event");
      if (record) record.usable &&= method === "Page.frameNavigated" && started?.ready === true && started.loaderId === row[2];
      return;
    }
    if (["Page.frameAttached", "Page.frameDetached", "Page.navigatedWithinDocument"].includes(method)) {
      this.retirePreparation();
      this.advance(); this.retire(session, params.frameId);
      this.pending.get(session)?.delete(params.frameId);
    }
  }
  seed(frames, candidate) {
    this.active();
    // Only a fresh successful graph snapshot may call this. No previous tree
    // is carried across an event revision or used to infer a successor loader.
    const remaining = [...frames.values()];
    for (let pass = 0; remaining.length && pass <= frames.size; pass++) {
      let progress = false;
      for (let index = remaining.length - 1; index >= 0; index--) {
        const { session, row } = remaining[index];
        if (this.parent(session, row) === undefined) continue;
        const context = session.contexts.current.get(row[0]);
        const old = this.frames.get(session)?.get(row[0]);
        // A cold record which never granted a fence may bootstrap from this
        // fresh double-tree proof. A formerly usable record may not replace
        // its original context, even when a new snapshot sees the same URL.
        const binding = context && session.contexts.bindings.get(context);
        if (old && (!old.usable || !old.context) && (!old.context || old.context === context) && JSON.stringify(old.row) === JSON.stringify(row) &&
            binding?.loaderId === row[2] && binding.frameId === row[0] && binding.parent === row[1] && this.ready(session)) {
          old.parent = this.parent(session, row); old.context = context; old.source = "snapshot";
          old.usable = old.parent !== undefined; this.advance();
        }
        if (!old && this.remember(session, row, context, "snapshot")) this.advance();
        remaining.splice(index, 1); progress = true;
      }
      if (!progress) break;
    }
    if (candidate) {
      const roots = [...(this.frames.get(this.root)?.values() ?? [])].filter(value => value.row[1] === null);
      if (roots.length === 1) this.bindCandidate(roots[0], candidate);
    }
  }
  path(record) {
    const path = [], seen = new Set();
    while (record) {
      if (seen.has(record) || path.length >= 1000) throw fail();
      seen.add(record); path.push(record); record = record.parent;
    }
    if (!path.length || path.at(-1).session !== this.root || path.at(-1).row[1] !== null) throw fail();
    return path;
  }
  checkpointPreparation() {
    this.check();
    // Event-only readiness is optional. Incomplete event evidence must not
    // disable the existing strict cold/input path; an already issued waiting
    // ticket still fails through preparationContexts when this ledger blocks.
    if (this.blocked) return null;
    const paths = [];
    for (const [session, rows] of this.frames) for (const record of rows.values()) {
      if (!this.current(session) || record.source !== "event" || !record.usable || record.context) continue;
      paths.push(Object.freeze(this.path(record)));
    }
    if (!paths.length) return null;
    const ticket = Object.freeze({});
    this.preparations.set(ticket, { version: this.preparationVersion, paths: Object.freeze(paths) });
    this.preparationContexts(ticket); return ticket;
  }
  preparationContexts(ticket) {
    this.active();
    const saved = this.preparations.get(ticket);
    if (!saved || saved.version !== this.preparationVersion) throw fail();
    const contexts = new Map();
    for (const path of saved.paths) {
      for (let index = 0; index < path.length; index++) {
        const record = path[index];
        if (!record.usable || !this.ready(record.session) ||
            this.frames.get(record.session)?.get(record.row[0]) !== record ||
            record.parent !== (path[index + 1] ?? null)) throw fail();
      }
      const record = path[0], { session, context } = record;
      if (record.source !== "event" || session.contexts.blocked ||
          (context ? session.contexts.current.get(record.row[0]) !== context ||
            !session.contexts.alive.has(context) || session.contexts.records.get(context.uniqueId) !== context :
            session.contexts.current.has(record.row[0]))) throw fail();
      let frames = contexts.get(session);
      if (!frames) { frames = new Map(); contexts.set(session, frames); }
      frames.set(record.row[0], context ?? null);
    }
    // This grants identity readiness only. Browser document, origin and site
    // permission proofs still belong to their separate original interfaces.
    return contexts;
  }
  assertPath(path) {
    this.active();
    for (let index = 0; index < path.length; index++) {
      const record = path[index], { session, row, context } = record;
      if (!record.usable || !this.ready(session) || this.frames.get(session)?.get(row[0]) !== record ||
          !context || session.contexts.blocked || !session.contexts.alive.has(context) ||
          session.contexts.current.get(row[0]) !== context || session.contexts.records.get(context.uniqueId) !== context ||
          record.parent !== (path[index + 1] ?? null)) throw fail();
      const actualOrigin = origin(context.origin);
      if (!actualOrigin) throw fail();
      let url; try { url = new URL(row[3]); } catch { throw fail(); }
      if (["http:", "https:"].includes(url.protocol)) { if (url.origin !== actualOrigin) throw fail(); }
      else if (!["about:blank", "about:srcdoc"].includes(row[3]) || !path[index + 1] ||
          path[index + 1].context?.origin !== actualOrigin) throw fail();
    }
  }
  checkpoint(opening) {
    this.active();
    if (!text(opening?.frameId) || typeof opening.url !== "string") throw fail();
    const matches = [...this.frames].filter(([session]) => this.current(session))
      .map(([, rows]) => rows.get(opening.frameId)).filter(Boolean);
    if (matches.length !== 1) throw fail();
    const path = this.path(matches[0]); this.assertPath(path);
    if (path[0].row[3] + path[0].row[4] !== opening.url) throw fail();
    const fence = Object.freeze({});
    this.fences.set(fence, { path: Object.freeze(path), revision: this.revision, frameId: opening.frameId, url: opening.url });
    return fence;
  }
  assertBrowserIdentity(root, candidate) {
    if (candidate.url !== root.row[3] + root.row[4]) throw fail();
    const prior = this.bindings.get(root), owner = this.rootDocuments.get(candidate.documentId);
    if (this.rootDocuments.has(candidate.documentId) && owner === null && root.eventCommit ||
        owner && owner !== root || prior && prior.documentId !== candidate.documentId) throw fail();
  }
  checkpointRootDocumentHint(value) {
    this.check();
    const browser = hintIdentity(value);
    if (this.blocked) return null;
    const roots = [...(this.frames.get(this.root)?.values() ?? [])].filter(record => record.row[1] === null);
    if (!roots.length) return null;
    if (roots.length !== 1) throw fail();
    const root = roots[0], { context, session, row } = root;
    if (!root.usable || !this.ready(session) || !context || session.contexts.blocked ||
        !session.contexts.alive.has(context) || session.contexts.current.get(row[0]) !== context ||
        session.contexts.records.get(context.uniqueId) !== context || !origin(context.origin)) return null;
    this.assertPath([root]);
    // A cold snapshot must already have its browser identity binding. Only
    // an observed start/commit record can represent a proven successor before
    // its normal readiness proof has bound the browser document.
    if (!this.bindings.has(root) && !root.eventCommit) return null;
    this.assertBrowserIdentity(root, browser);
    const ticket = Object.freeze({});
    this.rootHints.set(ticket, { root, row, context, browser }); return ticket;
  }
  assertRootDocumentHint(ticket, value) {
    this.active();
    const saved = this.rootHints.get(ticket), browser = hintIdentity(value);
    if (!saved || saved.browser.documentId !== browser.documentId || saved.browser.url !== browser.url ||
        saved.root.row !== saved.row || saved.root.context !== saved.context) throw fail();
    this.assertPath([saved.root]); this.assertBrowserIdentity(saved.root, browser);
    // This only verifies the pinned identity. It neither binds a browser
    // document nor upgrades a candidate, site permission or result lineage.
  }
  bindCandidate(root, candidate) {
    if (!candidate || !text(candidate.documentId) || !Number.isSafeInteger(candidate.navigationVersion) || candidate.navigationVersion < 0 ||
        candidate.url !== root.row[3] + root.row[4] || candidate.siteProof &&
        (candidate.siteProof.documentId !== candidate.documentId || candidate.siteProof.version !== candidate.navigationVersion)) throw fail();
    this.assertBrowserIdentity(root, candidate);
    const prior = this.bindings.get(root);
    // A child navigation can advance the browser-wide policy version while
    // this root document remains unchanged. Each proof pins its own version;
    // a new proof cannot migrate this root record to another document ID.
    if (!prior) { this.bindings.set(root, Object.freeze({ documentId: candidate.documentId })); this.rootDocuments.set(candidate.documentId, root); }
  }
  capture(fence, candidate, opening) {
    const saved = this.fences.get(fence);
    if (!saved || saved.revision !== this.revision || saved.frameId !== opening?.frameId || saved.url !== opening?.url) throw fail();
    this.assertPath(saved.path);
    const actualOrigins = Object.freeze(saved.path.map(record => record.context.origin));
    const source = humanDialogSource(actualOrigins);
    this.assertCandidate(candidate, actualOrigins);
    const originalCandidate = Object.freeze({ ...candidate,
      ...(candidate?.siteProof ? { siteProof: Object.freeze({ ...candidate.siteProof }) } : {}) });
    this.bindCandidate(saved.path.at(-1), originalCandidate);
    const proof = Object.freeze({ actualOrigins, source });
    this.proofs.set(proof, { ...saved, candidate: originalCandidate }); this.assert(proof); return proof;
  }
  assert(proof) {
    const saved = this.proofs.get(proof);
    if (!saved || saved.revision !== this.revision) throw fail();
    this.assertPath(saved.path); this.assertCandidate(saved.candidate, proof.actualOrigins);
    const bound = this.bindings.get(saved.path.at(-1));
    if (bound?.documentId !== saved.candidate.documentId) throw fail();
  }
}
