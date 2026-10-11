// Per-attachment observation identity. Native Playwright owns ARIA and Elements;
// this layer owns the finite public contract and expiry across page lifecycles.
import { validateSnapshotGeometry } from "./browser-snapshot-geometry.js";
export const AI_SNAPSHOT_LIMITS = Object.freeze({
  maxBytes: 262144, maxNodes: 5000, maxRefs: 2000, maxFrames: 32, maxDepth: 64
});
const encoder = new TextEncoder();

export function isAIRef(value) {
  return typeof value === "string" && value.length <= 64 &&
    /^(?:f[1-9][0-9]*)?e[1-9][0-9]*/.exec(value)?.[0] === value;
}

export function snapshotLimits(args) {
  const limits = { ...AI_SNAPSHOT_LIMITS };
  for (const [key, maximum] of Object.entries(limits)) {
    if (args[key] === undefined) continue;
    if (!Number.isSafeInteger(args[key]) || args[key] < 1 || args[key] > maximum)
      throw new Error(`${key} must be an integer from 1 to ${maximum}`);
    limits[key] = args[key];
  }
  return limits;
}

const expired = () => new Error("OBU_CAPTURE_EXPIRED: take a new snapshotAI before using this reference");

export class BrowserObservation {
  constructor(page) {
    this.revision = 0;
    this.capture = undefined;
    this.disposed = false;
    this.listeners = [];
    for (const event of ["frameattached", "framedetached", "framenavigated"]) {
      const listener = () => this.invalidate();
      page.on(event, listener);
      this.listeners.push(() => page.off(event, listener));
    }
    const closed = () => this.dispose();
    page.on("close", closed);
    this.listeners.push(() => page.off("close", closed));
  }

  invalidate() {
    this.capture = undefined;
    return ++this.revision;
  }

  begin() {
    if (this.disposed) throw expired();
    return this.invalidate();
  }

  publish(result, revision, limits, { boxes = false } = {}) {
    if (this.disposed || revision !== this.revision) throw expired();
    const fail = () => { throw new Error("OBU_SNAPSHOT_INCOMPLETE: invalid bounded runtime observation"); };
    if (!result || result.complete !== true || typeof result.snapshot !== "string" ||
        !Array.isArray(result.refs) || result.refs.length > limits.maxRefs ||
        !(result.refFrames instanceof Map) || result.refFrames.size !== result.refs.length) fail();
    const stats = result.stats;
    if (!stats || ["bytes", "nodes", "refs", "frames"].some(key => !Number.isSafeInteger(stats[key]) || stats[key] < 0)) fail();
    if (result.snapshot.length > limits.maxBytes || stats.bytes !== encoder.encode(result.snapshot).byteLength ||
        stats.bytes > limits.maxBytes || stats.nodes > limits.maxNodes ||
        stats.refs !== result.refs.length || stats.frames < 1 || stats.frames > limits.maxFrames) fail();
    const refs = new Set(result.refs);
    if (refs.size !== result.refs.length || result.refs.some(ref => !isAIRef(ref) || !result.refFrames.get(ref))) fail();
    if (boxes) validateSnapshotGeometry(result.geometry, { refs: result.refs, frameCount: stats.frames });
    else if (result.geometry !== undefined) fail();
    const captureId = crypto.randomUUID();
    this.capture = { captureId, refs, refFrames: new Map(result.refFrames) };
    return { captureId, snapshot: result.snapshot, refs: [...refs], stats: {
      bytes: stats.bytes, nodes: stats.nodes, refs: stats.refs, frames: stats.frames
    }, complete: true, ...(boxes ? { geometry: structuredClone(result.geometry) } : {}) };
  }

  get({ captureId, ref }) {
    if (this.disposed || !this.capture || this.capture.captureId !== captureId) throw expired();
    if (!this.capture.refs.has(ref)) throw new Error("OBU_REF_NOT_IN_CAPTURE: reference was not emitted by this capture");
    return this.capture;
  }

  check(capture) {
    if (this.disposed || !capture || this.capture !== capture) throw expired();
  }

  dispose() {
    this.disposed = true;
    this.invalidate();
    for (const remove of this.listeners.splice(0)) remove();
  }
}
