// The transport adapter owns tabs; Playwright owns locator and action semantics.
// No page JavaScript or arbitrary method names are accepted by this dispatcher.
import { BrowserDiagnostics } from "./browser-diagnostics.js";
import { AI_SNAPSHOT_LIMITS, BrowserObservation, isAIRef, snapshotLimits } from "./browser-observation.js";
export const BROWSER_ENGINE_INFO = Object.freeze({
  name: "playwright-crx",
  version: "0.15.0",
  playwrightVersion: "1.53.0",
  protocolVersion: 1,
  capabilities: Object.freeze({ snapshotAI: 1, captureRefs: 1 }),
  snapshotLimits: AI_SNAPSHOT_LIMITS,
  limitations: ["AI snapshots use OBU capture-scoped refs, not Playwright 1.59+ snapshot options or boxes", "Closed shadow roots are unsupported", "Incognito engine attachment is not yet supported"]
});

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;
export const LOCATOR_LIMITS = Object.freeze({ maxSteps: 32, maxTotalSteps: 128, maxDepth: 8 });
// Hidden cross-process frame hit-test surfaces need a committed compositor frame
// just like screenshots do. Hold the backend's rendering lease across the real
// Playwright operation; do not retry or synthesize successful pointer input.
const renderedActions = new Set([
  "screenshot", "click", "dblclick", "hover", "check", "uncheck", "setChecked",
  "dragTo", "scrollIntoViewIfNeeded", "mouse.move", "mouse.click", "mouse.wheel", "mouse.down", "mouse.up"
]);
const locatorActions = new Set([
  "click", "dblclick", "hover", "fill", "press", "check", "uncheck", "setChecked", "selectOption", "waitFor",
  "count", "innerText", "textContent", "inputValue", "getAttribute", "isVisible", "isEnabled", "isChecked",
  "boundingBox", "allTextContents", "allInnerTexts", "dragTo", "scrollIntoViewIfNeeded", "focus", "pressSequentially"
]);
const actionArguments = {
  engineInfo: [], snapshot: [], snapshotAI: Object.keys(AI_SNAPSHOT_LIMITS), diagnostics: ["after", "limit"],
  click: ["button", "clickCount", "delay", "modifiers", "position", "force"],
  dblclick: ["button", "delay", "modifiers", "position", "force"],
  hover: ["modifiers", "position", "force"],
  fill: ["value", "force"], press: ["key", "delay"],
  dragTo: ["target", "force", "sourcePosition", "targetPosition"],
  scrollIntoViewIfNeeded: [], focus: [], pressSequentially: ["text", "delay"],
  check: ["force", "position"], uncheck: ["force", "position"], setChecked: ["checked", "force", "position"],
  selectOption: ["values", "force"], waitFor: ["state"], count: [], innerText: [], textContent: [], inputValue: [],
  getAttribute: ["name"], isVisible: [], isEnabled: [], isChecked: [], boundingBox: [], allTextContents: [], allInnerTexts: [],
  screenshot: ["type", "quality", "fullPage", "omitBackground", "clip"],
  goto: ["url", "waitUntil"], waitForLoadState: ["state"], waitForURL: ["url", "waitUntil"],
  goBack: ["waitUntil"], goForward: ["waitUntil"], reload: ["waitUntil"],
  "mouse.move": ["x", "y", "steps"], "mouse.click": ["x", "y", "button", "clickCount", "delay"],
  "mouse.wheel": ["deltaX", "deltaY"], "keyboard.press": ["key", "delay"],
  "mouse.down": ["button", "clickCount"], "mouse.up": ["button", "clickCount"],
  "keyboard.type": ["text", "delay"], "keyboard.insertText": ["text"]
};

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function keys(value, allowed, label) {
  record(value, label);
  for (const name of Object.keys(value)) if (!allowed.includes(name)) throw new Error(`${label} does not support ${name}`);
}
function string(value, label, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new Error(`${label} must be a ${allowEmpty ? "" : "non-empty "}string`);
  return value;
}
function finite(value, label, minimum = -Infinity) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) throw new Error(`${label} must be a finite number >= ${minimum}`);
  return value;
}
function boolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
}
function oneOf(value, values, label) {
  if (!values.includes(value)) throw new Error(`${label} must be one of ${values.join(", ")}`);
}
function integer(value, label, minimum = 0) {
  finite(value, label, minimum);
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
}

export function validateBrowserAction(params) {
  keys(params, ["session_id", "turn_id", "control_epoch", "tabId", "action", "locator", "args", "timeoutMs"], "browserAction");
  string(params.session_id, "session_id");
  string(params.turn_id, "turn_id");
  if (params.control_epoch !== undefined && (!Number.isSafeInteger(params.control_epoch) || params.control_epoch < 1)) throw new Error("control_epoch must be a positive safe integer");
  integer(params.tabId, "tabId");
  string(params.action, "action");
  if (!Object.hasOwn(actionArguments, params.action)) throw new Error(`Unsupported browser action: ${params.action}`);
  const args = { ...record(params.args ?? {}, `${params.action} args`) };
  keys(args, actionArguments[params.action], `${params.action} args`);
  if (params.action === "snapshotAI") snapshotLimits(args);
  const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  finite(timeout, "timeoutMs", 1);
  if (timeout > MAX_TIMEOUT_MS) throw new Error(`timeoutMs must be <= ${MAX_TIMEOUT_MS}`);
  const locatorBudget = { steps: 0 };
  const steps = validateLocator(params.locator ?? [], locatorBudget);
  if (locatorActions.has(params.action) && (!steps.length || steps.at(-1)?.kind === "frame")) throw new Error(`${params.action} requires an element locator`);
  if (!locatorActions.has(params.action) && !["snapshot", "screenshot"].includes(params.action) && steps.length) throw new Error(`${params.action} does not accept a locator`);
  if (params.action === "screenshot" && steps.length && (Object.hasOwn(args, "fullPage") || Object.hasOwn(args, "clip"))) throw new Error("Locator screenshots do not support fullPage or clip; use a page screenshot instead");
  for (const key of ["force", "fullPage", "omitBackground"]) if (args[key] !== undefined) boolean(args[key], key);
  for (const key of ["delay", "quality"]) if (args[key] !== undefined) finite(args[key], key, 0);
  if (args.quality !== undefined && (!Number.isInteger(args.quality) || args.quality > 100)) throw new Error("quality must be an integer from 0 to 100");
  for (const key of ["steps", "clickCount"]) if (args[key] !== undefined) integer(args[key], key, 1);
  if (args.button !== undefined) oneOf(args.button, ["left", "right", "middle"], "button");
  if (args.type !== undefined) oneOf(args.type, ["png", "jpeg"], "type");
  if (args.modifiers !== undefined) {
    if (!Array.isArray(args.modifiers)) throw new Error("modifiers must be an array");
    for (const modifier of args.modifiers) oneOf(modifier, ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"], "modifier");
  }
  for (const key of ["position", "sourcePosition", "targetPosition"]) if (args[key] !== undefined) {
    keys(args[key], ["x", "y"], key); finite(args[key].x, `${key}.x`); finite(args[key].y, `${key}.y`);
  }
  if (params.action === "dragTo") {
    args.target = validateLocator(args.target, locatorBudget);
    if (!args.target.length || args.target.at(-1)?.kind === "frame") throw new Error("dragTo target requires an element locator");
  }
  if (params.action === "diagnostics") {
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200)) throw new Error("diagnostics limit must be an integer from 1 to 200");
    if (args.after !== undefined) {
      keys(args.after, ["captureId", "sequence"], "diagnostics after");
      string(args.after.captureId, "captureId");
      if (args.after.captureId.length > 128) throw new Error("captureId is too long");
      if (!Number.isSafeInteger(args.after.sequence) || args.after.sequence < 0) throw new Error("diagnostics sequence must be a nonnegative safe integer");
    }
  }
  if (args.clip !== undefined) {
    keys(args.clip, ["x", "y", "width", "height"], "clip");
    for (const key of ["x", "y"]) finite(args.clip[key], `clip.${key}`);
    for (const key of ["width", "height"]) if (finite(args.clip[key], `clip.${key}`, 0) === 0) throw new Error(`clip.${key} must be positive`);
  }
  if (params.action === "fill") string(args.value, "value", true);
  if (["press", "keyboard.press"].includes(params.action)) string(args.key, "key");
  if (["keyboard.type", "keyboard.insertText", "pressSequentially"].includes(params.action)) string(args.text, "text", true);
  if (params.action === "getAttribute") string(args.name, "name");
  if (params.action === "setChecked") boolean(args.checked, "checked");
  if (params.action === "selectOption") args.values = validateSelectValues(args.values);
  if (params.action === "waitFor" && args.state !== undefined) oneOf(args.state, ["attached", "detached", "visible", "hidden"], "state");
  if (params.action === "waitForLoadState" && args.state !== undefined) oneOf(args.state, ["load", "domcontentloaded", "networkidle"], "state");
  if (["goto", "waitForURL"].includes(params.action)) string(args.url, "url");
  if (args.waitUntil !== undefined) oneOf(args.waitUntil, ["load", "domcontentloaded", "networkidle", "commit"], "waitUntil");
  if (["mouse.move", "mouse.click"].includes(params.action)) { finite(args.x, "x"); finite(args.y, "y"); }
  if (params.action === "mouse.wheel") { finite(args.deltaX, "deltaX"); finite(args.deltaY, "deltaY"); }
  return { ...params, args, locator: steps, timeoutMs: timeout };
}

function validateSelectValues(values) {
  const entries = Array.isArray(values) ? values : [values];
  return Object.freeze(entries.map(value => {
    // The pinned client chooses its conversion from the first array item.
    // Normalize every entry to its native object shape so mixed inputs retain
    // string's value-OR-label matching instead of becoming an invalid channel.
    if (typeof value === "string") return Object.freeze({ valueOrLabel: value });
    keys(value, ["value", "label", "index"], "selectOption value");
    if (!Object.keys(value).length) throw new Error("selectOption value needs at least one of value, label, index");
    for (const key of ["value", "label"]) if (Object.hasOwn(value, key)) string(value[key], `selectOption ${key}`, true);
    if (Object.hasOwn(value, "index")) {
      if (!Number.isSafeInteger(value.index) || value.index < 0) throw new Error("selectOption index must be a nonnegative safe integer");
    }
    return Object.freeze({ ...value });
  }));
}

export function validateLocator(steps, budget = { steps: 0 }, depth = 0) {
  if (!Array.isArray(steps) || steps.length > LOCATOR_LIMITS.maxSteps) throw new Error("locator must be an array of at most 32 steps");
  if (depth > LOCATOR_LIMITS.maxDepth) throw new Error("locator nesting exceeds 8 levels");
  if (depth && !steps.length) throw new Error("nested locator must be a nonempty element-relative chain");
  budget.steps += steps.length;
  if (budget.steps > LOCATOR_LIMITS.maxTotalSteps) throw new Error("action locator trees exceed 128 total steps");
  let element = false;
  const result = [];
  for (const input of steps) {
    const step = { ...record(input, "locator step") };
    const kind = step.kind;
    if (kind === "ref") {
      if (depth) throw new Error("ref locators cannot be composed");
      keys(step, ["kind", "captureId", "ref"], "ref locator");
      string(step.captureId, "captureId");
      if (step.captureId.length > 128) throw new Error("captureId is too long");
      if (!isAIRef(step.ref)) throw new Error("ref must be a native element reference of at most 64 characters");
      if (steps.length !== 1) throw new Error("ref locator must be a singleton; chaining is unsupported");
      element = true;
    } else if (["css", "frame"].includes(kind)) {
      if (depth && kind === "frame") throw new Error("nested locators must stay in the current frame");
      keys(step, ["kind", "selector"], "locator step"); string(step.selector, "selector"); element = kind === "css";
    } else if (kind === "role") {
      keys(step, ["kind", "role", "name", "exact"], "role locator"); string(step.role, "role");
      if (step.name !== undefined) string(step.name, "name", true);
      if (step.exact !== undefined) boolean(step.exact, "exact");
      element = true;
    } else if (["text", "label", "placeholder", "altText", "title", "testId"].includes(kind)) {
      keys(step, ["kind", "value", ...(kind === "testId" ? [] : ["exact"])], `${kind} locator`);
      string(step.value, "value", true);
      if (step.exact !== undefined) boolean(step.exact, "exact");
      element = true;
    } else if (["nth", "first", "last", "filter", "and", "or"].includes(kind)) {
      if (!element) throw new Error(`${kind} requires an earlier element locator`);
      keys(step, kind === "nth" ? ["kind", "index"] : kind === "filter" ? ["kind", "hasText", "hasNotText", "has", "hasNot", "visible"] : ["and", "or"].includes(kind) ? ["kind", "locator"] : ["kind"], `${kind} locator`);
      if (kind === "nth") integer(step.index, "index");
      for (const key of ["hasText", "hasNotText"]) if (step[key] !== undefined) string(step[key], key, true);
      if (Object.hasOwn(step, "visible")) boolean(step.visible, "visible");
      for (const key of ["has", "hasNot"]) if (Object.hasOwn(step, key)) step[key] = validateLocator(step[key], budget, depth + 1);
      if (kind === "and" || kind === "or") step.locator = validateLocator(step.locator, budget, depth + 1);
    } else throw new Error(`Unsupported locator kind: ${String(kind)}`);
    result.push(Object.freeze(step));
  }
  return Object.freeze(result);
}

// Call only on validated trees. Parser-backed guards must see every selector,
// including nested filters/combinators and drag destinations. Relative nested
// selectors additionally forbid native enter-frame controls hidden in CSS.
export function visitLocatorSelectors(steps, visitor, frameRelative = false) {
  for (const step of steps) {
    if (step.kind === "css" || step.kind === "frame") visitor(step.selector, frameRelative);
    for (const key of ["has", "hasNot", "locator"]) if (step[key]) visitLocatorSelectors(step[key], visitor, true);
  }
}

export function resolveBrowserLocator(page, steps, resolveRef) {
  let target = page;
  for (const step of steps) {
    switch (step.kind) {
      case "ref": {
        if (!resolveRef) throw new Error("OBU_CAPTURE_EXPIRED: ref locator requires a current observation");
        target = resolveRef(step);
        break;
      }
      case "css": target = target.locator(step.selector); break;
      case "frame": target = target.frameLocator(step.selector); break;
      case "role": target = target.getByRole(step.role, { name: step.name, exact: step.exact }); break;
      case "text": target = target.getByText(step.value, { exact: step.exact }); break;
      case "label": target = target.getByLabel(step.value, { exact: step.exact }); break;
      case "placeholder": target = target.getByPlaceholder(step.value, { exact: step.exact }); break;
      case "altText": target = target.getByAltText(step.value, { exact: step.exact }); break;
      case "title": target = target.getByTitle(step.value, { exact: step.exact }); break;
      case "testId": target = target.getByTestId(step.value); break;
      case "nth": target = target.nth(step.index); break;
      case "first": target = target.first(); break;
      case "last": target = target.last(); break;
      case "filter": target = target.filter({ hasText: step.hasText, hasNotText: step.hasNotText, visible: step.visible,
        has: step.has && resolveBrowserLocator(page, step.has), hasNot: step.hasNot && resolveBrowserLocator(page, step.hasNot) }); break;
      case "and": target = target.and(resolveBrowserLocator(page, step.locator)); break;
      case "or": target = target.or(resolveBrowserLocator(page, step.locator)); break;
    }
  }
  return target;
}

async function execute(page, params, resolveRef, selectedTarget) {
  const { action, args, locator, timeoutMs: timeout } = params;
  const target = selectedTarget ?? resolveBrowserLocator(page, locator, resolveRef);
  const options = { ...args, timeout };
  switch (action) {
    case "snapshot": return (locator.length && locator.at(-1).kind !== "frame" ? target : target.locator("body")).ariaSnapshot({ timeout });
    case "click": return target.click(options);
    case "dblclick": return target.dblclick(options);
    case "hover": return target.hover(options);
    case "fill": { const { value, ...rest } = options; return target.fill(value, rest); }
    case "press": { const { key, ...rest } = options; return target.press(key, rest); }
    case "pressSequentially": { const { text, ...rest } = options; return target.pressSequentially(text, rest); }
    case "focus": return target.focus({ timeout });
    case "scrollIntoViewIfNeeded": return target.scrollIntoViewIfNeeded({ timeout });
    case "dragTo": { const { target: destination, ...rest } = options; return target.dragTo(resolveBrowserLocator(page, destination, resolveRef), rest); }
    case "check": return target.check(options);
    case "uncheck": return target.uncheck(options);
    case "setChecked": { const { checked, ...rest } = options; return target.setChecked(checked, rest); }
    case "selectOption": { const { values, ...rest } = options; return target.selectOption(values, rest); }
    case "waitFor": return target.waitFor(options);
    case "count": return target.count();
    case "innerText": return target.innerText({ timeout });
    case "textContent": return target.textContent({ timeout });
    case "inputValue": return target.inputValue({ timeout });
    case "getAttribute": return target.getAttribute(args.name, { timeout });
    case "isVisible": return target.isVisible();
    case "isEnabled": return target.isEnabled({ timeout });
    case "isChecked": return target.isChecked({ timeout });
    case "boundingBox": return target.boundingBox({ timeout });
    case "allTextContents": return target.allTextContents();
    case "allInnerTexts": return target.allInnerTexts();
    case "screenshot": {
      const imageTarget = locator.at(-1)?.kind === "frame" ? target.locator("body") : target;
      const bytes = await imageTarget.screenshot(options);
      return { base64: bytes.toString("base64"), mimeType: args.type === "jpeg" ? "image/jpeg" : "image/png" };
    }
    case "goto": { const response = await page.goto(args.url, { timeout, waitUntil: args.waitUntil }); return { url: page.url(), status: response?.status() ?? null }; }
    case "goBack": { const response = await page.goBack({ timeout, waitUntil: args.waitUntil }); return { url: page.url(), status: response?.status() ?? null }; }
    case "goForward": { const response = await page.goForward({ timeout, waitUntil: args.waitUntil }); return { url: page.url(), status: response?.status() ?? null }; }
    case "reload": { const response = await page.reload({ timeout, waitUntil: args.waitUntil }); return { url: page.url(), status: response?.status() ?? null }; }
    case "waitForLoadState": return page.waitForLoadState(args.state, { timeout });
    case "waitForURL": return page.waitForURL(args.url, { timeout, waitUntil: args.waitUntil });
    case "mouse.move": return page.mouse.move(args.x, args.y, { steps: args.steps });
    case "mouse.click": return page.mouse.click(args.x, args.y, { button: args.button, clickCount: args.clickCount, delay: args.delay });
    case "mouse.wheel": return page.mouse.wheel(args.deltaX, args.deltaY);
    case "mouse.down": return page.mouse.down({ button: args.button, clickCount: args.clickCount });
    case "mouse.up": return page.mouse.up({ button: args.button, clickCount: args.clickCount });
    case "keyboard.press": return page.keyboard.press(args.key, { delay: args.delay });
    case "keyboard.type": return page.keyboard.type(args.text, { delay: args.delay });
    case "keyboard.insertText": return page.keyboard.insertText(args.text);
  }
}

export class BrowserActionEngine {
  constructor({ loadRuntime = () => { throw new Error("BrowserActionEngine requires its statically bundled Playwright runtime"); }, onBeforeAttach = () => {}, onAttached = () => {}, onDetached = () => {}, onCommand = () => {}, isInternalEvent = () => false, aroundAction = ({ run }) => run(), authorize = () => {}, restrictedSelectors = () => false, inputHooks } = {}) {
    this.loadRuntime = loadRuntime;
    this.onBeforeAttach = onBeforeAttach;
    this.onAttached = onAttached;
    this.onDetached = onDetached;
    this.onCommand = onCommand;
    this.isInternalEvent = isInternalEvent;
    this.aroundAction = aroundAction;
    this.authorize = authorize;
    this.restrictedSelectors = restrictedSelectors;
    this.inputHooks = inputHooks;
    this.pages = new Map();
    this.queues = new Map();
    this.generations = new Map();
    this.active = new Map();
    this.apps = new Map();
    this.releases = new Map();
  }

  async runtime() {
    if (!this.runtimePromise) {
      this.runtimePromise = this.loadRuntime().then(runtime => {
        if (this.inputHooks) runtime.setOpenBrowserUseInputHooks(this.inputHooks);
        runtime.setOpenBrowserUseEventFilter(this.isInternalEvent);
        runtime.setOpenBrowserUseCommandObserver(({ target, method, commandParams }) => {
          const metadata = this.active.get(target.tabId);
          if (metadata) return this.onCommand({ target, method, commandParams, metadata });
        });
        return runtime;
      }).catch(error => { this.runtimePromise = undefined; throw error; });
    }
    return this.runtimePromise;
  }

  async attach(tabId, expectedGeneration = this.generations.get(tabId) ?? 0, beforeCreate) {
    // Do not allow stale attachment cleanup to detach a newer owner of the tab.
    await this.releases.get(tabId)?.catch(() => {});
    if ((this.generations.get(tabId) ?? 0) !== expectedGeneration) throw new Error("Browser action was cancelled before tab attachment");
    if (this.pages.has(tabId)) return this.pages.get(tabId);
    // Internal setup fence runs only for the actual creator, after release and
    // shared-attachment checks. It can reject a deadline before native work.
    beforeCreate?.();
    const generation = this.generations.get(tabId) ?? 0;
    const pending = (async () => {
      const runtime = await this.runtime();
      const { incognito } = await chrome.tabs.get(tabId);
      // CRX's incognito startup can select an unrelated existing private tab.
      // Do not enable that path until it has explicit session ownership routing.
      if (incognito) throw new Error("Browser action engine does not yet support incognito tabs");
      const key = incognito === true;
      if (!this.apps.has(key)) this.apps.set(key, runtime.crx.start(key ? { incognito: true } : {}).catch(error => { this.apps.delete(key); throw error; }));
      const app = await this.apps.get(key);
      await this.onBeforeAttach(tabId);
      if ((this.generations.get(tabId) ?? 0) !== generation) throw new Error("Browser action was cancelled before native attachment");
      const page = await app.attach(tabId);
      if ((this.generations.get(tabId) ?? 0) !== generation) {
        await app.detach(tabId);
        const cancelled = new Error("Browser action was cancelled while attaching the tab");
        cancelled.attachmentReleased = true;
        throw cancelled;
      }
      try { await this.onAttached(tabId); }
      catch (error) {
        try { await app.detach(tabId); await this.onDetached(tabId); }
        catch (cleanupError) {
          // A failed initialization is not proof that native ownership was
          // released. Preserve its token for explicit backend cleanup retry.
          if (error && typeof error === "object") error.cleanupError = cleanupError;
          else error = Object.assign(new Error(String(error)), { cleanupError });
        }
        throw error;
      }
      return { app, page };
    })();
    this.pages.set(tabId, pending);
    pending.catch(() => { if (this.pages.get(tabId) === pending) this.pages.delete(tabId); });
    return pending;
  }

  // Short, internal Page setup shares the action queue and attachment identity.
  // An observer's lifetime and collect operation must never run here.
  async withPage(params, {
    deadlineAt,
    isolateTimeout = false,
    timeoutError = () => new Error("OBU_NETWORK_WAIT_TIMEOUT: Page setup deadline expired"),
    expiredError = () => new Error("OBU_NETWORK_WAIT_EXPIRED: tab control ended during setup")
  }, callback) {
    integer(params.tabId, "tabId");
    string(params.session_id, "session_id");
    string(params.turn_id, "turn_id");
    if (!Number.isSafeInteger(params.control_epoch) || params.control_epoch < 1) throw new Error("control_epoch must be a positive safe integer");
    if (!Number.isFinite(deadlineAt) || typeof isolateTimeout !== "boolean" || typeof callback !== "function" || typeof timeoutError !== "function" || typeof expiredError !== "function") throw new Error("Invalid Page setup deadline, callback or error factory");
    const generation = this.generations.get(params.tabId) ?? 0;
    let expired = false, phase = "queued", timer, createdAttachment = false;
    const canDetachOnTimeout = () => phase !== "queued" && phase !== "finished" &&
      (!isolateTimeout || createdAttachment) && (this.generations.get(params.tabId) ?? 0) === generation;
    const timeout = timeoutError;
    const remainingMs = () => {
      const remaining = deadlineAt - performance.now();
      if (expired || remaining <= 0) { expired = true; throw timeout(); }
      return remaining;
    };
    const check = async () => {
      remainingMs();
      if ((this.generations.get(params.tabId) ?? 0) !== generation) throw expiredError();
      await this.authorize(params);
      remainingMs();
      if ((this.generations.get(params.tabId) ?? 0) !== generation) throw expiredError();
    };
    const previous = this.queues.get(params.tabId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      await check();
      phase = "attaching";
      // Observer registration may share a Page with other waits or held input,
      // including an attach already queued behind an asynchronous release.
      const entry = await this.attach(params.tabId, generation, () => {
        remainingMs();
        createdAttachment = true;
      });
      await check();
      phase = "registering";
      const result = await callback({ page: entry.page, entry, check, remainingMs });
      await check();
      phase = "finished";
      return result;
    });
    this.queues.set(params.tabId, current);
    current.finally(() => { if (this.queues.get(params.tabId) === current) this.queues.delete(params.tabId); }).catch(() => {});
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        // A setup that never started must not cancel the unrelated action in
        // front of it, nor may a stale setup detach a replacement generation.
        if (canDetachOnTimeout())
          this.detach(params.tabId).catch(() => {});
        reject(timeout());
      }, Math.max(0, deadlineAt - performance.now()));
    });
    try { return await Promise.race([current, deadline]); }
    catch (error) {
      // An awaited native operation can finish beyond the deadline before its
      // timer callback gets a turn. That path needs the same identity-fenced
      // cleanup as the timer, without cancelling a queued predecessor.
      if ((expired || performance.now() >= deadlineAt) && canDetachOnTimeout())
        this.detach(params.tabId).catch(() => {});
      throw error;
    }
    finally { clearTimeout(timer); }
  }

  // Actual settlement seam for source reservations. The caller owns the outer
  // budget/cancellation race and capacity; this promise retains the queue until
  // all native reads and source-handle cleanup really settle. Never detach here:
  // backend detach may itself be waiting for this source reservation to drain.
  resolveMediaSource(request, { deadlineAt, check: sourceCheck, onCancel }) {
    const validated = validateBrowserAction({
      session_id: request.session_id, turn_id: request.turn_id, control_epoch: request.control_epoch,
      tabId: request.tabId, action: "getAttribute", args: { name: "currentSrc" },
      locator: request.locator, timeoutMs: request.timeoutMs
    });
    if (!Number.isSafeInteger(validated.control_epoch) || validated.control_epoch < 1 || !Number.isFinite(deadlineAt) || typeof sourceCheck !== "function") throw new Error("Invalid media source admission");
    const params = validated;
    const generation = this.generations.get(params.tabId) ?? 0;
    const timeout = () => new Error("OBU_DOWNLOAD_TIMEOUT: media source deadline expired");
    const expired = () => new Error("OBU_MEDIA_SOURCE_CHANGED: media attachment or document changed");
    const remaining = () => { if (performance.now() >= deadlineAt) throw timeout(); };
    const attachment = this.pages.get(params.tabId);
    if (!attachment) throw expired();
    let entry, observation, revision;
    const check = async () => {
      remaining();
      if ((this.generations.get(params.tabId) ?? 0) !== generation || (attachment && this.pages.get(params.tabId) !== attachment)) throw expired();
      await sourceCheck(); remaining();
      if ((this.generations.get(params.tabId) ?? 0) !== generation || (attachment && this.pages.get(params.tabId) !== attachment)) throw expired();
      if (observation && (entry.observation !== observation || observation.disposed || observation.revision !== revision)) throw expired();
    };
    const previous = this.queues.get(params.tabId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      await check();
      const runtime = await this.runtime(); await check();
      // Media provenance always requires audited utility-world selector engines,
      // even when the user's ordinary browser actions are unrestricted.
      visitLocatorSelectors(params.locator, (selector, frameRelative) => runtime.assertOpenBrowserUseSelector(selector, true, frameRelative));
      // Admission already established this exact attachment. A stale source
      // must never reacquire a tab or enter ownership cleanup recursively.
      entry = await attachment; await check();
      const owner = JSON.stringify([params.session_id, params.control_epoch]);
      if (entry.diagnosticsOwner && entry.diagnosticsOwner !== owner) throw expired();
      entry.diagnosticsOwner = owner;
      observation = entry.observation ??= new BrowserObservation(entry.page);
      revision = observation.revision;
      const resolveRef = descriptor => { observation.get(descriptor); return entry.page.locator(`aria-ref=${descriptor.ref}`); };
      const locator = resolveBrowserLocator(entry.page, params.locator, resolveRef);
      const checkedSource = async () => {
        await check();
        if (params.locator[0]?.kind === "ref") observation.get(params.locator[0]);
      };
      await checkedSource();
      const result = await runtime.readMediaSource(locator, { deadlineAt, check: checkedSource, runNativeTask: runtime.runOpenBrowserUseMediaTask, onCancel });
      await checkedSource();
      return result;
    });
    this.queues.set(params.tabId, current);
    current.finally(() => { if (this.queues.get(params.tabId) === current) this.queues.delete(params.tabId); }).catch(() => {});
    return current;
  }

  async dispatch(request) {
    const params = validateBrowserAction(request);
    const generation = this.generations.get(params.tabId) ?? 0;
    const deadlineAt = performance.now() + params.timeoutMs;
    let expired = false;
    let phase = "queued";
    let release;
    let timer;
    const timeoutError = () => new Error(`Browser action timed out after ${params.timeoutMs}ms`);
    const checkTime = () => { if (expired || performance.now() >= deadlineAt) { expired = true; throw timeoutError(); } };
    const check = async () => {
      checkTime();
      if ((this.generations.get(params.tabId) ?? 0) !== generation) throw new Error("Browser action was cancelled because tab control ended");
      await this.authorize(params);
      checkTime();
      if ((this.generations.get(params.tabId) ?? 0) !== generation) throw new Error("Browser action was cancelled because tab control ended");
    };
    const previous = this.queues.get(params.tabId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      await check();
      if (params.action === "engineInfo") return { value: BROWSER_ENGINE_INFO, engine: BROWSER_ENGINE_INFO };
      const rawSelectors = [];
      const collectSelector = (selector, frameRelative) => rawSelectors.push({ selector, frameRelative });
      visitLocatorSelectors(params.locator, collectSelector);
      if (params.action === "dragTo") visitLocatorSelectors(params.args.target, collectSelector);
      if (rawSelectors.length) {
        const runtime = await this.runtime();
        await check();
        // Use the actual selector parser so reserved native ref engines cannot
        // bypass capture checks, including nested selectors. CSS/text literals
        // that happen to contain "aria-ref=" keep their native semantics.
        for (const step of rawSelectors) runtime.assertOpenBrowserUseSelector(step.selector, this.restrictedSelectors(), step.frameRelative);
      }
      phase = "attaching";
      const entry = await this.attach(params.tabId, generation);
      const { page } = entry;
      await check();
      const diagnosticsOwner = JSON.stringify([params.session_id, params.control_epoch ?? params.turn_id]);
      if (entry.diagnosticsOwner && entry.diagnosticsOwner !== diagnosticsOwner) {
        await this.detach(params.tabId);
        throw new Error("OBU_DIAGNOSTICS_OWNER_CHANGED: previous capture was released; submit a new authorized action");
      }
      if (!entry.diagnostics) {
        entry.diagnosticsOwner = diagnosticsOwner;
        entry.diagnostics = new BrowserDiagnostics(page);
      }
      entry.observation ??= new BrowserObservation(page);
      phase = "running";
      this.active.set(params.tabId, { session_id: params.session_id, turn_id: params.turn_id });
      try {
        const run = async () => {
          await check();
          if (params.action === "diagnostics") return entry.diagnostics.snapshot(params.args);
          const observation = entry.observation;
          const resolveRef = descriptor => {
            observation.get(descriptor);
            return page.locator(`aria-ref=${descriptor.ref}`);
          };
          if (params.action === "snapshotAI") {
            const revision = observation.begin();
            const limits = snapshotLimits(params.args);
            const runtime = await this.runtime();
            await check();
            const result = await runtime.captureAISnapshot(page, { ...limits, timeoutMs: Math.max(1, deadlineAt - performance.now()) });
            await check();
            return observation.publish(result, revision, limits);
          }
          // Resolve before an ordinary scoped snapshot invalidates the map. A
          // snapshot through a ref can run once; that capture then expires.
          const selectedTarget = resolveBrowserLocator(page, params.locator, resolveRef);
          if (params.action === "snapshot") observation.invalidate();
          if (params.action === "dragTo") {
            // Playwright presses the source before waiting for its destination.
            // A genuine locator wait prevents a certainly missing/hidden target
            // from starting input. Recheck ownership and the same total budget
            // afterward; a destination changing mid-drag remains observable.
            await resolveBrowserLocator(page, params.args.target, resolveRef).waitFor({ state: "visible", timeout: Math.max(1, deadlineAt - performance.now()) });
            await check();
            // A frame event during the destination wait invalidates either ref
            // before Playwright can press the source mouse button.
            for (const steps of [params.locator, params.args.target]) if (steps[0]?.kind === "ref") observation.get(steps[0]);
          }
          if (params.action === "screenshot") {
            if (params.locator[0]?.kind === "ref") {
              const descriptor = params.locator[0];
              const capture = observation.get(descriptor);
              const runtime = await this.runtime();
              await runtime.scrollAIRefIntoView(page, descriptor.ref, capture, {
                timeoutMs: Math.max(1, deadlineAt - performance.now()),
                check: async () => { await check(); observation.check(capture); }
              });
              await check();
              observation.check(capture);
            }
            // Chromium can suspend animation frames inside an offscreen iframe.
            // Playwright waits for the screenshot element to become stable
            // before scrolling it, so first reveal each frame owner from the
            // outside in. Keep genuine locator strictness/scroll semantics and
            // resolve every prefix afresh after navigation or DOM replacement.
            for (let index = 0; index < params.locator.length; index++) {
              const step = params.locator[index];
              if (step.kind !== "frame") continue;
              await check();
              const owner = resolveBrowserLocator(page, params.locator.slice(0, index)).locator(step.selector);
              await owner.scrollIntoViewIfNeeded({ timeout: Math.max(1, deadlineAt - performance.now()) });
              await check();
            }
          }
          return execute(page, { ...params, timeoutMs: Math.max(1, deadlineAt - performance.now()) }, resolveRef, selectedTarget);
        };
        const value = await (renderedActions.has(params.action)
          ? this.aroundAction({ params, timeoutMs: Math.max(1, deadlineAt - performance.now()), run })
          : run());
        await check();
        return { value: value ?? null, engine: BROWSER_ENGINE_INFO };
      } catch (error) {
        // Also release if Playwright's own deadline wins just before ours.
        if (!release && (error?.name === "TimeoutError" || ["dragTo", "mouse.down", "mouse.up"].includes(params.action))) release = this.detach(params.tabId);
        if (release) await release.catch(cleanupError => { if (error && typeof error === "object") error.cleanupError = cleanupError; });
        throw error;
      } finally {
        this.active.delete(params.tabId);
        phase = "finished";
      }
    });
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        if (phase === "queued" || phase === "finished") { reject(timeoutError()); return; }
        release = this.detach(params.tabId);
        // An in-flight attachment cannot execute input after the generation
        // check. Keep its cleanup barrier, but do not make the RPC unbounded.
        if (phase === "attaching") { release.catch(() => {}); reject(timeoutError()); return; }
        release.then(() => reject(timeoutError()), cleanupError => { const error = timeoutError(); error.cleanupError = cleanupError; reject(error); });
      }, Math.max(0, deadlineAt - performance.now()));
    });
    this.queues.set(params.tabId, current);
    current.finally(() => { if (this.queues.get(params.tabId) === current) this.queues.delete(params.tabId); }).catch(() => {});
    try { return await Promise.race([current, deadline]); }
    catch (error) {
      if (expired) {
        if (!release && phase !== "queued" && phase !== "finished") release = this.detach(params.tabId);
        if (release) {
          if (phase === "running" || phase === "finished") await release.catch(cleanupError => { if (error && typeof error === "object") error.cleanupError = cleanupError; });
          else release.catch(() => {});
        }
        const timeout = timeoutError();
        if (error?.cleanupError) timeout.cleanupError = error.cleanupError;
        throw timeout;
      }
      throw error;
    }
    finally { clearTimeout(timer); }
  }

  // Revoke queued/attaching work without destroying the native context needed
  // by pending media, export, clipboard, or held-input cleanup.
  invalidate(tabId) {
    this.generations.set(tabId, (this.generations.get(tabId) ?? 0) + 1);
    this.active.delete(tabId);
  }

  detach(tabId) {
    this.invalidate(tabId);
    if (this.releases.has(tabId)) return this.releases.get(tabId);
    const pending = this.pages.get(tabId);
    const release = (async () => {
      try {
        let entry;
        try { entry = await pending; }
        catch (error) {
          // This exact cancellation path already completed native cleanup.
          // Other attach errors may include an unconfirmed native release.
          if (error?.attachmentReleased !== true) throw error;
          await this.onDetached(tabId);
          return;
        }
        if (entry) {
          entry.diagnostics?.dispose();
          entry.observation?.dispose();
          await entry.app.detach(tabId);
          await this.onDetached(tabId);
        }
      }
      finally {
        if (this.pages.get(tabId) === pending) this.pages.delete(tabId);
      }
    })();
    this.releases.set(tabId, release);
    release.finally(() => { if (this.releases.get(tabId) === release) this.releases.delete(tabId); }).catch(() => {});
    return release;
  }

  // The backend fences new admission before using this snapshot to cancel and
  // drain all control, including attachments no longer in a task's tab group.
  // Do not hide pending rejections: the caller decides which cleanup failed.
  controlSnapshot() {
    return {
      tabIds: [...new Set([...this.pages.keys(), ...this.releases.keys(), ...this.queues.keys()])],
      pending: [...new Set([...this.pages.values(), ...this.releases.values(), ...this.queues.values()])]
    };
  }

  // Browser-initiated detach must invalidate queued operations as well.
  forget(tabId) {
    this.generations.set(tabId, (this.generations.get(tabId) ?? 0) + 1);
    this.active.delete(tabId);
    this.pages.get(tabId)?.then(entry => { entry.diagnostics?.dispose(); entry.observation?.dispose(); }).catch(() => {});
    this.pages.delete(tabId);
  }
}
