// Dedicated created-page provenance ledger. Site-policy shortcuts must not
// bypass these webNavigation observations. Native events lack documentId;
// stable snapshots are observations, not an atomic event/document guarantee.
const changed = () => new Error("OBU_PAGE_WAIT_SOURCE_CHANGED: the original source document is no longer eligible");
const validId = value => Number.isSafeInteger(value) && value >= 0;
const documentId = value => typeof value === "string" && value.length > 0 && value.length <= 256;

export class BrowserPageFrames {
  constructor({ maxFrames = 256 } = {}) { this.maxFrames = maxFrames; }

  create(tabId) {
    return { tabId, version: 0, frames: new Map(), blocked: new Set(), navigating: new Set(), pinned: false, invalid: false };
  }

  check(entry) { if (!entry || entry.invalid) throw changed(); }

  block(entry, frameId) {
    const ids = new Set([frameId]);
    for (let pass = 0; pass < entry.frames.size; pass++) {
      let added = false;
      for (const frame of entry.frames.values()) if (ids.has(frame.parentFrameId) && !ids.has(frame.frameId)) { ids.add(frame.frameId); added = true; }
      if (!added) break;
    }
    for (const id of ids) entry.blocked.add(id);
    if (ids.has(0) || entry.blocked.size + entry.navigating.size > this.maxFrames) entry.invalid = true;
    return ids;
  }

  navigation(entry, name, details) {
    if (!entry || entry.invalid || details.tabId !== entry.tabId || !validId(details.frameId)) return;
    if (!["onBeforeNavigate", "onCommitted", "onErrorOccurred"].includes(name)) return;
    entry.version++;
    const id = details.frameId;
    if (name === "onBeforeNavigate") {
      entry.navigating.add(id);
      if (entry.pinned && (id === 0 || entry.frames.has(id))) this.block(entry, id);
    } else {
      entry.navigating.delete(id);
      if (entry.pinned && entry.frames.has(id)) this.block(entry, id);
      if (entry.pinned && name === "onErrorOccurred") this.block(entry, id);
      if (entry.pinned && !entry.blocked.has(id) && name === "onCommitted") {
        if (id === 0 || !documentId(details.documentId) || !validId(details.parentFrameId) ||
            !this.eligible(entry, details.parentFrameId) || entry.frames.size >= this.maxFrames) this.block(entry, id);
        else entry.frames.set(id, this.frame(details));
      }
    }
    if (entry.navigating.size + entry.blocked.size > this.maxFrames) entry.invalid = true;
  }

  frame(value) {
    return Object.freeze({ frameId: value.frameId, parentFrameId: value.parentFrameId, documentId: value.documentId,
      ...(value.processId !== undefined ? { processId: value.processId } : {}), ...(value.documentLifecycle !== undefined ? { documentLifecycle: value.documentLifecycle } : {}) });
  }

  parse(values) {
    if (!Array.isArray(values) || values.length > this.maxFrames) throw changed();
    const frames = new Map();
    for (const value of values) {
      if (value.documentLifecycle !== undefined && value.documentLifecycle !== "active") continue;
      if (!validId(value.frameId) || !Number.isSafeInteger(value.parentFrameId) || value.parentFrameId < -1 ||
          !documentId(value.documentId) || frames.has(value.frameId) ||
          (value.processId !== undefined && (!Number.isSafeInteger(value.processId) || value.processId < -1))) throw changed();
      frames.set(value.frameId, this.frame(value));
    }
    if (frames.get(0)?.parentFrameId !== -1) throw changed();
    for (const frame of frames.values()) {
      const seen = new Set(); let current = frame;
      while (current.frameId !== 0) {
        if (seen.has(current.frameId)) throw changed(); seen.add(current.frameId);
        current = frames.get(current.parentFrameId); if (!current) throw changed();
      }
    }
    return frames;
  }

  eligible(entry, id) {
    if (!entry.pinned || entry.invalid) return false;
    const seen = new Set(); let frame = entry.frames.get(id);
    while (frame) {
      if (entry.blocked.has(frame.frameId) || entry.navigating.has(frame.frameId) || seen.has(frame.frameId)) return false;
      if (frame.frameId === 0) return frame.documentId === entry.rootDocumentId;
      seen.add(frame.frameId); frame = entry.frames.get(frame.parentFrameId);
    }
    return false;
  }

  async snapshot(entry, read) {
    this.check(entry); const version = entry.version;
    const values = await read(); this.check(entry);
    if (entry.version !== version) throw changed();
    const frames = this.parse(values);
    if (!entry.pinned) {
      if (entry.navigating.has(0)) throw changed();
      entry.frames = frames; entry.rootDocumentId = frames.get(0).documentId; entry.pinned = true;
      for (const id of entry.navigating) this.block(entry, id);
    } else {
      if (frames.get(0).documentId !== entry.rootDocumentId) { entry.invalid = true; throw changed(); }
      for (const old of entry.frames.values()) {
        const current = frames.get(old.frameId);
        if (!current || current.documentId !== old.documentId || current.parentFrameId !== old.parentFrameId ||
            (old.processId >= 0 && current.processId >= 0 && old.processId !== current.processId)) this.block(entry, old.frameId);
      }
      for (const frame of frames.values()) if (!entry.frames.has(frame.frameId)) {
        if (entry.frames.size >= this.maxFrames) { entry.invalid = true; throw changed(); }
        entry.frames.set(frame.frameId, frame);
      }
    }
    this.check(entry); return values;
  }

  candidate(entry, event) {
    if (!this.eligible(entry, event.sourceFrameId) || event.sourceTabId !== entry.tabId ||
        !validId(event.tabId) || event.tabId === entry.tabId || !Number.isSafeInteger(event.sourceProcessId) || event.sourceProcessId < -1) return null;
    const frame = entry.frames.get(event.sourceFrameId);
    if (frame.processId >= 0 && event.sourceProcessId >= 0 && frame.processId !== event.sourceProcessId) return null;
    return frame;
  }

  validate(entry, candidate) {
    this.check(entry);
    const frame = entry.frames.get(candidate.frameId);
    if (!this.eligible(entry, candidate.frameId) || frame?.documentId !== candidate.documentId || frame.parentFrameId !== candidate.parentFrameId) throw changed();
  }
}
