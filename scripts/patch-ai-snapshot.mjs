import vm from "node:vm";

const caps = { maxBytes: 262144, maxNodes: 5000, maxRefs: 2000, maxFrames: 32, maxDepth: 64 };

const selectorGuard = `
export function assertOpenBrowserUseSelector(selector, restricted = false) {
  // This finite set is reviewed against the pinned native parser/engines. The
  // framework engines run in the main world and inspect arbitrary properties;
  // registered custom engines can contain code. Neither is a document locator
  // primitive in the restricted public API.
  const allowed = new Set([
    "css", "xpath", "xpath:light", "text", "text:light", "id", "id:light",
    "data-testid", "data-testid:light", "data-test-id", "data-test-id:light", "data-test", "data-test:light",
    "nth", "visible", "role", "internal:control", "internal:has", "internal:has-not",
    "internal:has-text", "internal:has-not-text", "internal:and", "internal:or", "internal:chain",
    "internal:attr", "internal:label", "internal:text", "internal:role", "internal:testid", "internal:describe"
  ]);
  visitAllSelectorParts(parseSelector(selector), part => {
    if (part.name === "aria-ref") throw new Error("OBU_REF_SELECTOR_REQUIRES_CAPTURE: use the capture-scoped ref descriptor");
    if (restricted && (!allowed.has(part.name) || (part.name === "internal:control" && part.body !== "enter-frame")))
      throw new Error("OBU_SITE_ACCESS_UNSUPPORTED: this selector engine is unavailable with website restrictions");
  });
}
`;

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("Pinned Playwright AI snapshot shape changed; review the bounded observation adapter");
  return source.replace(before, after);
}

export function patchInjectedAISnapshot(source) {
  source = replaceOnce(source, "    visited.add(node);\n    if (node.nodeType === Node.TEXT_NODE", `    if (options?.obuLimits && visited.size >= options.obuLimits.maxNodes) throw new Error("OBU_SNAPSHOT_LIMIT: maxNodes");
    if (options?.obuLimits && depth > options.obuLimits.maxDepth) throw new Error("OBU_SNAPSHOT_LIMIT: maxDepth");
    visited.add(node);
    if (node.nodeType === Node.TEXT_NODE`);
  source = replaceOnce(source, "  const visit = (ariaNode, node) => {", "  const visit = (ariaNode, node, depth = 1) => {");
  source = replaceOnce(source, "    processElement(childAriaNode || ariaNode, element, ariaChildren);", "    processElement(childAriaNode || ariaNode, element, ariaChildren, depth);");
  source = replaceOnce(source, "    if (childAriaNode) {\n      if (childAriaNode.ref)", "    if (childAriaNode) {\n      if (options?.obuLimits) childAriaNode.obuDepth = depth;\n      if (childAriaNode.ref)");
  source = replaceOnce(source, "  function processElement(ariaNode, element, ariaChildren = []) {", "  function processElement(ariaNode, element, ariaChildren = [], depth = 1) {");
  for (const child of ["child"]) {
    const old = `visit(ariaNode, ${child});`;
    const count = source.split(old).length - 1;
    if (count !== 4) throw new Error("Pinned Playwright AI snapshot traversal shape changed");
    source = source.replaceAll(old, `visit(ariaNode, ${child}, depth + 1);`);
  }
  source = replaceOnce(source, "  normalizeStringChildren(snapshot.root);", "  if (options?.obuLimits) snapshot.obuNodeCount = visited.size;\n  normalizeStringChildren(snapshot.root);");
  const start = source.indexOf("function renderAriaTree(ariaSnapshot, options) {");
  const end = source.indexOf("\nfunction convertToBestGuessRegex", start);
  if (start < 0 || end < 0) throw new Error("Pinned Playwright AI snapshot renderer shape changed");
  let renderer = source.slice(start, end);
  renderer = replaceOnce(renderer, "  const lines = [];", `  const lines = [];
  let obuBytes = 0;
  const pushLine = line => {
    if (options?.obuLimits) {
      obuBytes += new TextEncoder().encode(line).length + (lines.length ? 1 : 0);
      if (obuBytes > options.obuLimits.maxBytes) throw new Error("OBU_SNAPSHOT_LIMIT: maxBytes");
    }
    lines.push(line);
  };`);
  // Only the original renderer's output sites are routed through the budget.
  const pushStart = renderer.indexOf("  const includeText");
  renderer = renderer.slice(0, pushStart) + renderer.slice(pushStart).replaceAll("lines.push(", "pushLine(");
  renderer = replaceOnce(renderer, '      if (ref)\n        key += ` [ref=${ref}]${cursor}`;', `      if (ref) {
        key += \` [ref=\${ref}]\${cursor}\`;
        if (options?.obuRefs) {
          if (options.obuRefs.length >= options.obuLimits.maxRefs) throw new Error("OBU_SNAPSHOT_LIMIT: maxRefs");
          options.obuRefs.push({ ref, line: lines.length, indent, depth: ariaNode2.obuDepth, iframe: ariaNode2.element?.nodeName === "IFRAME" });
        }
      }`);
  // A frame document is appended as nested YAML. Use the native collection
  // rendering branch even when the iframe has inline fallback text or no DOM
  // children, instead of guessing whether its emitted line needs a colon.
  renderer = replaceOnce(renderer, "    const hasProps = !!Object.keys(ariaNode2.props).length;", "    const hasProps = !!Object.keys(ariaNode2.props).length;\n    const obuIframeContainer = !!options?.obuLimits && ariaNode2.element?.nodeName === \"IFRAME\";");
  renderer = replaceOnce(renderer, "if (!ariaNode2.children.length && !hasProps) {", "if (!ariaNode2.children.length && !hasProps && !obuIframeContainer) {");
  renderer = replaceOnce(renderer, 'else if (ariaNode2.children.length === 1 && typeof ariaNode2.children[0] === "string" && !hasProps) {', 'else if (ariaNode2.children.length === 1 && typeof ariaNode2.children[0] === "string" && !hasProps && !obuIframeContainer) {');
  source = source.slice(0, start) + renderer + source.slice(end);
  source = replaceOnce(source, "    return renderAriaTree(this._lastAriaSnapshot, options);", `    if (options?.obuLimits) {
      const refs = [];
      const snapshot = renderAriaTree(this._lastAriaSnapshot, { ...options, obuRefs: refs });
      return { snapshot, refs, nodes: this._lastAriaSnapshot.obuNodeCount };
    }
    return renderAriaTree(this._lastAriaSnapshot, options);`);
  return source;
}

// These helpers run inside the pinned Playwright server bundle. They retain its
// native selectors, utility-world ARIA generator, Frame identities and deadlines.
const serverHelpers = `
const obuSnapshotCaps = ${JSON.stringify(caps)};
function obuSnapshotOptions(options) {
  const result = {};
  for (const [key, cap] of Object.entries(obuSnapshotCaps)) {
    const value = options[key] ?? cap;
    if (!Number.isSafeInteger(value) || value < 1 || value > cap) throw new Error("OBU_SNAPSHOT_LIMIT: invalid " + key);
    result[key] = value;
  }
  if (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout > 120000) throw new Error("OBU_SNAPSHOT_LIMIT: invalid timeout");
  return { ...result, timeout: options.timeout };
}
function obuFrameOrdinal(frameIds, frame) {
  let index = frameIds.indexOf(frame._id);
  if (index === -1) {
    index = frameIds.indexOf(null);
    if (index === -1) index = frameIds.length;
    frameIds[index] = frame._id;
  }
  return index + 1;
}
function obuSnapshotTime(budget) {
  const remaining = budget.deadline - performance.now();
  if (remaining <= 0) throw new TimeoutError$1("OBU_SNAPSHOT_TIMEOUT: capture deadline exceeded");
  return remaining;
}
async function obuSnapshotFrame(metadata, frame, ordinal, frameIds, budget, prefix = "", depth = 0) {
  if (++budget.frames > budget.limits.maxFrames) throw new Error("OBU_SNAPSHOT_LIMIT: maxFrames");
  const controller = new ProgressController(metadata, frame);
  const captured = await controller.run(progress => frame.retryWithProgressAndTimeouts(progress, [100, 250, 500], async continuePolling => {
    const context = await frame._utilityContext();
    const injected = await context.injectedScript();
    return await injected.evaluate((script, options) => {
      const body = script.document.body;
      if (!body) return null;
      return script.ariaSnapshot(body, options);
    }, { forAI: true, refPrefix: ordinal ? "f" + ordinal : "", obuLimits: {
      maxNodes: budget.limits.maxNodes - budget.nodes,
      maxRefs: budget.limits.maxRefs - budget.refs.length,
      maxBytes: budget.limits.maxBytes - budget.bytes,
      maxDepth: budget.limits.maxDepth - depth
    } }).then(value => value === null ? continuePolling : value);
  }), obuSnapshotTime(budget));
  budget.nodes += captured.nodes;
  const framesByLine = new Map();
  for (const item of captured.refs) {
    if (budget.seenRefs.has(item.ref)) throw new Error("OBU_SNAPSHOT_INCOMPLETE: duplicate native reference");
    budget.seenRefs.add(item.ref);
    budget.refs.push({ ref: item.ref, frameGuid: frame.guid });
    if (item.iframe) framesByLine.set(item.line, item);
  }
  const lines = captured.snapshot ? captured.snapshot.split("\\n") : [];
  for (let index = 0; index < lines.length; index++) {
    obuSnapshotTime(budget);
    const marker = framesByLine.get(index);
    const line = prefix + lines[index];
    budget.bytes += new TextEncoder().encode(line).length + (budget.lines.length ? 1 : 0);
    if (budget.bytes > budget.limits.maxBytes) throw new Error("OBU_SNAPSHOT_LIMIT: maxBytes");
    budget.lines.push(line);
    if (!marker) continue;
    const selector = "aria-ref=" + marker.ref + " >> internal:control=enter-frame >> body";
    const child = await frame.selectors.resolveFrameForSelector(selector, { strict: true });
    if (!child) throw new Error("OBU_SNAPSHOT_INCOMPLETE: iframe disappeared during capture");
    const childOrdinal = obuFrameOrdinal(frameIds, child.frame);
    await obuSnapshotFrame(metadata, child.frame, childOrdinal, frameIds, budget, prefix + marker.indent + "  ", depth + marker.depth);
  }
}
`;

export function patchCrxAISnapshot(source) {
  for (const parser of ["\nfunction parseSelector(selector) {", "\nfunction visitAllSelectorParts(selector, visitor) {"]) {
    if (source.split(parser).length !== 2) throw new Error("Pinned Playwright selector parser shape changed; review the capture-scoped reference guard");
  }
  const injectedStart = source.indexOf("const source$4 = ");
  const injectedEnd = source.indexOf("\n", injectedStart);
  if (injectedStart < 0 || injectedEnd < 0) throw new Error("Pinned Playwright AI injected source shape changed");
  const line = source.slice(injectedStart, injectedEnd);
  // The caller verifies the entire official bundle's pinned digest first. Only
  // its single generated string literal is decoded, never the runtime bundle.
  const decoded = vm.runInNewContext(line.slice("const source$4 = ".length, -1), {}, { timeout: 1000 });
  if (typeof decoded !== "string") throw new Error("Pinned Playwright AI injected source is not a string");
  const injected = patchInjectedAISnapshot(decoded);
  source = source.slice(0, injectedStart) + `const source$4 = ${JSON.stringify(injected)};` + source.slice(injectedEnd);
  source = replaceOnce(source, "scheme.PageSnapshotForAIParams = tOptional(tObject({}));\nscheme.PageSnapshotForAIResult = tObject({\n  snapshot: tString\n});", `scheme.PageSnapshotForAIParams = tOptional(tObject({
  bounded: tOptional(tBoolean), timeout: tOptional(tNumber),
  maxBytes: tOptional(tNumber), maxNodes: tOptional(tNumber), maxRefs: tOptional(tNumber), maxFrames: tOptional(tNumber), maxDepth: tOptional(tNumber)
}));
scheme.PageSnapshotForAIResult = tObject({
  snapshot: tString,
  refs: tOptional(tArray(tObject({ ref: tString, frameGuid: tString }))),
  stats: tOptional(tObject({ bytes: tNumber, nodes: tNumber, refs: tNumber, frames: tNumber })),
  complete: tOptional(tBoolean)
});`);
  source = replaceOnce(source, `  async snapshotForAI(metadata) {
    this.lastSnapshotFrameIds = [];
    const snapshot = await snapshotFrameForAI(metadata, this.mainFrame(), 0, this.lastSnapshotFrameIds);
    return snapshot.join("\\n");
  }`, `  async snapshotForAI(metadata, options = {}) {
    const liveFrames = this.frames();
    const liveIds = new Set(liveFrames.map(frame => frame._id));
    this.lastSnapshotFrameIds = this.lastSnapshotFrameIds.map(id => liveIds.has(id) ? id : null);
    while (this.lastSnapshotFrameIds.length && !this.lastSnapshotFrameIds.at(-1)) this.lastSnapshotFrameIds.pop();
    if (!options.bounded) {
      const snapshot = await snapshotFrameForAI(metadata, this.mainFrame(), 0, this.lastSnapshotFrameIds);
      return snapshot.join("\\n");
    }
    const limits = obuSnapshotOptions(options);
    if (liveFrames.length > limits.maxFrames || this.lastSnapshotFrameIds.length > limits.maxFrames) throw new Error("OBU_SNAPSHOT_LIMIT: maxFrames");
    const budget = { limits, deadline: performance.now() + limits.timeout, refs: [], seenRefs: new Set(), lines: [], bytes: 0, nodes: 0, frames: 0 };
    await obuSnapshotFrame(metadata, this.mainFrame(), 0, this.lastSnapshotFrameIds, budget);
    return { snapshot: budget.lines.join("\\n"), refs: budget.refs, stats: { bytes: budget.bytes, nodes: budget.nodes, refs: budget.refs.length, frames: budget.frames }, complete: true };
  }`);
  source = replaceOnce(source, "    const frameOrdinal2 = frameIds.length + 1;\n    frameIds.push(child.frame._id);", "    const frameOrdinal2 = obuFrameOrdinal(frameIds, child.frame);");
  source = replaceOnce(source, `  async snapshotForAI(params, metadata) {
    return { snapshot: await this._page.snapshotForAI(metadata) };
  }`, `  async snapshotForAI(params, metadata) {
    const result = await this._page.snapshotForAI(metadata, params);
    return typeof result === "string" ? { snapshot: result } : result;
  }`);
  return `${source}\n${selectorGuard}\n${serverHelpers}`;
}
