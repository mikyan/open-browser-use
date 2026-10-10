// One explicitly adapted private Playwright channel. Public capture identity,
// ownership and invalidation remain the engine's responsibility.
const limits = Object.freeze({ maxBytes: 262144, maxNodes: 5000, maxRefs: 2000, maxFrames: 32, maxDepth: 64 });
const fail = message => new Error(`OBU_SNAPSHOT_INCOMPLETE: ${message}`);

export async function captureAISnapshot(page, options = {}) {
  const bounded = {};
  for (const [name, cap] of Object.entries(limits)) {
    const value = options[name] ?? cap;
    if (!Number.isSafeInteger(value) || value < 1 || value > cap) throw new Error(`OBU_SNAPSHOT_LIMIT: invalid ${name}`);
    bounded[name] = value;
  }
  const timeout = options.timeoutMs;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120000) throw new Error("OBU_SNAPSHOT_LIMIT: invalid timeoutMs");
  const result = await page._channel.snapshotForAI({ ...bounded, timeout, bounded: true });
  if (result?.complete !== true || typeof result.snapshot !== "string" || !Array.isArray(result.refs)) throw fail("invalid native result");
  const frames = new Map(page.frames().map(frame => [frame._guid, frame]));
  const refFrames = new Map();
  for (const item of result.refs) {
    const frame = frames.get(item?.frameGuid);
    if (typeof item?.ref !== "string" || item.ref.length > 64 || /^(?:f[1-9]\d*)?e[1-9]\d*/.exec(item.ref)?.[0] !== item.ref || refFrames.has(item.ref) || !frame || frame.isDetached()) throw fail("invalid reference identity");
    refFrames.set(item.ref, frame);
  }
  const refs = [...refFrames.keys()];
  const stats = result.stats;
  if (!stats || stats.refs !== refs.length || stats.bytes !== new TextEncoder().encode(result.snapshot).length) throw fail("invalid native counts");
  for (const [name, cap] of [["bytes", bounded.maxBytes], ["nodes", bounded.maxNodes], ["refs", bounded.maxRefs], ["frames", bounded.maxFrames]]) {
    if (!Number.isSafeInteger(stats[name]) || stats[name] < (name === "nodes" || name === "frames" ? 1 : 0) || stats[name] > cap) throw fail(`invalid ${name} count`);
  }
  return { snapshot: result.snapshot, refs, stats, complete: true, refFrames };
}

export async function scrollAIRefIntoView(page, ref, metadata, { timeoutMs, check = async () => {} }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw new Error("Invalid ref scroll deadline");
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    const value = deadline - performance.now();
    if (value <= 0) throw Object.assign(new Error("AI reference scroll timed out"), { name: "TimeoutError" });
    return value;
  };
  const target = metadata?.refFrames?.get(ref);
  if (!target) throw new Error("OBU_REF_NOT_IN_CAPTURE: unknown reference");
  const ancestors = [];
  for (let frame = target; frame.parentFrame(); frame = frame.parentFrame()) {
    if (ancestors.length >= limits.maxFrames) throw fail("invalid frame ancestry");
    ancestors.unshift(frame);
  }
  const verify = async () => {
    remaining();
    await check();
    remaining();
    const live = new Set(page.frames());
    if (!live.has(target) || target.isDetached() || ancestors.some(frame => !live.has(frame) || frame.isDetached())) throw new Error("OBU_CAPTURE_EXPIRED: frame is no longer attached");
  };
  await verify();
  for (const frame of ancestors) {
    let element;
    try {
      await verify();
      element = await frame.frameElement();
      await verify();
      await element.scrollIntoViewIfNeeded({ timeout: remaining() });
      await verify();
    } finally {
      // Disposal is cleanup, not a new page action. A concurrently canceled Page
      // can reject it; that must not hide the original capture/ownership error.
      if (element) await element.dispose().catch(() => {});
    }
  }
}
