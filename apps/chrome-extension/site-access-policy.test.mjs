import assert from "node:assert/strict";
import test from "node:test";
import { SiteAccessPolicy, SITE_ACCESS_POLICY_KEY, normalizeSiteAccessPolicy } from "./site-access-policy.js";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const config = (mode = "allow", origins = ["https://example.com"]) => ({ mode, origins });
function storage(value) {
  let current = value;
  const writes = [];
  return { writes, async get() { return current === undefined ? {} : { [SITE_ACCESS_POLICY_KEY]: structuredClone(current) }; },
    async set(record) { writes.push(structuredClone(record)); current = structuredClone(record[SITE_ACCESS_POLICY_KEY]); } };
}
const stored = (revision = 4, mode = "allow", origins = ["https://example.com"]) => ({ version: 1, revision, mode, origins });

test("origin normalization handles case, IDN, ports, IPv6 and one root slash", () => {
  assert.deepEqual(normalizeSiteAccessPolicy(config("allow", ["HTTPS://EXAMPLE.COM:443/", "https://example.com", "http://例え.テスト:80", "https://[::1]:8443/"])),
    { mode: "allow", origins: ["http://xn--r8jz45g.xn--zckzah", "https://[::1]:8443", "https://example.com"] });
  assert.deepEqual(normalizeSiteAccessPolicy(config("block", [])), { mode: "block", origins: [] });
});

test("ambiguous or non-origin settings reject without echoing input", () => {
  for (const origin of [" https://example.com", "https://example.com\n", "https:example.com", "//example.com", "https://example.com/path", "https://example.com//", "https://example.com/.", "https://example.com?", "https://example.com#", "https://example.com/*", "https://*.example.com", "https://user:secret@example.com", "https://@example.com", "https://example.com\\", "https://%65xample.com", "https://example.com:bad", "https://example.com:", "http://127.1", "http://0x7f000001", "http://0177.0.0.1", "data:text/html,secret", "file:///secret", "about:blank", null, 3, "https://" + "a".repeat(2048)]) {
    assert.throws(() => normalizeSiteAccessPolicy(config("allow", [origin])), error => /^OBU_SITE_ACCESS_INVALID:/.test(error.message) && !error.message.includes("secret"));
  }
});

test("configuration shape and capacity are strict", () => {
  for (const value of [null, [], {}, { mode: "allow" }, { mode: "unknown", origins: [] }, { mode: "allow", origins: "https://example.com" }, { ...config(), extra: true }, config("all", ["https://example.com"]), config("allow", Array(101).fill("https://example.com"))])
    assert.throws(() => normalizeSiteAccessPolicy(value), /OBU_SITE_ACCESS_INVALID/);
  assert.equal(normalizeSiteAccessPolicy(config("allow", Array.from({ length: 100 }, (_, i) => `https://site${i}.example`))).origins.length, 100);
});

test("startup rejects admission until storage resolves and preserves missing-key compatibility", async () => {
  const read = deferred(), policy = new SiteAccessPolicy({ storage: { get: () => read.promise, set: async () => {} } });
  assert.deepEqual(policy.status(), { version: 1, revision: 0, mode: "all", origins: [], ready: false });
  assert.equal(policy.restricted, true); assert.equal(policy.allowsUrl("https://example.com"), false);
  assert.throws(() => policy.assertReady(), /OBU_SITE_ACCESS_UNAVAILABLE/);
  read.resolve({}); await policy.ready;
  assert.equal(policy.restricted, false); assert.equal(policy.allowsUrl("file:///tmp/file"), true);
  for (const legacyEmpty of [undefined, null, ""]) assert.equal(policy.allowsUrl(legacyEmpty), true);
  policy.assertReady();
});

test("allow and block decisions compare exact canonical origins, including scheme and port", async () => {
  for (const mode of ["allow", "block"]) {
    const policy = new SiteAccessPolicy({ storage: storage(stored(4, mode)) }); await policy.ready;
    for (const url of ["https://example.com", "https://EXAMPLE.com:443/a?q=1#x"]) assert.equal(policy.allowsUrl(url), mode === "allow");
    for (const url of ["http://example.com", "https://example.com:8443/a", "https://sub.example.com", "https://example.com.evil.test"]) assert.equal(policy.allowsUrl(url), mode === "block");
    for (const url of ["javascript:alert(1)", "file:///tmp/x", "data:text/html,x", "blob:https://example.com/id", "about:srcdoc", "about:blank#x", " https://example.com", "https://user@example.com", "https://example.com\\path", null]) assert.equal(policy.allowsUrl(url), false);
    assert.equal(policy.allowsUrl("about:blank"), false); assert.equal(policy.allowsUrl("about:blank", { allowBlank: true }), true);
    assert.equal(policy.allowsUrl("about:blank#x", { allowBlank: true }), false);
    assert.throws(() => policy.assertUrl("file:///secret"), error => /OBU_SITE_ACCESS_DENIED/.test(error.message) && !error.message.includes("secret"));
  }
  const denyAll = new SiteAccessPolicy({ storage: storage(stored(1, "allow", [])) }); await denyAll.ready;
  assert.equal(denyAll.allowsUrl("https://example.com"), false);
  const allowHTTP = new SiteAccessPolicy({ storage: storage(stored(1, "block", [])) }); await allowHTTP.ready;
  assert.equal(allowHTTP.allowsUrl("https://example.com"), true); assert.equal(allowHTTP.allowsUrl("file:///x"), false);
});

test("invalid persisted records and read failures remain fail-closed with safe status", async () => {
  const cases = [null, {}, stored(-1), stored(1.5), { ...stored(), version: 2 }, { ...stored(), unknown: true }, { ...stored(), origins: ["https://secret.example/path"] }, { ...stored(), origins: Array(101).fill("https://secret.example") }];
  for (const value of cases) {
    const policy = new SiteAccessPolicy({ storage: storage(value) });
    await assert.rejects(policy.ready, /OBU_SITE_ACCESS_STATE_INVALID/);
    assert.equal(policy.restricted, true); assert.equal(policy.allowsUrl("https://example.com"), false);
    assert.equal(policy.status().ready, false); assert.equal(JSON.stringify(policy.status()).includes("secret"), false);
  }
  const policy = new SiteAccessPolicy({ storage: { get: async () => { throw new Error("secret storage detail"); }, set: async () => {} } });
  await assert.rejects(policy.ready, /OBU_SITE_ACCESS_UNAVAILABLE/);
  assert.equal(JSON.stringify(policy.status()).includes("secret"), false);
});

test("replace publishes a blocked candidate until the exact persistent write finishes", async () => {
  const save = deferred(), entered = deferred(), adapter = storage(stored());
  adapter.set = value => { adapter.writes.push(structuredClone(value)); entered.resolve(); return save.promise; };
  const policy = new SiteAccessPolicy({ storage: adapter }); await policy.ready;
  const replacement = policy.replace(config("all", []), 4); await entered.promise;
  assert.deepEqual(policy.status(), { version: 1, revision: 5, mode: "all", origins: [], ready: false });
  assert.equal(policy.restricted, true); assert.equal(policy.allowsUrl("https://any.example"), false);
  save.resolve(); assert.equal((await replacement).ready, true); assert.equal(policy.restricted, false);
  assert.deepEqual(adapter.writes[0], { [SITE_ACCESS_POLICY_KEY]: { version: 1, revision: 5, mode: "all", origins: [] } });
});

test("queued CAS rejects stale writers and copies both input and returned status", async () => {
  const save = deferred(), entered = deferred(), adapter = storage(stored());
  adapter.set = value => { adapter.writes.push(structuredClone(value)); entered.resolve(); return save.promise; };
  const policy = new SiteAccessPolicy({ storage: adapter }); await policy.ready;
  const input = config("allow", ["https://one.example"]);
  const first = policy.replace(input, 4), second = policy.replace(config("all", []), 4); second.catch(() => {});
  input.origins[0] = "https://wrong.example"; await entered.promise;
  const snapshot = policy.status(); snapshot.origins.push("https://wrong.example");
  save.resolve(); await first; await assert.rejects(second, /OBU_SITE_ACCESS_REVISION_CONFLICT/);
  assert.equal(adapter.writes.length, 1); assert.deepEqual(policy.status().origins, ["https://one.example"]);
});

test("failed writes retain a blocked revision and an explicit fresh-revision retry can recover", async () => {
  const adapter = storage(stored()), saved = adapter.set; let reject = true;
  adapter.set = value => reject ? Promise.reject(new Error("secret write detail")) : saved(value);
  const policy = new SiteAccessPolicy({ storage: adapter }); await policy.ready;
  await assert.rejects(policy.replace(config("block"), 4), /OBU_SITE_ACCESS_UNAVAILABLE/);
  assert.equal(policy.status().revision, 5); assert.equal(policy.status().ready, false); assert.equal(policy.restricted, true);
  assert.equal(JSON.stringify(policy.status()).includes("secret"), false);
  await assert.rejects(policy.replace(config("all", []), 4), /OBU_SITE_ACCESS_REVISION_CONFLICT/);
  reject = false; await policy.replace(config("block"), 5);
  assert.equal(policy.status().revision, 6); assert.equal(policy.status().ready, true);
  const restarted = new SiteAccessPolicy({ storage: adapter }); await restarted.ready;
  assert.deepEqual(restarted.status(), policy.status());
});

test("invalid requests and revision exhaustion do not mutate or write", async () => {
  const adapter = storage(stored(Number.MAX_SAFE_INTEGER)), policy = new SiteAccessPolicy({ storage: adapter }); await policy.ready;
  for (const expected of [-1, 1.5, NaN, "4", undefined]) await assert.rejects(policy.replace(config(), expected), /OBU_SITE_ACCESS_REVISION_CONFLICT/);
  await assert.rejects(policy.replace({ ...config(), extra: true }, Number.MAX_SAFE_INTEGER), /OBU_SITE_ACCESS_INVALID/);
  await assert.rejects(policy.replace(config(), Number.MAX_SAFE_INTEGER), /OBU_SITE_ACCESS_REVISION_EXHAUSTED/);
  assert.equal(adapter.writes.length, 0); assert.equal(policy.status().ready, true);
});
