import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./content-cursor.js", import.meta.url), "utf8");

function createPage({ reducedMotion = false, popoverAPI = true, cssZoomAPI = true } = {}) {
  const timers = new Map();
  const frames = new Map();
  const listeners = new Map();
  const animations = [];
  const sent = [];
  const popoverCalls = [];
  const topLayer = [];
  const popoverFailures = new Map();
  const zoomReads = [];
  const computedStyleReads = [];
  const hitTests = [];
  let nextTimer = 1;
  let timestamp = 0;
  let onMessage;
  let resolveInitialState;
  let hitElements = [];

  class Element {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.style = {};
      this.dataset = {};
      this.attributes = new Map();
      this.children = [];
      this.parentNode = null;
      this.rect = { left: 10, top: 20, width: 80, height: 40 };
    }
    get isConnected() {
      return this === document.documentElement || this.host?.isConnected === true || this.parentNode?.isConnected === true;
    }
    get parentElement() { return this.parentNode?.tagName === "#SHADOW-ROOT" ? null : this.parentNode; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    attachShadow(options) {
      assert.equal(this.shadowRoot, undefined);
      const shadow = new Element("#shadow-root");
      shadow.host = this;
      shadow.options = options;
      this.shadowRoot = shadow;
      return shadow;
    }
    getRootNode() { return this.parentNode?.getRootNode() ?? this; }
    matches(selector) {
      assert.equal(selector, ":popover-open");
      return topLayer.includes(this);
    }
    showPopover(...args) {
      popoverCalls.push({ method: "show", element: this, args, root: this.getRootNode() });
      if (popoverFailures.has("show")) { const error = popoverFailures.get("show"); popoverFailures.delete("show"); throw error; }
      assert.equal(this.isConnected, true);
      assert.equal(this.attributes.get("popover"), "manual");
      if (!topLayer.includes(this)) topLayer.push(this);
    }
    hidePopover(...args) {
      popoverCalls.push({ method: "hide", element: this, args, root: this.getRootNode() });
      if (popoverFailures.has("hide")) { const error = popoverFailures.get("hide"); popoverFailures.delete("hide"); throw error; }
      const index = topLayer.indexOf(this);
      if (index !== -1) topLayer.splice(index, 1);
    }
    appendChild(child) {
      child.remove();
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    replaceChildren(...children) {
      for (const child of [...this.children]) child.remove();
      for (const child of children) this.appendChild(child);
    }
    remove() {
      if (this.parentNode) {
        const children = this.parentNode.children;
        children.splice(children.indexOf(this), 1);
        this.parentNode = null;
      }
      for (let index = topLayer.length - 1; index >= 0; index--) if (!topLayer[index].isConnected) topLayer.splice(index, 1);
    }
    contains(element) {
      return this === element || this.children.some((child) => child.contains(element));
    }
    closest(selector) {
      const selectors = selector.split(",");
      for (let element = this; element; element = element.parentElement) {
        if (selectors.some((part) => {
          if (part === element.tagName.toLowerCase()) return true;
          if (part === "a[href]") return element.tagName === "A" && element.attributes.has("href");
          if (part.startsWith('[role="')) return element.attributes.get("role") === part.slice(7, -2);
          if (part.startsWith("[contenteditable]")) {
            return element.attributes.has("contenteditable") && element.attributes.get("contenteditable") !== "false";
          }
          return part.startsWith("[tabindex]") && element.attributes.has("tabindex") && element.attributes.get("tabindex") !== "-1";
        })) return element;
      }
      return null;
    }
    getBoundingClientRect() { return this.rect; }
    animate(keyframes, options) {
      const animation = { keyframes, options, canceled: false, cancel() { this.canceled = true; } };
      animations.push(animation);
      return animation;
    }
    focus() { throw new Error("Overlay must not focus the page"); }
  }
  if (!popoverAPI) {
    Element.prototype.showPopover = undefined;
    Element.prototype.hidePopover = undefined;
  }
  // Model only CSS zoom's multiplicative flat-tree units. Browser tests cover
  // actual top-layer layout, screenshots, and original native input delivery.
  const zoomFactor = (value) => {
    const parsed = typeof value === "string" && value.endsWith("%") ? Number(value.slice(0, -1)) / 100 : Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  };
  const effectiveZoom = (element) => {
    if (!element) return 1;
    return zoomFactor(element.style.zoom) * effectiveZoom(element.parentNode ?? element.host);
  };
  if (cssZoomAPI) Object.defineProperty(Element.prototype, "currentCSSZoom", {
    get() {
      zoomReads.push(this);
      for (let node = this; node; node = node.parentNode ?? node.host) {
        if (node.style.display === "none") return 1;
      }
      return effectiveZoom(this);
    }
  });
  const document = {
    createElement: (tagName) => new Element(tagName),
    getElementById: (id) => document.documentElement ? findAll(document.documentElement, (element) => element.id === id)[0] ?? null : null,
    elementsFromPoint: (x, y) => { hitTests.push({ x, y }); return hitElements; }
  };
  document.documentElement = new Element("html");
  document.body = document.documentElement.appendChild(new Element("body"));
  const addListener = (type, callback) => {
    const callbacks = listeners.get(type) ?? [];
    callbacks.push(callback);
    listeners.set(type, callbacks);
  };
  const window = {
    innerWidth: 1000,
    innerHeight: 800,
    getComputedStyle: (element) => {
      computedStyleReads.push(element);
      return { zoom: element.style.zoom ?? "1" };
    },
    addEventListener: addListener,
    visualViewport: { width: 1000, height: 800, addEventListener: addListener },
    matchMedia: () => ({ matches: reducedMotion }),
    setTimeout: (callback, delay) => {
      const id = nextTimer++;
      timers.set(id, { callback, due: timestamp + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (callback) => {
      const id = nextTimer++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => frames.delete(id)
  };
  const context = vm.createContext({
    document, window,
    performance: { now: () => timestamp },
    chrome: {
      runtime: {
        onMessage: { addListener: (callback) => { onMessage = callback; } },
        getURL: (path) => `chrome-extension://test/${path}`,
        sendMessage: (message) => {
          sent.push(message);
          if (message.type === "GET_OPEN_BROWSER_USE_CURSOR_STATE") {
            return new Promise((resolve) => { resolveInitialState = resolve; });
          }
          return Promise.resolve({ ok: true });
        }
      }
    }
  });
  vm.runInContext(source, context);
  const page = {
    document, timers, frames, animations, sent, popoverCalls, topLayer,
    effectiveZoom, zoomReads, computedStyleReads, hitTests,
    failPopover: (method) => popoverFailures.set(method, new Error(`Native ${method} failed`)),
    elements: (testId) => document.documentElement ? findAll(document.documentElement, (element) => element.dataset.testid === testId, true) : [],
    add: (tagName, parent = document.body) => parent.appendChild(document.createElement(tagName)),
    hit: (...elements) => { hitElements = elements; },
    send: (message) => {
      let response;
      assert.equal(onMessage(message, {}, (value) => { response = value; }), true);
      assert.equal(response.ok, true);
    },
    move: (extra = {}) => page.send({
      type: "OPEN_BROWSER_USE_CURSOR", x: 40, y: 30,
      sessionId: "test-session", turnId: "test-turn", moveSequence: 1, ...extra
    }),
    click: (extra = {}) => page.send({
      type: "OPEN_BROWSER_USE_POINTER_EVENT", x: 40, y: 30,
      sessionId: "test-session", turnId: "test-turn", eventType: "mousePressed", ...extra
    }),
    hide: () => page.send({ type: "OPEN_BROWSER_USE_CURSOR_STATE", state: { isVisible: false } }),
    emit: (type) => { for (const callback of listeners.get(type) ?? []) callback(); },
    advance: (milliseconds) => {
      const end = timestamp + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, item]) => item.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, item] = next;
        timestamp = item.due;
        timers.delete(id);
        item.callback();
      }
      timestamp = end;
    },
    initialState: (state) => resolveInitialState({ ok: true, state })
  };
  return page;
}

function findAll(element, predicate, includeShadow = false) {
  const children = [...element.children, ...(includeShadow && element.shadowRoot ? [element.shadowRoot] : [])];
  return [element, ...children.flatMap((child) => findAll(child, () => true, includeShadow))].filter(predicate);
}

// The VM models native popover calls and membership, not browser rendering or
// event propagation. Real screenshots and page capture listeners cover those.
test("feedback lives in a non-focusable shadow-owned manual popover", () => {
  const page = createPage({ reducedMotion: true });
  page.move(); page.click();
  const host = page.document.getElementById("open-browser-use-cursor-root");
  const [layer] = page.elements("browser-agent-layer");
  assert.ok(host.shadowRoot); assert.deepEqual({ ...host.shadowRoot.options }, { mode: "open" });
  assert.equal(layer.getRootNode(), host.shadowRoot);
  assert.equal(layer.parentElement, null, "Native ShadowRoot is a parent Node, not a parent Element");
  assert.equal(layer.parentNode, host.shadowRoot);
  assert.equal(layer.attributes.get("popover"), "manual");
  assert.equal(host.attributes.get("aria-hidden"), "true");
  for (const node of findAll(host, () => true, true)) {
    assert.equal(node.attributes.has("tabindex"), false);
    assert.equal(node.attributes.has("autofocus"), false);
  }
  for (const name of ["browser-agent-cursor", "browser-agent-target", "browser-agent-click"]) {
    assert.equal(page.elements(name)[0].getRootNode(), host.shadowRoot);
  }
  assert.equal(layer.style.margin, "0"); assert.equal(layer.style.padding, "0"); assert.equal(layer.style.border, "0");
  assert.equal(layer.style.width, "auto"); assert.equal(layer.style.height, "auto");
  assert.equal(layer.style.background, "transparent"); assert.equal(layer.style.pointerEvents, "none");
  assert.notEqual(layer.style.all, "initial"); assert.notEqual(layer.style.display, "block");
  assert.ok(findAll(host.shadowRoot, node => node.tagName === "STYLE").some(node => /::backdrop\s*\{[^}]*display:\s*none/.test(node.textContent)));
  assert.ok(page.popoverCalls.length > 0);
  for (const call of page.popoverCalls) { assert.equal(call.root, host.shadowRoot); assert.deepEqual(call.args, []); }
  page.hide();
});

test("only new visible feedback raises the layer above later application UI", () => {
  const page = createPage(); page.move({ animateMovement: false });
  const [layer] = page.elements("browser-agent-layer"), dialog = page.add("dialog");
  page.topLayer.push(dialog);
  page.move({ x: 600, y: 400, moveSequence: 2 });
  assert.equal(page.topLayer.at(-1), layer); assert.equal(page.topLayer.includes(dialog), true);
  const calls = page.popoverCalls.length;
  for (const [id, frame] of [...page.frames]) { page.frames.delete(id); frame(20); }
  assert.equal(page.popoverCalls.length, calls, "Animation must not reorder the top layer");
  page.topLayer.push(page.add("section"));
  page.click(); assert.equal(page.topLayer.at(-1), layer);
  page.emit("scroll"); page.emit("resize");
  assert.equal(page.popoverCalls.length, calls + 2, "Passive viewport events do not reopen the layer");
  page.hide();
});

test("hidden and destroyed feedback closes its original native layer", () => {
  const page = createPage(); page.hide(); assert.equal(page.popoverCalls.length, 0);
  page.move(); page.click(); const [layer] = page.elements("browser-agent-layer");
  const host = page.document.getElementById("open-browser-use-cursor-root");
  page.hide(); assert.equal(layer.matches(":popover-open"), false); assert.equal(layer.style.display, "none");
  assert.equal(page.frames.size, 0); assert.equal(page.timers.size, 0);
  const count = page.popoverCalls.length; page.hide(); assert.equal(page.popoverCalls.length, count);
  page.move({ turnId: "next" }); assert.equal(layer.matches(":popover-open"), true); assert.notEqual(layer.style.display, "none");
  page.emit("pagehide"); assert.equal(host.isConnected, false); assert.equal(layer.isConnected, false); assert.equal(page.topLayer.includes(layer), false);
  page.move(); assert.notEqual(page.elements("browser-agent-layer")[0], layer); page.hide();
});

test("missing native popover APIs retain ordinary cursor and outline feedback", () => {
  const page = createPage({ reducedMotion: true, popoverAPI: false }); page.hit(page.add("button"));
  page.move(); page.click();
  const [layer] = page.elements("browser-agent-layer");
  assert.equal(layer.attributes.has("popover"), false); assert.equal(page.popoverCalls.length, 0);
  assert.equal(page.elements("browser-agent-cursor")[0].style.opacity, "1");
  assert.equal(page.elements("browser-agent-target")[0].style.display, "block");
  assert.equal(page.elements("browser-agent-click").length, 1);
  page.hide(); assert.equal(layer.style.display, "none");
});

test("native popover exceptions are best effort and later feedback can recover", () => {
  const page = createPage({ reducedMotion: true }); page.failPopover("show"); page.move();
  const [layer] = page.elements("browser-agent-layer"); assert.equal(layer.matches(":popover-open"), false);
  page.move({ moveSequence: 2 }); assert.equal(layer.matches(":popover-open"), true);
  page.failPopover("hide"); page.hide(); assert.equal(layer.style.display, "none", "Even a failed hide cannot leave visible feedback");
  page.move({ moveSequence: 3 }); assert.equal(layer.matches(":popover-open"), true); assert.notEqual(layer.style.display, "none");
  page.hide(); assert.equal(layer.matches(":popover-open"), false);
});

function assertViewportFeedback(page, point, rect) {
  const [cursor] = page.elements("browser-agent-cursor");
  const match = /^translate3d\(([-\d.]+)px, ([-\d.]+)px, 0\)/.exec(cursor.style.transform);
  assert.ok(match);
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 0.000001, `${label}: ${actual} !== ${expected}`);
  near((Number(match[1]) + 12) * page.effectiveZoom(cursor), point.x, "Viewport cursor center x");
  near((Number(match[2]) + 12) * page.effectiveZoom(cursor), point.y, "Viewport cursor center y");
  near(Number.parseFloat(cursor.style.width) * page.effectiveZoom(cursor), 24, "Viewport cursor size");
  const [outline] = page.elements("browser-agent-target");
  assert.equal(outline.style.display, "block");
  for (const key of ["left", "top", "width", "height"]) {
    near(Number.parseFloat(outline.style[key]) * page.effectiveZoom(outline), rect[key], `Viewport outline ${key}`);
  }
  const ring = page.elements("browser-agent-click").at(-1);
  if (ring) {
    near(Number.parseFloat(ring.style.left) * page.effectiveZoom(ring), point.x, "Viewport click center x");
    near(Number.parseFloat(ring.style.top) * page.effectiveZoom(ring), point.y, "Viewport click center y");
    near(Number.parseFloat(ring.style.width) * page.effectiveZoom(ring), 28, "Viewport click size");
  }
}

test("root CSS zoom does not rescale viewport cursor, target, or original click coordinates", () => {
  for (const zoom of [1.5, 0.75]) {
    const page = createPage({ reducedMotion: true });
    page.document.documentElement.style.zoom = String(zoom);
    const button = page.add("button");
    button.rect = { left: 180, top: 100, width: 160, height: 50 };
    page.hit(button);
    const point = { x: 260, y: 125 };
    page.move({ ...point, animateMovement: false }); page.click(point);
    assertViewportFeedback(page, point, button.rect);
    assert.deepEqual(page.hitTests, [point, point], "Hit testing keeps the original viewport coordinates");
    assert.deepEqual(page.document.documentElement.style, { zoom: String(zoom) });
    assert.deepEqual(button.style, {}, "Business element styles remain untouched");
    assert.equal(page.sent.some(message => /INPUT|MOUSE|CLICK/.test(message.type)), false);
    page.hide();
  }
});

test("dynamic root zoom is re-read for visible feedback without inverse-zoom oscillation", () => {
  const page = createPage({ reducedMotion: true });
  const button = page.add("button"); page.hit(button);
  const point = { x: 40, y: 30 };
  for (const zoom of [1.5, 1.5, 0.75, 0.75, 1, 1]) {
    page.document.documentElement.style.zoom = String(zoom);
    page.move({ ...point, animateMovement: false });
    assertViewportFeedback(page, point, button.rect);
  }
  assert.ok(page.zoomReads.length > 0);
  assert.ok(page.zoomReads.every(element => element === page.document.documentElement), "Never measure an already compensated or hidden owned layer");
  page.hide();
});

test("a click after a root zoom change refreshes all existing feedback at the original point", () => {
  const page = createPage({ reducedMotion: true });
  const button = page.add("button"); page.hit(button);
  const point = { x: 40, y: 30 };
  page.move({ ...point, animateMovement: false });
  page.document.documentElement.style.zoom = "2";
  page.click(point);
  assertViewportFeedback(page, point, button.rect);
  page.hide();
});

test("business subtree zoom is already represented by its viewport rect and is not canceled", () => {
  const page = createPage({ reducedMotion: true });
  page.document.documentElement.style.zoom = "1.5";
  page.document.body.style.zoom = "2";
  const button = page.add("button"); button.style.zoom = "0.5";
  button.rect = { left: 210, top: 90, width: 120, height: 60 };
  page.hit(button);
  const point = { x: 250, y: 120 };
  page.move({ ...point, animateMovement: false }); page.click(point);
  assertViewportFeedback(page, point, button.rect);
  assert.deepEqual(page.document.body.style, { zoom: "2" });
  assert.deepEqual(button.style, { zoom: "0.5" });
  assert.ok([...page.zoomReads, ...page.computedStyleReads].every(element => element === page.document.documentElement));
  page.hide();
});

test("the root computed zoom fallback works without currentCSSZoom or native popovers", () => {
  for (const popoverAPI of [true, false]) {
    const page = createPage({ reducedMotion: true, cssZoomAPI: false, popoverAPI });
    const button = page.add("button"); page.hit(button);
    const point = { x: 40, y: 30 };
    for (const zoom of ["150%", "0.75", "1"]) {
      page.document.documentElement.style.zoom = zoom;
      page.move({ ...point, animateMovement: false }); page.click(point);
      assertViewportFeedback(page, point, button.rect);
    }
    assert.ok(page.computedStyleReads.length > 0);
    assert.ok(page.computedStyleReads.every(element => element === page.document.documentElement));
    page.hide();
  }
});

test("missing or invalid zoom values retain finite ordinary feedback", () => {
  for (const zoom of [undefined, "normal", "0", "-1", "Infinity", "bad"]) {
    const page = createPage({ reducedMotion: true, cssZoomAPI: false });
    page.document.documentElement.style.zoom = zoom;
    const button = page.add("button"); page.hit(button);
    const point = { x: 40, y: 30 };
    page.move({ ...point, animateMovement: false }); page.click(point);
    assertViewportFeedback(page, point, button.rect);
    page.hide();
  }
});

test("zoom refresh never schedules polling, reopens hidden feedback, or repeats layout reads from animation frames", () => {
  const page = createPage(); const button = page.add("button"); page.hit(button);
  page.document.documentElement.style.zoom = "1.5";
  page.move({ animateMovement: false });
  page.move({ x: 200, y: 300, moveSequence: 2 });
  const before = page.zoomReads.length + page.computedStyleReads.length;
  assert.ok(before > 0);
  for (const [id, frame] of [...page.frames]) { page.frames.delete(id); frame(20); }
  assert.equal(page.zoomReads.length + page.computedStyleReads.length, before);
  assert.equal(page.timers.size, page.frames.size, "Only the existing per-frame fallback timer, no zoom polling");
  assert.ok([...page.timers.values()].every(timer => timer.due === 1000 / 60));
  page.hide(); const calls = page.popoverCalls.length;
  page.document.documentElement.style.zoom = "0.75";
  page.emit("resize"); page.emit("scroll"); page.click();
  assert.equal(page.popoverCalls.length, calls);
  assert.equal(page.frames.size, 0); assert.equal(page.timers.size, 0);
  page.move({ x: 40, y: 30, animateMovement: false });
  assertViewportFeedback(page, { x: 40, y: 30 }, button.rect);
  page.emit("pagehide"); page.emit("resize"); page.click();
  assert.equal(page.document.getElementById("open-browser-use-cursor-root"), null);
  assert.equal(page.frames.size, 0); assert.equal(page.timers.size, 0);
});

test("moving the AI cursor outlines the interactive ancestor without changing page elements", () => {
  const page = createPage();
  const button = page.add("button");
  const label = page.add("span", button);
  label.rect = { left: 30, top: 25, width: 20, height: 15 };
  button.style.background = "red";
  page.hit(label);
  page.move();
  const [outline] = page.elements("browser-agent-target");
  assert.equal(outline.style.display, "block");
  assert.equal(outline.style.left, "10px");
  assert.equal(outline.style.width, "80px");
  assert.equal(outline.style.pointerEvents, "none");
  assert.equal(documentStyle(page, "open-browser-use-cursor-root").pointerEvents, "none");
  assert.deepEqual(button.style, { background: "red" });
  assert.deepEqual(label.style, {});
  page.hide();
});

test("print exclusion is scoped to the feedback root and leaves screen and page styling intact", () => {
  const page = createPage({ reducedMotion: true });
  const pageStyle = page.add("style"); pageStyle.textContent = "@media print { button { color: black; } }";
  const button = page.add("button"); button.style.display = "inline-block"; page.hit(button);
  page.move({ animateMovement: false }); page.click();
  const root = page.document.getElementById("open-browser-use-cursor-root");
  const styles = findAll(root, node => node.tagName === "STYLE");
  assert.equal(styles.length, 1, "The created renderer must carry its print exclusion");
  // This VM checks the actual DOM-authored CSS contract, not CSS layout. The
  // browser integration separately renders the original exported PDF pixels.
  assert.match(styles[0].textContent, /^\s*@media\s+print\s*\{\s*#open-browser-use-cursor-root\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}\s*\}\s*$/);
  assert.equal(styles[0].parentElement, root);
  assert.notEqual(root.style.display, "none");
  assert.equal(page.elements("browser-agent-cursor")[0].style.opacity, "1");
  assert.equal(page.elements("browser-agent-target")[0].style.display, "block");
  assert.equal(page.elements("browser-agent-click").length, 1);
  assert.equal(pageStyle.textContent, "@media print { button { color: black; } }");
  assert.deepEqual(button.style, { display: "inline-block" });
  const before = JSON.stringify(page.sent), timers = page.timers.size;
  page.emit("beforeprint"); page.emit("afterprint");
  assert.equal(JSON.stringify(page.sent), before, "Printing does not ask for browser control or input");
  assert.equal(page.timers.size, timers);
  assert.equal(page.elements("browser-agent-target")[0].style.display, "block");
  page.hide();
});

test("print stylesheet shares renderer lifetime without accumulating across moves and turns", () => {
  const page = createPage({ reducedMotion: true }); page.move();
  const root = page.document.getElementById("open-browser-use-cursor-root");
  const stylesheet = findAll(root, node => node.tagName === "STYLE")[0]; assert.ok(stylesheet);
  page.move({ moveSequence: 2 }); page.hide(); page.move({ turnId: "next", moveSequence: 3 });
  assert.deepEqual(findAll(root, node => node.tagName === "STYLE"), [stylesheet]);
  page.emit("pagehide"); assert.equal(root.isConnected, false); assert.equal(stylesheet.isConnected, false);
  page.move({ turnId: "restored", moveSequence: 4 });
  const restored = page.document.getElementById("open-browser-use-cursor-root");
  assert.notEqual(restored, root);
  const styles = findAll(restored, node => node.tagName === "STYLE"); assert.equal(styles.length, 1);
  assert.equal(styles[0].textContent, stylesheet.textContent);
  page.hide(); assert.equal(page.timers.size, 0); assert.equal(page.frames.size, 0);
});

test("hit testing ignores overlay nodes and highlights an iframe without entering it", () => {
  const page = createPage();
  const frame = page.add("iframe");
  frame.rect = { left: 15, top: 25, width: 320, height: 180 };
  Object.defineProperty(frame, "contentDocument", { get() { throw new Error("Must not enter child frames"); } });
  page.move();
  const [cursor] = page.elements("browser-agent-cursor");
  // Document hit testing retargets a shadow descendant to its host. Exclude
  // both that host and any directly reported feedback descendant.
  page.hit(page.document.getElementById("open-browser-use-cursor-root"), cursor, frame);
  page.move({ x: 90, y: 80, moveSequence: 2 });
  const [outline] = page.elements("browser-agent-target");
  assert.equal(outline.style.left, "15px");
  assert.equal(outline.style.width, "320px");
  page.hit(page.document.body);
  page.move();
  assert.equal(outline.style.display, "none");
  page.hide();
});

test("original frame target border feedback replaces the opaque iframe outline without entering its document", () => {
  const page = createPage({ reducedMotion: true });
  const frame = page.add("iframe");
  frame.rect = { left: 15, top: 25, width: 320, height: 180 };
  Object.defineProperty(frame, "contentDocument", { get() { throw new Error("Feedback must not resolve another child document"); } });
  page.hit(frame);
  const targetRect = { x: 91.25, y: 73.5, width: 87.75, height: 29.25 };
  page.move({ x: 135, y: 88, animateMovement: false, targetRect });
  const [outline] = page.elements("browser-agent-target");
  assert.equal(outline.style.display, "block");
  assert.equal(outline.style.left, "91.25px");
  assert.equal(outline.style.top, "73.5px");
  assert.equal(outline.style.width, "87.75px");
  assert.equal(outline.style.height, "29.25px");
  assert.deepEqual(frame.style, {}, "The renderer changes only its owned feedback nodes");
  assert.deepEqual(targetRect, { x: 91.25, y: 73.5, width: 87.75, height: 29.25 });
  page.hide();
});

test("a pressed frame target keeps its original border feedback and original root click coordinates", () => {
  const page = createPage({ reducedMotion: true });
  const frame = page.add("iframe");
  frame.rect = { left: 15, top: 25, width: 320, height: 180 }; page.hit(frame);
  const targetRect = { x: 90, y: 70, width: 90, height: 30 };
  page.move({ x: 135, y: 85, animateMovement: false, feedbackSequence: 1, targetRect });
  const arrivals = page.sent.length;
  page.click({ x: 135, y: 85, feedbackSequence: 1, targetRect });
  const [ring] = page.elements("browser-agent-click"), [outline] = page.elements("browser-agent-target");
  assert.equal(outline.style.left, "90px"); assert.equal(outline.style.top, "70px");
  assert.equal(outline.style.width, "90px"); assert.equal(outline.style.height, "30px");
  assert.equal(ring.style.left, "135px"); assert.equal(ring.style.top, "85px");
  assert.equal(page.sent.length, arrivals, "Target feedback does not send another pointer command or arrival");
  page.hide(); assert.equal(page.elements("browser-agent-click").length, 0);
});

const originalTargetRect = { x: 90, y: 70, width: 90, height: 30 };
const targetPatch = (page, feedbackSequence, extra = {}) => page.send({ type: "OPEN_BROWSER_USE_TARGET_RECT", sessionId: "test-session", turnId: "test-turn", feedbackSequence, targetRect: originalTargetRect, ...extra });

test("a target publication only updates its original outline once without replaying motion, arrival or rings", () => {
  const page = createPage(); page.hit(page.add("iframe"));
  page.move({ feedbackSequence: 1, targetRect: null, animateMovement: false });
  page.move({ x: 230, y: 170, moveSequence: 2, feedbackSequence: 2, targetRect: null });
  page.click({ x: 230, y: 170, feedbackSequence: 2, targetRect: null });
  const [cursor] = page.elements("browser-agent-cursor"), [ring] = page.elements("browser-agent-click"), [outline] = page.elements("browser-agent-target");
  const before = { transform: cursor.style.transform, frames: [...page.frames], timers: [...page.timers], animations: [...page.animations], messages: [...page.sent], popovers: [...page.popoverCalls], hits: page.hitTests.length };
  assert.equal(outline.style.display, "none"); targetPatch(page, 2);
  assert.equal(outline.style.left, "90px"); assert.equal(outline.style.display, "block"); assert.equal(page.elements("browser-agent-click")[0], ring);
  assert.deepEqual({ transform: cursor.style.transform, frames: [...page.frames], timers: [...page.timers], animations: [...page.animations], messages: [...page.sent], popovers: [...page.popoverCalls], hits: page.hitTests.length }, before);
  targetPatch(page, 2, { targetRect: { ...originalTargetRect, x: 300 } }); assert.equal(outline.style.left, "90px", "A duplicate original publication cannot overwrite a settled target"); page.hide();
});

test("absent target feedback preserves raw fallback while explicit null or malformed geometry stays hidden", () => {
  const page = createPage({ reducedMotion: true }), frame = page.add("iframe"); page.hit(frame); page.move({ feedbackSequence: 1 });
  const [outline] = page.elements("browser-agent-target"); assert.equal(outline.style.left, "10px");
  for (const [index, targetRect] of [null, undefined, {}, [], { ...originalTargetRect, x: NaN }, { ...originalTargetRect, height: 0 }, { ...originalTargetRect, width: Infinity }, { x: Number.MAX_VALUE, y: 1, width: Number.MAX_VALUE, height: 30 }].entries()) {
    page.move({ feedbackSequence: index + 2, targetRect }); assert.equal(outline.style.display, "none", "Invalid target must not become its containing iframe");
    targetPatch(page, index + 2, { targetRect }); assert.equal(outline.style.display, "none");
  }
  for (const feedbackSequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "9", undefined]) { page.move({ feedbackSequence, targetRect: null }); targetPatch(page, feedbackSequence); assert.equal(outline.style.display, "none", "Target publication requires an original positive safe sequence"); }
  page.hide();
});

test("scroll and resize revoke pending and settled target geometry until a new live cursor update", () => {
  for (const event of ["scroll", "resize"]) for (const settled of [false, true]) {
    const page = createPage({ reducedMotion: true }); page.move({ feedbackSequence: 1, targetRect: null }); if (settled) targetPatch(page, 1);
    page.emit(event); const [outline] = page.elements("browser-agent-target"); assert.equal(outline.style.display, "none");
    targetPatch(page, 1); page.click({ feedbackSequence: 1, targetRect: originalTargetRect }); assert.equal(outline.style.display, "none", "A late update cannot repaint pre-scroll coordinates");
    page.move({ feedbackSequence: 2, targetRect: null }); targetPatch(page, 2); assert.equal(outline.style.display, "block"); page.hide();
  }
});

test("same-coordinate successor sequences and raw feedback mask old hinted targets and old presses", () => {
  const page = createPage({ reducedMotion: true }), frame = page.add("iframe"); page.hit(frame);
  page.move({ feedbackSequence: 10, targetRect: null }); page.move({ feedbackSequence: 11 });
  const [outline] = page.elements("browser-agent-target"); targetPatch(page, 10); targetPatch(page, 11); assert.equal(outline.style.left, "10px", "A raw successor did not authorize any original target publication");
  page.click({ feedbackSequence: 10, targetRect: originalTargetRect }); assert.equal(page.elements("browser-agent-click").length, 0, "An old same-point press cannot create a successor's ring");
  page.move({ feedbackSequence: 12, targetRect: null }); for (const extra of [{ sessionId: "foreign" }, { turnId: "previous" }]) targetPatch(page, 12, extra);
  assert.equal(outline.style.display, "none"); targetPatch(page, 12); assert.equal(outline.style.left, "90px"); page.hide();
});

test("out-of-order and duplicate CURSOR messages cannot replace a newer receiver or replay its effects", () => {
  const page = createPage({ reducedMotion: true }); page.move({ x: 430, y: 230, moveSequence: 4, feedbackSequence: 40, targetRect: null });
  const [cursor] = page.elements("browser-agent-cursor"), [outline] = page.elements("browser-agent-target"), originalTransform = cursor.style.transform, arrivals = page.sent.length;
  page.move({ x: 80, y: 70, moveSequence: 3, feedbackSequence: 39, targetRect: originalTargetRect });
  page.click({ x: 80, y: 70, feedbackSequence: 39, targetRect: originalTargetRect }); targetPatch(page, 39);
  assert.equal(cursor.style.transform, originalTransform); assert.equal(outline.style.display, "none"); assert.equal(page.elements("browser-agent-click").length, 0); assert.equal(page.sent.length, arrivals);
  targetPatch(page, 40); assert.equal(outline.style.left, "90px", "Rejected older CURSOR did not consume the actual newer receiver");
  page.move({ x: 100, y: 100, moveSequence: 5, feedbackSequence: 40, targetRect: null });
  targetPatch(page, 40, { targetRect: { ...originalTargetRect, x: 300 } });
  assert.equal(cursor.style.transform, originalTransform); assert.equal(outline.style.left, "90px", "Duplicate CURSOR cannot regrant an already settled publication"); assert.equal(page.sent.length, arrivals); page.hide();
});

test("unsequenced manual feedback revokes hints without erasing its same-turn sequence watermark", () => {
  const page = createPage({ reducedMotion: true }), frame = page.add("iframe"); page.hit(frame);
  page.move({ x: 430, y: 230, feedbackSequence: 20, targetRect: originalTargetRect }); page.move({ x: 300, y: 200, moveSequence: 2 });
  const [cursor] = page.elements("browser-agent-cursor"), [outline] = page.elements("browser-agent-target"), originalTransform = cursor.style.transform;
  assert.equal(outline.style.left, "10px"); targetPatch(page, 20);
  for (const feedbackSequence of [19, 20]) { page.move({ x: 40, y: 30, feedbackSequence, targetRect: originalTargetRect }); page.click({ feedbackSequence, targetRect: originalTargetRect }); }
  assert.equal(cursor.style.transform, originalTransform); assert.equal(outline.style.left, "10px"); assert.equal(page.elements("browser-agent-click").length, 0);
  page.click({ x: 300, y: 200 }); assert.equal(page.elements("browser-agent-click").length, 1, "Legacy unsequenced input remains supported");
  page.move({ feedbackSequence: 21, targetRect: null }); targetPatch(page, 21); assert.equal(outline.style.left, "90px"); page.hide();
});

test("new turns and owners have independent CURSOR sequence ordering", () => {
  const page = createPage({ reducedMotion: true }); page.move({ feedbackSequence: 100, targetRect: originalTargetRect });
  page.move({ turnId: "next-turn", feedbackSequence: 1, targetRect: null }); targetPatch(page, 100);
  const [outline] = page.elements("browser-agent-target"); assert.equal(outline.style.display, "none"); targetPatch(page, 1, { turnId: "next-turn" }); assert.equal(outline.style.display, "block");
  page.move({ sessionId: "next-owner", turnId: "next-turn", feedbackSequence: 1, targetRect: null }); assert.equal(outline.style.display, "none");
  targetPatch(page, 1, { sessionId: "next-owner", turnId: "next-turn" }); assert.equal(outline.style.display, "block"); page.hide();
});

test("hidden and scroll-cleared receivers cannot be recreated by an old CURSOR delivery", () => {
  for (const clear of [page => page.hide(), page => page.emit("scroll"), page => page.emit("resize")]) {
    const page = createPage({ reducedMotion: true }); page.move({ feedbackSequence: 20, targetRect: originalTargetRect }); clear(page);
    const [cursor] = page.elements("browser-agent-cursor"), opacity = cursor.style.opacity;
    page.move({ feedbackSequence: 19, targetRect: originalTargetRect }); targetPatch(page, 19); page.click({ feedbackSequence: 19, targetRect: originalTargetRect });
    assert.equal(page.elements("browser-agent-target")[0].style.display, "none"); assert.equal(cursor.style.opacity, opacity); assert.equal(page.elements("browser-agent-click").length, 0); page.hide();
  }
});

test("renderer replacement and authorized press recovery do not authorize old target publications", () => {
  for (const settled of [false, true]) {
    const page = createPage({ reducedMotion: true }); page.move({ feedbackSequence: 1, targetRect: null }); if (settled) targetPatch(page, 1);
    const oldHost = page.document.getElementById("open-browser-use-cursor-root"); replaceApplicationDom(page, "children");
    targetPatch(page, 1); assert.equal(page.document.getElementById("open-browser-use-cursor-root"), null);
    page.click({ x: 220, y: 140, feedbackSequence: 1, targetRect: originalTargetRect });
    const host = page.document.getElementById("open-browser-use-cursor-root"), [outline] = page.elements("browser-agent-target"); assert.notEqual(host, oldHost); assert.ok(host.isConnected); assert.equal(page.elements("browser-agent-click").length, 1);
    targetPatch(page, 1); assert.equal(outline.style.display, "none", "New renderer is not the original target's receiver");
    replaceApplicationDom(page, "children"); page.move({ feedbackSequence: 2, targetRect: originalTargetRect });
    assert.equal(page.elements("browser-agent-target")[0].style.left, "90px", "A new live cursor can create a new owner and render its own settled geometry"); page.hide();
  }
});

test("hidden, ended, pagehidden, foreign-turn and bootstrap state cannot grant late target publication", async () => {
  for (const stop of [page => page.hide(), page => page.move({ feedbackSequence: 2, visible: false, targetRect: null }), page => page.emit("pagehide"), page => page.move({ sessionId: "next-owner", turnId: "next-turn", feedbackSequence: 1, targetRect: null })]) {
    const page = createPage({ reducedMotion: true }); page.move({ feedbackSequence: 1, targetRect: null }); stop(page); const frames = page.frames.size, timers = page.timers.size, roots = page.elements("browser-agent-layer").length;
    targetPatch(page, 1); assert.ok(page.elements("browser-agent-target").every(outline => outline.style.display === "none")); assert.equal(page.frames.size, frames); assert.equal(page.timers.size, timers); assert.equal(page.elements("browser-agent-layer").length, roots); page.hide();
  }
  const page = createPage({ reducedMotion: true }); page.initialState({ isVisible: true, sessionId: "test-session", turnId: "test-turn", cursor: { x: 40, y: 30, feedbackSequence: 1, targetRect: null } }); await Promise.resolve();
  targetPatch(page, 1); assert.equal(page.elements("browser-agent-target")[0].style.display, "none", "A snapshot is not a new live publication grant");
  page.move({ feedbackSequence: 2, targetRect: null }); targetPatch(page, 2); assert.equal(page.elements("browser-agent-target")[0].style.display, "block"); page.hide();
});

test("late border publication preserves root zoom, shadow top layer and print exclusion", () => {
  const page = createPage({ reducedMotion: true }); page.document.documentElement.style.zoom = "1.5"; page.move({ feedbackSequence: 1, targetRect: null });
  const host = page.document.getElementById("open-browser-use-cursor-root"), [layer] = page.elements("browser-agent-layer"), popovers = [...page.popoverCalls];
  targetPatch(page, 1); assert.equal(host.style.zoom, String(1 / 1.5)); assert.equal(layer.getRootNode(), host.shadowRoot); assert.deepEqual(page.popoverCalls, popovers); assert.equal(layer.matches(":popover-open"), true);
  const styles = findAll(host, node => node.tagName === "STYLE"); assert.equal(styles.length, 1); assert.match(styles[0].textContent, /@media print/); assert.match(styles[0].textContent, /display: none !important/); page.hide();
});

test("cached cursor STATE cannot restore an original target after viewport changes or renderer replacement", () => {
  const cached = Object.freeze({ isVisible: true, sessionId: "test-session", turnId: "test-turn", cursor: Object.freeze({ x: 40, y: 30, moveSequence: 1, feedbackSequence: 1, targetRect: Object.freeze({ ...originalTargetRect }) }) });
  for (const invalidate of [page => page.emit("scroll"), page => page.emit("resize"), page => replaceApplicationDom(page, "children")]) {
    const page = createPage({ reducedMotion: true }); page.move({ feedbackSequence: 1, targetRect: originalTargetRect }); invalidate(page);
    page.send({ type: "OPEN_BROWSER_USE_CURSOR_STATE", state: cached });
    const [outline] = page.elements("browser-agent-target"); assert.equal(outline.style.display, "none", "A cached snapshot cannot revalidate old exact geometry");
    targetPatch(page, 1); page.click({ feedbackSequence: 1, targetRect: originalTargetRect }); assert.equal(outline.style.display, "none");
    page.move({ feedbackSequence: 2, targetRect: originalTargetRect }); assert.equal(outline.style.display, "block"); assert.equal(outline.style.left, "90px"); page.hide();
  }
  assert.deepEqual(cached.cursor.targetRect, originalTargetRect, "Normalization must not mutate the original cached payload");
});

test("fresh bootstrap hides cached exact target geometry while raw absent snapshots retain local fallback", async () => {
  for (const hinted of [true, false]) {
    const page = createPage({ reducedMotion: true }), frame = page.add("iframe"); page.hit(frame);
    page.initialState({ isVisible: true, sessionId: "test-session", turnId: "test-turn", cursor: { x: 40, y: 30, feedbackSequence: 1, ...(hinted ? { targetRect: originalTargetRect } : {}) } }); await Promise.resolve();
    const [outline] = page.elements("browser-agent-target"); assert.equal(outline.style.display, hinted ? "none" : "block"); if (!hinted) assert.equal(outline.style.left, "10px");
    targetPatch(page, 1); assert.equal(outline.style.display, hinted ? "none" : "block"); page.hide();
  }
});

test("animateMovement false snaps to the CDP point and still acknowledges arrival", () => {
  const page = createPage();
  page.move({ x: 20, y: 25, animateMovement: false });
  page.move({ x: 620, y: 325, moveSequence: 2, animateMovement: false });
  const [cursor] = page.elements("browser-agent-cursor");
  assert.match(cursor.style.transform, /^translate3d\(608px, 313px, 0\)/);
  assert.equal(page.sent.filter((message) => message.type === "OPEN_BROWSER_USE_CURSOR_ARRIVED").at(-1).moveSequence, 2);
  page.hide();
});

test("nested open shadow roots highlight the actual button while opaque hosts stay opaque", () => {
  const page = createPage();
  const host = page.add("custom-controls");
  const shadow = page.document.createElement("#shadow-root");
  Object.defineProperty(shadow, "isConnected", { get: () => host.isConnected });
  host.shadowRoot = shadow;
  const nested = page.add("custom-button", shadow);
  const nestedShadow = page.document.createElement("#shadow-root");
  Object.defineProperty(nestedShadow, "isConnected", { get: () => nested.isConnected });
  nested.shadowRoot = nestedShadow;
  const button = page.add("button", nestedShadow);
  const label = page.add("span", button);
  button.rect = { left: 30, top: 25, width: 150, height: 35 };
  shadow.elementFromPoint = () => nested;
  nestedShadow.elementFromPoint = () => label;
  page.hit(host);
  page.move();
  const [outline] = page.elements("browser-agent-target");
  assert.equal(outline.style.left, "30px");
  assert.equal(outline.style.width, "150px");

  // Padding can hit the host again: stop instead of looping or hiding it.
  shadow.elementFromPoint = () => host;
  page.move();
  assert.equal(outline.style.width, "80px");
  host.shadowRoot = null;
  page.move();
  assert.equal(outline.style.width, "80px");
  page.hide();
});

test("rapid click effects are independent and do not restart cursor motion", () => {
  const page = createPage();
  page.move({ animateMovement: false });
  const [cursor] = page.elements("browser-agent-cursor");
  const transform = cursor.style.transform;
  const arrivals = page.sent.length;
  page.click();
  page.advance(100);
  page.click({ x: 100, y: 120 });
  assert.equal(page.elements("browser-agent-click").length, 2);
  assert.equal(cursor.style.transform, transform);
  assert.equal(page.sent.length, arrivals);
  assert.equal(page.elements("browser-agent-click")[1].style.pointerEvents, "none");
  page.advance(350);
  assert.equal(page.elements("browser-agent-click").length, 1);
  page.advance(100);
  assert.equal(page.elements("browser-agent-click").length, 0);
  assert.equal(page.animations.every((animation) => animation.canceled), true);
  page.hide();
  assert.equal(page.timers.size, 0);
  assert.equal(page.frames.size, 0);
});

test("reduced motion uses a brief static click marker", () => {
  const page = createPage({ reducedMotion: true });
  page.move();
  page.move({ x: 300, y: 200, moveSequence: 2 });
  assert.match(page.elements("browser-agent-cursor")[0].style.transform, /^translate3d\(288px, 188px, 0\)/);
  assert.equal(page.frames.size, 0);
  page.click();
  assert.equal(page.elements("browser-agent-click").length, 1);
  assert.equal(page.animations.length, 0);
  page.advance(200);
  assert.equal(page.elements("browser-agent-click").length, 0);
  page.hide();
});

test("new turns clear previous effects and rapid bursts keep a bounded set of markers", () => {
  const page = createPage();
  page.move({ animateMovement: false });
  for (let index = 0; index < 12; index++) page.click({ x: 40 + index });
  assert.equal(page.elements("browser-agent-click").length, 8);
  assert.equal(page.animations.filter((animation) => animation.canceled).length, 4);
  page.move({ turnId: "next-turn", moveSequence: 2 });
  assert.equal(page.elements("browser-agent-click").length, 0);
  page.click();
  assert.equal(page.elements("browser-agent-click").length, 0);
  page.hide();
  assert.equal(page.timers.size, 0);
});

test("hidden state removes feedback and cancels animations immediately", () => {
  const page = createPage();
  const target = page.add("input");
  page.hit(target);
  page.move();
  page.click();
  page.hide();
  assert.equal(page.elements("browser-agent-target")[0].style.display, "none");
  assert.equal(page.elements("browser-agent-click").length, 0);
  assert.equal(page.elements("browser-agent-cursor")[0].style.opacity, "0");
  assert.equal(page.timers.size, 0);
  assert.equal(page.frames.size, 0);
  assert.equal(page.animations[0].canceled, true);
  page.click();
  assert.equal(page.elements("browser-agent-click").length, 0);
});

test("scroll, resize, and pagehide never leave stale markers or click timers", () => {
  for (const event of ["scroll", "resize", "pagehide"]) {
    const page = createPage();
    page.hit(page.add("button"));
    page.move({ animateMovement: false });
    page.click();
    page.emit(event);
    assert.equal(page.elements("browser-agent-click").length, 0, event);
    assert.equal(page.elements("browser-agent-target")[0]?.style.display ?? "none", "none", event);
    page.hide();
    assert.equal(page.timers.size, 0, event);
    assert.equal(page.frames.size, 0, event);
  }
});

test("wrong-session, old-turn, non-press, and invalid point events create no markers", () => {
  const page = createPage();
  page.move();
  const calls = page.popoverCalls.length;
  for (const override of [
    { sessionId: "other" }, { turnId: "old" }, { eventType: "mouseReleased" },
    { x: NaN }, { x: Infinity }, { x: -1 }, { y: 800 }, { x: "40" }
  ]) page.click(override);
  assert.equal(page.elements("browser-agent-click").length, 0);
  assert.equal(page.popoverCalls.length, calls, "Rejected feedback cannot reorder application layers");
  page.hide();
});

test("a late initial state response cannot revive a finalized overlay", async () => {
  const page = createPage();
  page.move();
  page.hide();
  page.initialState({ isVisible: true, sessionId: "test-session", cursor: { x: 40, y: 30 } });
  await Promise.resolve();
  assert.equal(page.elements("browser-agent-cursor")[0].style.opacity, "0");
  assert.equal(page.timers.size, 0);
  page.click();
  assert.equal(page.elements("browser-agent-click").length, 0);
});

// These models exercise same-document DOM ownership/lifetime, not rendering.
// The browser fixture independently proves pixels and original trusted input.
function replaceApplicationDom(page, kind) {
  const document = page.document, previousRoot = document.documentElement;
  const head = document.createElement("head"), body = document.createElement("body");
  if (kind === "children") previousRoot.replaceChildren(head, body);
  else if (kind === "documentElement") {
    document.documentElement = document.createElement("html");
    document.documentElement.appendChild(head); document.documentElement.appendChild(body);
    previousRoot.remove(); // Also models native top-layer removal on detach.
  } else if (kind === "body") {
    document.body.remove(); document.documentElement.appendChild(body);
  } else throw Error("Unknown application rebuild");
  document.body = body;
  const button = page.add("button"); button.textContent = "Original application submit";
  button.rect = { left: 180, top: 120, width: 100, height: 40 }; page.hit(button);
  return button;
}

for (const kind of ["children", "documentElement"]) test(`next visible update recovers feedback after same-document ${kind} replacement and retires the old effects`, () => {
  const page = createPage(); page.hit(page.add("button"));
  page.move({ animateMovement: false }); page.click();
  const oldHost = page.document.getElementById("open-browser-use-cursor-root"), [oldLayer] = page.elements("browser-agent-layer");
  const oldRings = page.elements("browser-agent-click"), oldAnimations = [...page.animations];
  const button = replaceApplicationDom(page, kind), point = { x: 220, y: 140 };
  assert.equal(oldHost.isConnected, false); assert.equal(oldLayer.isConnected, false);
  assert.equal(page.elements("browser-agent-layer").length, 0);
  page.move({ ...point, moveSequence: 2, animateMovement: false });
  const host = page.document.getElementById("open-browser-use-cursor-root"), layers = page.elements("browser-agent-layer");
  assert.ok(host?.isConnected, "A new authorized update must render in the current document root");
  assert.notEqual(host, oldHost); assert.equal(layers.length, 1); assert.notEqual(layers[0], oldLayer);
  assert.equal(layers[0].matches(":popover-open"), true); assert.equal(page.topLayer.includes(oldLayer), false);
  assert.equal(oldRings.every(ring => ring.parentElement === null), true);
  assert.equal(oldAnimations.every(animation => animation.canceled), true);
  assertViewportFeedback(page, point, button.rect);
  assert.equal(findAll(host, node => node.tagName === "STYLE").length, 1, "Recovery preserves exactly one owned print exclusion");
  page.click(point); assert.equal(page.elements("browser-agent-click").length, 1);
  page.hide(); assert.equal(page.timers.size, 0); assert.equal(page.frames.size, 0);
});

test("body-only rebuild keeps the same connected feedback owner without duplicate layers or styles", () => {
  const page = createPage({ reducedMotion: true }); page.move();
  const host = page.document.getElementById("open-browser-use-cursor-root"), [layer] = page.elements("browser-agent-layer");
  const button = replaceApplicationDom(page, "body"), point = { x: 220, y: 140 };
  page.move({ ...point, moveSequence: 2 }); page.click(point);
  assert.equal(page.document.getElementById("open-browser-use-cursor-root"), host);
  assert.deepEqual(page.elements("browser-agent-layer"), [layer]);
  assert.equal(findAll(host, node => node.tagName === "STYLE").length, 1);
  assertViewportFeedback(page, point, button.rect); page.hide();
});

test("a detached animation retires without claiming arrival, recreating a host or leaving effect timers", () => {
  const page = createPage(); page.move({ animateMovement: false });
  page.move({ x: 60, moveSequence: 2 }); page.click();
  const animations = [...page.animations]; assert.ok(page.frames.size > 0); assert.ok(page.timers.size > 0);
  replaceApplicationDom(page, "children"); page.advance(3000);
  assert.equal(page.sent.some(message => message.type === "OPEN_BROWSER_USE_CURSOR_ARRIVED" && message.moveSequence === 2), false,
    "A model settling in a detached tree is not visible cursor arrival");
  assert.equal(page.document.getElementById("open-browser-use-cursor-root"), null);
  assert.equal(page.frames.size, 0); assert.equal(page.timers.size, 0);
  assert.equal(animations.every(animation => animation.canceled), true);
});

test("a retained old animation callback cannot report arrival or disturb its recovered successor", () => {
  const page = createPage(); page.move({ animateMovement: false }); page.move({ x: 60, moveSequence: 2 });
  const callbacks = [...page.frames.values()]; assert.ok(callbacks.length);
  replaceApplicationDom(page, "children"); page.move({ x: 220, y: 140, moveSequence: 3, animateMovement: false });
  const [successor] = page.elements("browser-agent-layer");
  for (const callback of callbacks) callback(3000);
  assert.equal(page.sent.some(message => message.type === "OPEN_BROWSER_USE_CURSOR_ARRIVED" && message.moveSequence === 2), false);
  assert.equal(page.sent.filter(message => message.type === "OPEN_BROWSER_USE_CURSOR_ARRIVED" && message.moveSequence === 3).length, 1);
  assert.ok(successor?.isConnected); assert.equal(successor.matches(":popover-open"), true);
  assert.deepEqual(page.elements("browser-agent-layer"), [successor]); page.hide();
});

test("the next authorized press can recover between cursor feedback and native press, but rejected presses cannot", () => {
  const page = createPage({ reducedMotion: true }); page.move(); replaceApplicationDom(page, "children");
  for (const extra of [{ sessionId: "foreign" }, { turnId: "old" }, { eventType: "mouseReleased" }, { x: NaN }, { y: -1 }]) page.click(extra);
  assert.equal(page.document.getElementById("open-browser-use-cursor-root"), null);
  page.click({ x: 220, y: 140 });
  assert.ok(page.document.getElementById("open-browser-use-cursor-root")?.isConnected);
  assert.equal(page.elements("browser-agent-click").length, 1);
  assert.equal(page.elements("browser-agent-target")[0].style.left, "180px");
  assert.equal(page.topLayer.length, 1); page.hide();
});

test("detached hide, turn end and pagehide reject stale bootstrap resurrection without creating a replacement root", async () => {
  for (const close of [page => page.hide(), page => page.send({ type: "OPEN_BROWSER_USE_CURSOR_STATE", state: { isVisible: false, sessionId: "test-session", turnId: "ended" } }), page => page.emit("pagehide")]) {
    const page = createPage(); page.move({ animateMovement: false }); page.click();
    replaceApplicationDom(page, "documentElement"); close(page);
    page.initialState({ isVisible: true, sessionId: "test-session", turnId: "test-turn", cursor: { x: 40, y: 30 } });
    await Promise.resolve(); page.emit("resize"); page.emit("scroll"); page.click(); page.advance(1000);
    assert.equal(page.document.getElementById("open-browser-use-cursor-root"), null);
    assert.equal(page.topLayer.length, 0); assert.equal(page.timers.size, 0); assert.equal(page.frames.size, 0);
    assert.equal(page.animations.every(animation => animation.canceled), true);
  }
});

test("cold hidden messages and an initially invisible bootstrap allocate no renderer", async () => {
  for (const bootstrap of [false, true]) {
    const page = createPage();
    if (bootstrap) { page.initialState({ isVisible: false }); await Promise.resolve(); }
    else page.hide();
    page.emit("resize"); page.emit("scroll"); page.click();
    assert.equal(page.document.getElementById("open-browser-use-cursor-root"), null);
    assert.equal(page.elements("browser-agent-layer").length, 0); assert.equal(page.popoverCalls.length, 0);
    assert.equal(page.frames.size, 0); assert.equal(page.timers.size, 0);
    assert.equal(page.sent.some(message => message.type === "OPEN_BROWSER_USE_CURSOR_ARRIVED"), false);
  }
});

test("a connected layer transplanted into another shadow root is not the original renderer owner", () => {
  const page = createPage({ reducedMotion: true }); page.move();
  const oldHost = page.document.getElementById("open-browser-use-cursor-root"), [oldLayer] = page.elements("browser-agent-layer");
  const applicationHost = page.add("application-view"), applicationShadow = applicationHost.attachShadow({ mode: "open" });
  const sentinel = page.add("span", applicationShadow); sentinel.textContent = "Application content";
  applicationShadow.appendChild(oldLayer); assert.equal(oldLayer.isConnected, true);
  page.move({ moveSequence: 2 });
  assert.equal(sentinel.parentNode, applicationShadow); assert.equal(sentinel.textContent, "Application content");
  assert.equal(applicationHost.isConnected, true); assert.equal(oldLayer.isConnected, false);
  const [layer] = page.elements("browser-agent-layer"); assert.ok(layer?.isConnected); assert.notEqual(layer, oldLayer);
  assert.notEqual(page.document.getElementById("open-browser-use-cursor-root"), oldHost);
  assert.equal(layer.matches(":popover-open"), true); page.hide();
});

test("a connected host moved under business zoom is retired instead of borrowing its new parent's coordinates", () => {
  const page = createPage({ reducedMotion: true }); page.move();
  const oldHost = page.document.getElementById("open-browser-use-cursor-root");
  page.document.body.style.zoom = "2"; page.document.body.appendChild(oldHost);
  assert.equal(oldHost.isConnected, true);
  const button = page.add("button"), point = { x: 40, y: 30 }; page.hit(button);
  page.move({ ...point, moveSequence: 2 });
  const host = page.document.getElementById("open-browser-use-cursor-root");
  assert.notEqual(host, oldHost); assert.equal(host.parentElement, page.document.documentElement);
  assert.equal(oldHost.isConnected, false); assert.equal(button.parentElement, page.document.body);
  assert.equal(page.document.body.style.zoom, "2"); assertViewportFeedback(page, point, button.rect); page.hide();
});

test("a same-ID application replacement is preserved instead of being adopted or cleared during recovery", () => {
  const page = createPage({ reducedMotion: true }); page.move(); replaceApplicationDom(page, "children");
  const applicationHost = page.document.documentElement.appendChild(page.document.createElement("section"));
  applicationHost.id = "open-browser-use-cursor-root";
  const sentinel = page.add("button", applicationHost); sentinel.textContent = "Do not replace my form";
  page.move({ moveSequence: 2 });
  assert.equal(applicationHost.isConnected, true); assert.equal(sentinel.parentElement, applicationHost);
  assert.equal(sentinel.textContent, "Do not replace my form"); assert.equal(applicationHost.shadowRoot, undefined);
  assert.equal(findAll(applicationHost, node => node.tagName === "STYLE", true).length, 0);
  assert.equal(page.sent.some(message => message.type === "OPEN_BROWSER_USE_CURSOR_ARRIVED" && message.moveSequence === 2), false);
  assert.equal(page.elements("browser-agent-layer").length, 0);
  page.hide(); page.emit("pagehide"); assert.equal(applicationHost.isConnected, true);
  assert.equal(sentinel.parentElement, applicationHost);
  applicationHost.remove(); page.emit("resize"); page.emit("scroll");
  assert.equal(page.document.getElementById("open-browser-use-cursor-root"), null);
  page.move({ moveSequence: 3 });
  assert.ok(page.document.getElementById("open-browser-use-cursor-root")?.isConnected);
  assert.equal(page.elements("browser-agent-layer").length, 1);
  assert.equal(page.sent.filter(message => message.type === "OPEN_BROWSER_USE_CURSOR_ARRIVED" && message.moveSequence === 3).length, 1);
  page.hide();
});

test("temporarily absent documentElement never creates page DOM or breaks message acknowledgement", () => {
  const page = createPage({ reducedMotion: true }), previous = page.document.documentElement;
  page.document.documentElement = null; page.document.body = null; previous.remove();
  assert.doesNotThrow(() => page.move()); assert.doesNotThrow(() => page.hide());
  assert.equal(page.document.documentElement, null); assert.equal(page.timers.size, 0); assert.equal(page.frames.size, 0);
  const replacement = page.document.createElement("html"), body = page.document.createElement("body");
  replacement.appendChild(body); page.document.documentElement = replacement; page.document.body = body;
  page.move({ moveSequence: 2 });
  assert.ok(page.document.getElementById("open-browser-use-cursor-root")?.isConnected);
  assert.equal(page.sent.filter(message => message.type === "OPEN_BROWSER_USE_CURSOR_ARRIVED" && message.moveSequence === 1).length, 0);
  page.hide();
});

function documentStyle(page, id) {
  return page.document.getElementById(id).style;
}
