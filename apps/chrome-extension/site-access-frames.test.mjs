import assert from "node:assert/strict";
import test from "node:test";
import { assertSiteAccessFrames } from "./site-access-frames.js";

const A = "https://allowed.test", B = "https://child.test";
const tab = (url = `${A}/page`, extra = {}) => ({ id: 7, url, ...extra });
const frame = (frameId = 0, parentFrameId = -1, url = `${A}/page`, extra = {}) => ({ frameId, parentFrameId, url, errorOccurred: false, documentLifecycle: "active", ...extra });
function policy(origins = [A, B], { restricted = true, readyError } = {}) {
  const allowed = new Set(origins.map(value => new URL(value).origin));
  return {
    restricted,
    assertReady() { if (readyError) throw readyError; },
    allowsUrl(value, { allowBlank = false } = {}) {
      if (value === "about:blank") return allowBlank;
      return allowed.has(new URL(value).origin);
    }
  };
}
function rejects(tabValue, frames, code = "UNVERIFIED", selectedPolicy = policy()) {
  assert.throws(() => assertSiteAccessFrames(selectedPolicy, tabValue, frames), error => {
    assert.match(error.message, new RegExp(`^OBU_SITE_ACCESS_${code}: `));
    assert.ok(!error.message.includes("https:") && !error.message.includes("private"));
    return true;
  });
}

test("all mode checks readiness then fast-passes without reading tab or frames", () => {
  const unobservable = new Proxy({}, { get() { throw new Error("must not inspect"); } });
  assert.equal(assertSiteAccessFrames(policy([], { restricted: false }), unobservable, unobservable), undefined);
  const failure = new Error("policy storage unavailable");
  assert.throws(() => assertSiteAccessFrames(policy([], { restricted: false, readyError: failure }), null, null), error => error === failure);
});

test("allowed root, same-origin, OOPIF and nested frames pass in arbitrary order", () => {
  const frames = [frame(4, 3, "about:blank"), frame(3, 2, "about:srcdoc"), frame(2, 1, `${B}/nested`), frame(1, 0, `${A}/child`), frame()];
  assert.equal(assertSiteAccessFrames(policy(), tab(), frames), undefined);
  assert.equal(assertSiteAccessFrames(policy(), tab(), [...frames].reverse()), undefined);
});

test("one forbidden root, pending navigation or cross-origin child blocks the whole tab", () => {
  rejects(tab("https://private.test/root"), [frame()], "DENIED");
  rejects(tab(A, { pendingUrl: "https://private.test/next" }), [frame()], "DENIED");
  rejects(tab(), [frame(), frame(3, 0, "https://private.test/iframe")], "DENIED");
  rejects(tab(), [frame(), frame(1, 0, B), frame(2, 1, "https://private.test/nested")], "DENIED");
  rejects(tab(), [frame(0, -1, "https://private.test/root")], "DENIED");
});

test("URL policy uses canonical exact origins including IDN, scheme and port", () => {
  const selectedPolicy = policy(["https://例子.测试", "http://localhost:8080"]);
  assert.equal(assertSiteAccessFrames(selectedPolicy, tab("https://xn--fsqu00a.xn--0zwm56d/a"), [frame(0, -1, "https://例子.测试:443/b")]), undefined);
  assert.equal(assertSiteAccessFrames(selectedPolicy, tab("http://localhost:8080/x"), [frame(0, -1, "http://localhost:8080/y")]), undefined);
  for (const url of ["http://例子.测试", "https://例子.测试:444", "http://localhost:8081", "https://例子.测试.attacker.test", "https://例子.测试@private.test/path"]) rejects(tab(url), [frame(0, -1, url)], "DENIED", selectedPolicy);
});

test("only exact top-level about:blank is permitted as a bootstrap shape", () => {
  assert.equal(assertSiteAccessFrames(policy(), tab("about:blank"), [frame(0, -1, "about:blank")]), undefined);
  assert.equal(assertSiteAccessFrames(policy(), tab("about:blank", { pendingUrl: `${A}/next` }), [frame(0, -1, "about:blank")]), undefined);
  rejects(tab(), [frame(0, -1, "about:blank")]);
  rejects(tab("about:srcdoc"), [frame(0, -1, "about:srcdoc")]);
  rejects(tab("about:blank"), [frame(0, -1, "about:srcdoc")]);
  for (const url of ["about:blank#private", "about:blank?query", "about:Blank", "about:srcdoc#x"]) rejects(tab(url), [frame(0, -1, url)]);
});

test("blank and srcdoc children must inherit through a complete allowed parent chain", () => {
  assert.equal(assertSiteAccessFrames(policy(), tab(), [frame(), frame(1, 0, "about:blank"), frame(2, 1, "about:srcdoc")]), undefined);
  rejects(tab(), [frame(), frame(2, 1, "about:srcdoc")]);
  rejects(tab(), [frame(), frame(1, 0, "https://private.test/parent"), frame(2, 1, "about:blank")], "DENIED");
});

test("opaque, privileged, malformed or missing URLs cannot prove document access", () => {
  for (const url of ["blob:https://allowed.test/uuid", "data:text/html,private", "file:///private", "chrome://settings", "chrome-extension://test/page.html", "javascript:void(0)", "https://", "not a url", "", null, undefined, `${A}/\nprivate`, ` ${A}`, `${A} `]) {
    rejects({ ...tab(), url }, [frame()]);
    rejects(tab(), [frame(), { ...frame(1, 0), url }]);
    rejects(tab(A, { pendingUrl: url === undefined ? null : url }), [frame()]);
  }
});

test("missing, empty, non-array or oversized frame inventory fails closed", () => {
  for (const frames of [undefined, null, [], {}, "private", Array.from({ length: 1001 }, (_, index) => frame(index, index - 1))]) rejects(tab(), frames);
  rejects(null, [frame()]);
});

test("a 1000-document deeply nested tree is bounded without recursive stack growth", () => {
  const frames = Array.from({ length: 1000 }, (_, index) => frame(index, index - 1, index ? "about:srcdoc" : A));
  assert.equal(assertSiteAccessFrames(policy(), tab(A), frames.reverse()), undefined);
});

test("invalid or duplicate frame IDs and invalid parent IDs are rejected", () => {
  for (const frameId of [-1, 0.5, NaN, Infinity, "1", Number.MAX_SAFE_INTEGER + 1]) rejects(tab(), [frame(), frame(frameId, 0)]);
  for (const parentFrameId of [-2, 0.5, NaN, Infinity, "0", Number.MAX_SAFE_INTEGER + 1]) rejects(tab(), [frame(), frame(1, parentFrameId)]);
  rejects(tab(), [frame(), frame(0, -1)]);
  rejects(tab(), [frame(), frame(1, 0), frame(1, 0)]);
  rejects(tab(), [frame(0, 1), frame(1, 0)]);
  rejects(tab(), [frame(), frame(1, -1)]);
  rejects(tab(), [frame(), null]);
});

test("missing root, missing parents, cycles and disconnected allowed HTTP frames fail closed", () => {
  rejects(tab(), [frame(1, 0)]);
  rejects(tab(), [frame(), frame(1, 99, B)]);
  rejects(tab(), [frame(), frame(1, 1, B)]);
  rejects(tab(), [frame(), frame(1, 2, B), frame(2, 1, A)]);
  rejects(tab(), [frame(), frame(1, 2, "about:blank"), frame(2, 1, "about:srcdoc")]);
});

test("unknown, cached, prerendering or failed documents cannot be admitted", () => {
  for (const documentLifecycle of [undefined, null, "", "cached", "prerender", "pending_deletion", "unknown"]) rejects(tab(), [frame(), frame(1, 0, B, { documentLifecycle })]);
  for (const errorOccurred of [true, undefined, null, 0, "false"]) rejects(tab(), [frame(0, -1, A, { errorOccurred })]);
});

test("input objects remain unchanged and decisions are not cached between calls", () => {
  const currentTab = Object.freeze(tab()), frames = Object.freeze([Object.freeze(frame()), Object.freeze(frame(1, 0, B))]);
  assert.equal(assertSiteAccessFrames(policy(), currentTab, frames), undefined);
  rejects(currentTab, frames, "DENIED", policy([A]));
  rejects(currentTab, [frame(), frame(1, 0, "https://private.test/new-document")], "DENIED");
});
