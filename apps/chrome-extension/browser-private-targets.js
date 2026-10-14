// Only this allocator may create independent debugger clients in an extension.
// The adapter must load this ledger before any such attach is admitted. `fresh`
// is a trusted browser-lifetime initialization witness, never a missing key or
// a public request flag. Unknown state disables this optional registry only.
const VERSION = 1, MAX_TARGETS = 16, MAX_PER_ROOT = 2, MAX_GROUPS = 32, MAX_SENDS = 64;
const textId = value => typeof value === "string" && value.length > 0 && value.length <= 4096;
const tabId = value => Number.isSafeInteger(value) && value >= 0;
const unavailable = () => new Error("OBU_PRIVATE_TARGET_UNAVAILABLE: original private route is unavailable");
const invalid = () => new Error("OBU_PRIVATE_TARGET_LEDGER_UNKNOWN: private target ownership is unknown");
const nativeThen = Promise.prototype.then;
const reads = new Set(["Page.getFrameTree", "Page.createIsolatedWorld", "DOM.describeNode", "DOM.getBoxModel", "DOM.getFrameOwner", "DOM.resolveNode", "Runtime.evaluate", "Runtime.callFunctionOn"]);
const allocates = method => method === "DOM.resolveNode" || method === "Runtime.evaluate" || method === "Runtime.callFunctionOn";
const noClient = (error, targetId) => error?.message === `Debugger is not attached to the target with id: ${targetId}.`;
const nativeAbsence = (error, targetId) => noClient(error, targetId) || error?.message === `No target with given id ${targetId}.`;

// Pinned native distinction: InitAgentHost uses GetForId, while getTargets uses
// GetOrCreateAll. NoTarget never admits a new read. For an already owned client,
// its scoped_refptr retains the host; destruction force-detaches clients before
// removing GetForId's entry. After actual sends drain, a new exact absence query
// can therefore retire cleanup, without claiming a group/detach ACK or a world
// destruction ACK. A target-only onDetach event cannot provide that proof.
// https://github.com/chromium/chromium/blob/156.0.8078.4/chrome/browser/extensions/api/debugger/debugger_api.cc#L907
// https://github.com/chromium/chromium/blob/156.0.8078.4/chrome/browser/extensions/api/debugger/debugger_api.cc#L491
// https://github.com/chromium/chromium/blob/156.0.8078.4/content/browser/devtools/render_frame_devtools_agent_host.cc#L646
// https://github.com/chromium/chromium/blob/156.0.8078.4/content/browser/devtools/devtools_agent_host_impl.cc#L448

export class PrivateTargetRegistry {
  /**
   * load(): { ledger?, fresh?: true, incarnation? }; save(): actual Promise.
   * A fresh witness must name the incarnation in which it was obtained.
   * incarnation(): the current trusted BrowserLifetime incarnation.
   * native methods return actual chrome.debugger Promises. The adapter supplies
   * exclusive independent-target allocation and retains existing event listeners.
   * A recognized recovered intent authorizes cleanup only, never reads.
   */
  constructor({ load, save, incarnation, native, randomUUID = () => crypto.randomUUID() }) {
    this.loadStore = load; this.saveStore = save; this.incarnation = incarnation; this.native = native; this.randomUUID = randomUUID;
    this.entries = new Map(); this.targets = new Map(); this.pending = new Set(); this.writes = Promise.resolve();
    this.loaded = false; this.unknown = "loading";
    this.loadingIncarnation = incarnation();
    this.ready = this.initialize(); this.readySettled = false;
    nativeThen.call(this.ready, () => { this.readySettled = true; }, () => { this.readySettled = true; });
  }

  track(promise, entry) {
    // Do not replace native settlement with a caller timeout or cancellation.
    nativeThen.call(promise, () => { this.pending.delete(promise); entry?.pending.delete(promise); }, () => { this.pending.delete(promise); entry?.pending.delete(promise); });
    this.pending.add(promise); entry?.pending.add(promise);
    return promise;
  }

  current() { if (this.unknown || !this.loaded || this.incarnation() !== this.originalIncarnation) throw unavailable(); }

  async initialize() {
    try {
      const state = await this.track(this.loadStore());
      this.originalIncarnation = this.incarnation();
      if (!textId(this.originalIncarnation) || (this.loadingIncarnation !== undefined && this.loadingIncarnation !== this.originalIncarnation)) throw invalid();
      const ledger = state?.ledger;
      if (ledger === undefined) {
        if (state?.fresh !== true || state.incarnation !== this.originalIncarnation) { this.unknown = "missing-ledger"; throw invalid(); }
        await this.track(this.saveStore({ version: VERSION, incarnation: this.originalIncarnation, records: [] }));
      } else {
        if (!ledger || ledger.version !== VERSION || ledger.incarnation !== this.originalIncarnation || !Array.isArray(ledger.records) || ledger.records.length > MAX_TARGETS) throw invalid();
        const ids = new Set(), targets = new Set();
        for (const row of ledger.records) {
          if (!row || Object.keys(row).some(key => !["leaseId", "tabId", "rootTargetId", "targetId", "parentFrameId", "phase"].includes(key)) || !textId(row.leaseId) || !tabId(row.tabId) || !textId(row.rootTargetId) || !textId(row.targetId) || !textId(row.parentFrameId) || row.targetId === row.rootTargetId || !["intent", "owned"].includes(row.phase) || ids.has(row.leaseId) || targets.has(row.targetId)) throw invalid();
          ids.add(row.leaseId); targets.add(row.targetId);
        }
        for (const row of ledger.records) {
          const entry = this.newEntry(Object.freeze({ ...row }), null);
          entry.recovered = true; entry.revoked = true; entry.status = "quarantined";
          this.entries.set(row.leaseId, entry); this.targets.set(row.targetId, entry);
        }
      }
      if (this.incarnation() !== this.originalIncarnation) throw invalid();
      this.loaded = true; this.unknown = null;
    } catch (error) { if (this.unknown === "loading") this.unknown = "invalid-or-unreadable-ledger"; throw error; }
  }

  newEntry(data, root) {
    return { id: data.leaseId, target: Object.freeze({ targetId: data.targetId }), data, root, pending: new Set(), groups: new Map(), owned: false, detached: false, retiredByNativeAbsence: false, absenceEvidence: [], revoked: false, recovered: false, status: "reserved", releasePending: null, releaseSettled: false };
  }

  persist(entry, remove = false) {
    const operation = this.writes.catch(() => {}).then(async () => {
      this.current();
      const records = [...this.entries.values()].filter(value => value.data && !(remove && value === entry)).map(value => value.data);
      await this.track(this.saveStore({ version: VERSION, incarnation: this.originalIncarnation, records: structuredClone(records) }));
      this.current();
      if (remove && this.entries.get(entry.id) === entry) { this.entries.delete(entry.id); this.targets.delete(entry.target.targetId); entry.status = "released"; }
    });
    this.writes = operation;
    return operation;
  }

  acquire({ root, targetId: target, parentFrameId } = {}) {
    try { this.current(); root?.check(); } catch { return null; }
    if (!tabId(root?.tabId) || !root.attachment || typeof root.attachment !== "object" || !textId(root.rootTargetId) || typeof root.check !== "function" || !textId(target) || !textId(parentFrameId) || target === root.rootTargetId || this.targets.has(target) || [...this.entries.values()].some(e => e.recovered) || this.entries.size >= MAX_TARGETS || [...this.entries.values()].filter(e => e.root?.attachment === root.attachment).length >= MAX_PER_ROOT) return null;
    const id = this.randomUUID(); if (!textId(id) || this.entries.has(id)) return null;
    const data = Object.freeze({ leaseId: id, tabId: root.tabId, rootTargetId: root.rootTargetId, targetId: target, parentFrameId, phase: "intent" });
    const entry = this.newEntry(data, Object.freeze({ ...root })); entry.data = null;
    this.entries.set(id, entry); this.targets.set(target, entry);
    const lease = Object.freeze({ leaseId: id, target: entry.target,
      check: () => this.check(entry), send: (method, params) => this.send(entry, method, params),
      prepareGroup: name => this.prepareGroup(entry, name), release: () => this.release(entry),
      ready: this.open(entry, data) });
    entry.ready = lease.ready; entry.readySettled = false;
    nativeThen.call(entry.ready, () => { entry.readySettled = true; }, () => { entry.readySettled = true; });
    return lease;
  }

  authority(entry) { this.current(); if (entry.revoked || this.entries.get(entry.id) !== entry || this.targets.get(entry.target.targetId) !== entry) throw unavailable(); entry.root.check(); }
  cleanupAuthority(entry) { this.current(); if (this.entries.get(entry.id) !== entry || this.targets.get(entry.target.targetId) !== entry) throw unavailable(); }
  check(entry) { this.authority(entry); if (entry.status !== "ready" || !entry.owned) throw unavailable(); }
  invoke(entry, method, params) { this.cleanupAuthority(entry); return this.track(this.native.send(entry.target, method, params), entry); }

  async open(entry, data) {
    try {
      this.authority(entry);
      // Chrome only materializes some OOPIF AgentHosts during getTargets().
      // Existence is exact-ID evidence, never URL or `attached` ownership.
      const targets = await this.track(this.native.getTargets(), entry);
      this.authority(entry);
      if (!Array.isArray(targets) || targets.filter(target => target?.id === entry.target.targetId).length !== 1) throw unavailable();
      let absent = false;
      try { await this.invoke(entry, "Target.getTargetInfo", {}); }
      catch (error) { if (!noClient(error, entry.target.targetId)) throw error; absent = true; }
      if (!absent) throw unavailable(); // Existing clients are never borrowed.
      this.authority(entry); entry.data = data; entry.status = "intent";
      await this.persist(entry); this.authority(entry);
      await this.track(this.native.attach(entry.target, "1.3"), entry);
      entry.owned = true; entry.data = Object.freeze({ ...data, phase: "owned" });
      // Persist cleanup ownership even when the visual scope was revoked while
      // the actual attach was pending. It must not restore read authority.
      await this.persist(entry); this.authority(entry);
      entry.status = "ready"; return entry.target;
    } catch (error) { entry.status = "open-failed"; entry.openError = error; throw error; }
  }

  send(entry, method, params = {}) {
    this.check(entry);
    if (!reads.has(method) || entry.pending.size >= MAX_SENDS) throw unavailable();
    let group;
    if (allocates(method)) {
      group = entry.groups.get(params.objectGroup);
      if (!group || group.closing || group.released || (method.startsWith("Runtime.") && (params.awaitPromise !== false || params.userGesture !== false))) throw unavailable();
    }
    const promise = this.invoke(entry, method, params);
    if (group) {
      group.pending.add(promise);
      nativeThen.call(promise, () => group.pending.delete(promise), () => group.pending.delete(promise));
    }
    return promise;
  }

  prepareGroup(entry, name) {
    this.check(entry);
    if (!textId(name) || entry.groups.has(name) || entry.groups.size >= MAX_GROUPS) throw unavailable();
    const group = { name, pending: new Set(), closing: false, released: false, closed: false, attempt: null, settled: false, failed: false };
    entry.groups.set(name, group);
    return Object.freeze({ releaseGroup: () => this.releaseGroup(entry, group), close: () => { if (!group.released && !group.retiredByNativeAbsence) throw unavailable(); group.closed = true; } });
  }

  retireByAbsence(entry, evidence) {
    this.cleanupAuthority(entry);
    entry.revoked = true; entry.retiredByNativeAbsence = true; evidence.confirmed = true;
    for (const group of entry.groups.values()) if (!group.released) group.retiredByNativeAbsence = true;
  }

  async confirmAbsence(entry, trigger) {
    if (!entry.owned || !nativeAbsence(trigger, entry.target.targetId)) throw trigger;
    entry.revoked = true;
    const evidence = { trigger, confirmed: false }; entry.absenceEvidence.push(evidence);
    // Other groups and nonallocating reads may still have actual callbacks.
    // An event, error, or visual revocation cannot settle those Promises.
    await Promise.allSettled([...entry.pending]); this.cleanupAuthority(entry);
    try { evidence.queryResult = await this.invoke(entry, "Target.getTargetInfo", {}); }
    catch (error) {
      evidence.queryError = error; this.cleanupAuthority(entry);
      if (nativeAbsence(error, entry.target.targetId)) { this.retireByAbsence(entry, evidence); return; }
    }
    throw trigger;
  }

  releaseGroup(entry, group) {
    if (group.attempt) return group.attempt;
    group.closing = true;
    group.attempt = (async () => {
      await Promise.allSettled([...group.pending]);
      if (entry.retiredByNativeAbsence) { group.retiredByNativeAbsence = true; return; }
      try { await this.invoke(entry, "Runtime.releaseObjectGroup", { objectGroup: group.name }); group.released = true; }
      catch (error) { await this.confirmAbsence(entry, error); }
    })();
    nativeThen.call(group.attempt, () => { group.settled = true; }, error => { group.settled = true; group.failed = true; group.error = error; entry.revoked = true; });
    return group.attempt;
  }

  release(entry) {
    if (entry.releasePending) return entry.releasePending;
    entry.revoked = true; entry.status = "releasing";
    entry.releasePending = (async () => {
      try { await entry.ready; } catch {}
      await Promise.allSettled([...entry.pending]);
      this.cleanupAuthority(entry);
      if (entry.recovered && !entry.detached && !entry.retiredByNativeAbsence) {
        // The same-incarnation durable intent plus exclusive allocator is the
        // authority here. A changed incarnation or unknown ledger never enters.
        const evidence = { recovery: true, confirmed: false }; entry.absenceEvidence.push(evidence);
        try {
          const result = await this.invoke(entry, "Target.getTargetInfo", {});
          evidence.queryResult = result; this.cleanupAuthority(entry);
          if (result?.targetInfo?.targetId !== entry.target.targetId) throw unavailable();
          entry.owned = true;
        } catch (error) { evidence.queryError = error; this.cleanupAuthority(entry); if (!nativeAbsence(error, entry.target.targetId)) throw error; this.retireByAbsence(entry, evidence); }
      }
      if (entry.owned && !entry.detached && !entry.retiredByNativeAbsence) {
        for (const group of entry.groups.values()) { await this.releaseGroup(entry, group); group.closed = true; }
        if (!entry.retiredByNativeAbsence) {
          try { await this.track(this.native.detach(entry.target), entry); entry.detached = true; }
          catch (error) { await this.confirmAbsence(entry, error); }
        }
      }
      if (entry.data) await this.persist(entry, true);
      else { this.entries.delete(entry.id); this.targets.delete(entry.target.targetId); entry.status = "released"; }
      return { detached: entry.detached, retiredByNativeAbsence: entry.retiredByNativeAbsence, absenceEvidence: [...entry.absenceEvidence] };
    })();
    nativeThen.call(entry.releasePending, () => { entry.releaseSettled = true; }, error => { entry.releaseSettled = true; entry.status = "release-failed"; entry.releaseError = error; });
    return entry.releasePending;
  }

  retry(leaseId) {
    const entry = this.entries.get(leaseId);
    if (!entry) return Promise.reject(unavailable());
    const failedGroup = [...entry.groups.values()].some(group => group.failed);
    if (!entry.releasePending && !failedGroup) return Promise.reject(unavailable());
    if (entry.releasePending && (!entry.releaseSettled || entry.status !== "release-failed")) return entry.releasePending;
    for (const group of entry.groups.values()) if (group.settled && group.failed) { group.attempt = null; group.settled = false; group.failed = false; }
    entry.releasePending = null; entry.releaseSettled = false;
    return this.release(entry);
  }

  recover(leaseId) {
    const entry = this.entries.get(leaseId);
    if (!entry?.recovered) return Promise.reject(unavailable());
    return this.release(entry);
  }

  revokeRoot(attachment) {
    return Promise.all([...this.entries.values()].filter(entry => entry.root?.attachment === attachment).map(entry => this.release(entry)));
  }

  observeDetach(source) {
    // A target-only event has no connection generation. It revokes reads but
    // cannot discharge actual detach, group release or durable-clear obligations.
    const entry = this.targets.get(source?.targetId);
    if (!entry) return;
    entry.revoked = true;
  }

  snapshot() {
    const entries = [...this.entries.values()];
    const pending = new Set(this.pending);
    if (!this.readySettled) pending.add(this.ready);
    for (const entry of entries) {
      if (entry.ready && !entry.readySettled) pending.add(entry.ready);
      if (entry.releasePending && !entry.releaseSettled) pending.add(entry.releasePending);
      for (const group of entry.groups.values()) if (group.attempt && !group.settled) pending.add(group.attempt);
    }
    return { enabled: this.loaded && !this.unknown && this.incarnation() === this.originalIncarnation, unknown: this.unknown || (this.loaded && this.incarnation() !== this.originalIncarnation ? "incarnation-changed" : null),
      tabIds: [...new Set(entries.map(e => e.data?.tabId ?? e.root?.tabId))], pending: [...pending],
      quarantined: entries.filter(e => e.recovered).map(e => e.id), failed: entries.filter(e => e.status === "release-failed" || [...e.groups.values()].some(group => group.failed)).map(e => e.id),
      leases: entries.map(e => ({ leaseId: e.id, status: e.status, owned: e.owned, detached: e.detached, retiredByNativeAbsence: e.retiredByNativeAbsence, absenceEvidence: [...e.absenceEvidence] })) };
  }
}
