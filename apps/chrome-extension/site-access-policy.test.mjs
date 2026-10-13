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
const withoutGeneration = ({ generation, ...value }) => value;
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
  assert.deepEqual(withoutGeneration(policy.status()), { version: 1, revision: 0, mode: "all", origins: [], ready: false, recovery: { state: "pending" } });
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
  const replacement = policy.replace(config("all", []), 4, policy.generation); await entered.promise;
  assert.deepEqual(withoutGeneration(policy.status()), { version: 1, revision: 5, mode: "all", origins: [], ready: false });
  assert.equal(policy.restricted, true); assert.equal(policy.allowsUrl("https://any.example"), false);
  save.resolve(); assert.equal((await replacement).ready, true); assert.equal(policy.restricted, false);
  assert.deepEqual(adapter.writes[0], { [SITE_ACCESS_POLICY_KEY]: { version: 1, revision: 5, mode: "all", origins: [] } });
});

test("queued CAS rejects stale writers and copies both input and returned status", async () => {
  const save = deferred(), entered = deferred(), adapter = storage(stored());
  adapter.set = value => { adapter.writes.push(structuredClone(value)); entered.resolve(); return save.promise; };
  const policy = new SiteAccessPolicy({ storage: adapter }); await policy.ready;
  const input = config("allow", ["https://one.example"]);
  const first = policy.replace(input, 4, policy.generation), second = policy.replace(config("all", []), 4, policy.generation); second.catch(() => {});
  input.origins[0] = "https://wrong.example"; await entered.promise;
  const snapshot = policy.status(); snapshot.origins.push("https://wrong.example");
  save.resolve(); await first; await assert.rejects(second, /OBU_SITE_ACCESS_REVISION_CONFLICT/);
  assert.equal(adapter.writes.length, 1); assert.deepEqual(policy.status().origins, ["https://one.example"]);
});

test("failed writes retain a blocked revision and an explicit fresh-revision retry can recover", async () => {
  const adapter = storage(stored()), saved = adapter.set; let reject = true;
  adapter.set = value => reject ? Promise.reject(new Error("secret write detail")) : saved(value);
  const policy = new SiteAccessPolicy({ storage: adapter }); await policy.ready;
  await assert.rejects(policy.replace(config("block"), 4, policy.generation), /OBU_SITE_ACCESS_UNAVAILABLE/);
  assert.equal(policy.status().revision, 5); assert.equal(policy.status().ready, false); assert.equal(policy.restricted, true);
  assert.equal(JSON.stringify(policy.status()).includes("secret"), false);
  await assert.rejects(policy.replace(config("all", []), 4, policy.generation), /OBU_SITE_ACCESS_REVISION_CONFLICT/);
  reject = false; await policy.retry(5, policy.generation);
  assert.equal(policy.status().revision, 6); assert.equal(policy.status().ready, true);
  const restarted = new SiteAccessPolicy({ storage: adapter }); await restarted.ready;
  assert.deepEqual(withoutGeneration(restarted.status()), withoutGeneration(policy.status()));
  assert.notEqual(restarted.generation, policy.generation);
});

test("invalid requests and revision exhaustion do not mutate or write", async () => {
  const adapter = storage(stored(Number.MAX_SAFE_INTEGER)), policy = new SiteAccessPolicy({ storage: adapter }); await policy.ready;
  for (const expected of [-1, 1.5, NaN, "4", undefined]) await assert.rejects(policy.replace(config(), expected, policy.generation), /OBU_SITE_ACCESS_REVISION_CONFLICT/);
  await assert.rejects(policy.replace({ ...config(), extra: true }, Number.MAX_SAFE_INTEGER, policy.generation), /OBU_SITE_ACCESS_INVALID/);
  await assert.rejects(policy.replace(config(), Number.MAX_SAFE_INTEGER, policy.generation), /OBU_SITE_ACCESS_REVISION_EXHAUSTED/);
  assert.equal(adapter.writes.length, 0); assert.equal(policy.status().ready, true);
});

test("retry metadata exists only after an actual write rejection and retries the exact copied candidate", async () => {
  const adapter = storage(stored()), save = deferred(), entered = deferred();
  const write = adapter.set; adapter.set = value => { entered.resolve(); return save.promise; };
  const policy = new SiteAccessPolicy({ storage: adapter }); await policy.ready;
  assert.equal(policy.status().retryable, undefined);
  const replacing = policy.replace(config("block", ["HTTPS://EXAMPLE.COM:443/"]), 4, policy.generation);
  const rejected = assert.rejects(replacing, /OBU_SITE_ACCESS_UNAVAILABLE/);
  await entered.promise; assert.equal(policy.status().retryable, undefined);
  save.reject(new Error("controlled actual adapter rejection")); await rejected;
  const failed = policy.status(); assert.equal(failed.ready, false); assert.equal(failed.retryable, true);
  assert.equal(failed.revision, 5); assert.deepEqual(failed.origins, ["https://example.com"]);
  failed.origins[0] = "https://mutated.example";
  adapter.set = write;
  const retried = policy.retry(5, policy.generation); assert.equal(policy.status().retryable, undefined);
  const confirmed = await retried;
  assert.deepEqual(withoutGeneration(confirmed), { ...stored(6, "block"), ready: true, stored: true }); assert.equal(policy.status().retryable, undefined);
  assert.deepEqual(adapter.writes, [{ [SITE_ACCESS_POLICY_KEY]: stored(6, "block") }]);
  await assert.rejects(policy.retry(5, policy.generation), /OBU_SITE_ACCESS_REVISION_CONFLICT/);
  await assert.rejects(policy.retry(6, policy.generation), /OBU_SITE_ACCESS_RETRY_UNAVAILABLE/);
  assert.equal(adapter.writes.length, 1);
});

test("pending or concurrent retries never start a second write, and another rejection retains the new failed revision", async () => {
  const adapter = storage(stored()); adapter.set = async () => { throw new Error("first failure"); };
  const policy = new SiteAccessPolicy({ storage: adapter }); await policy.ready;
  await assert.rejects(policy.replace(config("allow", ["https://original.example"]), 4, policy.generation));
  const entered = deferred(), pending = deferred(); let calls = 0;
  adapter.set = value => { calls++; assert.deepEqual(value[SITE_ACCESS_POLICY_KEY], stored(6, "allow", ["https://original.example"])); entered.resolve(); return pending.promise; };
  const retry = policy.retry(5, policy.generation), rejected = assert.rejects(retry, /OBU_SITE_ACCESS_UNAVAILABLE/);
  await assert.rejects(policy.retry(5, policy.generation), /OBU_SITE_ACCESS_RETRY_UNAVAILABLE|OBU_SITE_ACCESS_REVISION_CONFLICT/);
  await entered.promise; assert.equal(policy.status().retryable, undefined); assert.equal(calls, 1);
  pending.reject(new Error("second failure")); await rejected;
  assert.equal(policy.status().retryable, true); assert.equal(policy.status().revision, 6);
  assert.deepEqual(policy.status().origins, ["https://original.example"]);
});

test("startup, validation, CAS and revision exhaustion cannot manufacture retry authority", async () => {
  for (const adapter of [storage(null), { get: async () => { throw new Error("read failure"); }, set: async () => assert.fail("must not write") }]) {
    const policy = new SiteAccessPolicy({ storage: adapter }); await assert.rejects(policy.ready);
    assert.equal(policy.status().retryable, undefined);
    await assert.rejects(policy.retry(policy.status().revision, policy.generation), /OBU_SITE_ACCESS_RETRY_UNAVAILABLE/);
  }
  const adapter = storage(stored()), policy = new SiteAccessPolicy({ storage: adapter }); await policy.ready;
  await assert.rejects(policy.replace({ mode: "invalid", origins: [] }, 4, policy.generation));
  await assert.rejects(policy.replace(config(), 3, policy.generation), /OBU_SITE_ACCESS_REVISION_CONFLICT/);
  assert.equal(policy.status().retryable, undefined); await assert.rejects(policy.retry(4, policy.generation), /OBU_SITE_ACCESS_RETRY_UNAVAILABLE/);
  assert.equal(adapter.writes.length, 0);
  const exhausted = new SiteAccessPolicy({ storage: storage(stored(Number.MAX_SAFE_INTEGER)) }); await exhausted.ready;
  await assert.rejects(exhausted.replace(config(), Number.MAX_SAFE_INTEGER, exhausted.generation), /OBU_SITE_ACCESS_REVISION_EXHAUSTED/);
  assert.equal(exhausted.status().retryable, undefined);
});

test("explicit read recovery replaces the rejected ready promise and preserves the persisted revision", async () => {
  let reads = 0;
  const adapter = storage(stored(8));
  const read = adapter.get;
  adapter.get = key => {
    assert.equal(key, SITE_ACCESS_POLICY_KEY);
    if (++reads === 1) throw new Error("private adapter detail");
    return read();
  };
  const policy = new SiteAccessPolicy({ storage: adapter }), originalReady = policy.ready;
  await assert.rejects(originalReady, /OBU_SITE_ACCESS_UNAVAILABLE/);
  const failed = policy.status();
  assert.equal(failed.recovery?.state, "read-error");
  assert.match(failed.recovery.id, /^[0-9a-f-]{36}$/);
  assert.equal(failed.stored, undefined);
  assert.equal(JSON.stringify(failed).includes("private adapter detail"), false);
  policy.assertRecovery(failed.recovery.id);
  const retry = policy.retryLoad(failed.recovery.id);
  assert.equal(retry, policy.ready); assert.notEqual(retry, originalReady);
  assert.deepEqual(withoutGeneration(await retry), { ...stored(8), ready: true, stored: true });
  assert.equal(policy.status().error, undefined); assert.equal(policy.status().recovery, undefined);
  assert.equal(adapter.writes.length, 0); assert.equal(reads, 2);
  // A successful reread must also repair the promise awaited by later writes.
  await policy.replace(config("block"), 8, policy.generation);
  assert.equal(policy.status().revision, 9); assert.equal(adapter.writes.length, 1);
});

test("pending reads reserve recovery synchronously and an observer timeout grants no second read", async () => {
  const first = deferred(), next = deferred(); let reads = 0;
  const policy = new SiteAccessPolicy({ storage: {
    get() { return ++reads === 1 ? first.promise : next.promise; }, set: async () => assert.fail("read recovery cannot write"),
  } });
  assert.deepEqual(policy.status().recovery, { state: "pending" });
  assert.throws(() => policy.retryLoad("not-a-settled-id"), /OBU_SITE_ACCESS_RECOVERY_UNAVAILABLE/);
  first.reject(new Error("first read rejected")); await assert.rejects(policy.ready);
  const id = policy.status().recovery.id;
  const retry = policy.retryLoad(id); let settled = false; retry.finally(() => { settled = true; });
  assert.equal(retry, policy.ready); assert.deepEqual(policy.status().recovery, { state: "pending" });
  assert.throws(() => policy.assertRecovery(id), /OBU_SITE_ACCESS_RECOVERY_UNAVAILABLE/);
  assert.throws(() => policy.retryLoad(id), /OBU_SITE_ACCESS_RECOVERY_UNAVAILABLE/);
  assert.equal(await Promise.race([retry.then(() => "read"), Promise.resolve("observer ended")]), "observer ended");
  assert.equal(settled, false); assert.equal(reads, 2); assert.equal(policy.restricted, true);
  next.resolve({ [SITE_ACCESS_POLICY_KEY]: stored(19, "block") }); await retry;
  assert.equal(settled, true); assert.equal(policy.status().revision, 19);
});

test("each settled read failure has a fresh exact recovery identity, isolated from other instances", async () => {
  let reads = 0;
  const adapter = { get: async () => { reads++; throw new Error("private read details"); }, set: async () => assert.fail("must not write") };
  const policy = new SiteAccessPolicy({ storage: adapter }); await assert.rejects(policy.ready);
  const first = policy.status().recovery.id;
  for (const id of [undefined, null, 1, {}, "", "private invalid id", "x".repeat(2048)]) {
    assert.throws(() => policy.retryLoad(id), error => /^OBU_SITE_ACCESS_RECOVERY_CONFLICT:/.test(error.message) && !error.message.includes("private"));
  }
  assert.equal(reads, 1);
  const copied = policy.status(); copied.recovery.id = "changed";
  await assert.rejects(policy.retryLoad(first), /OBU_SITE_ACCESS_UNAVAILABLE/);
  const second = policy.status().recovery.id;
  assert.notEqual(second, first); assert.notEqual(second, "changed");
  assert.throws(() => policy.retryLoad(first), /OBU_SITE_ACCESS_RECOVERY_CONFLICT/);
  const other = new SiteAccessPolicy({ storage: adapter }); await assert.rejects(other.ready);
  assert.notEqual(other.status().recovery.id, second);
  assert.throws(() => other.retryLoad(second), /OBU_SITE_ACCESS_RECOVERY_CONFLICT/);
  assert.equal(reads, 3);
});

test("corrupt persisted policy requires a valid reread and never resets or writes the original revision", async () => {
  let current = { ...stored(27), origins: ["https://private.example/path"] }, reads = 0, writes = 0;
  const policy = new SiteAccessPolicy({ storage: {
    async get() { reads++; return { [SITE_ACCESS_POLICY_KEY]: structuredClone(current) }; }, async set() { writes++; },
  } });
  await assert.rejects(policy.ready, /OBU_SITE_ACCESS_STATE_INVALID/);
  const first = policy.status().recovery;
  assert.equal(first.state, "invalid"); assert.equal(JSON.stringify(policy.status()).includes("private"), false);
  await assert.rejects(policy.retryLoad(first.id), /OBU_SITE_ACCESS_STATE_INVALID/);
  assert.equal(policy.status().recovery.state, "invalid"); assert.notEqual(policy.status().recovery.id, first.id);
  assert.equal(policy.allowsUrl("https://example.com"), false);
  current = stored(27, "allow", ["HTTPS://EXAMPLE.COM:443/"]);
  assert.deepEqual(withoutGeneration(await policy.retryLoad(policy.status().recovery.id)), { ...stored(27), ready: true, stored: true });
  assert.equal(reads, 3); assert.equal(writes, 0);
});

test("only a successful storage object with no value is known absence, including an explicit recovery", async () => {
  for (const absent of [{}, { [SITE_ACCESS_POLICY_KEY]: undefined }]) {
    let result = null, writes = 0;
    const policy = new SiteAccessPolicy({ storage: { get: async () => result, set: async () => { writes++; } } });
    await assert.rejects(policy.ready, /OBU_SITE_ACCESS_UNAVAILABLE/);
    result = absent;
    const recovered = await policy.retryLoad(policy.status().recovery.id);
    const fresh = new SiteAccessPolicy({ storage: { get: async () => absent, set: async () => {} } }); await fresh.ready;
    assert.deepEqual(withoutGeneration(recovered), { version: 1, revision: 0, mode: "all", origins: [], ready: true, stored: false });
    assert.deepEqual(withoutGeneration(recovered), withoutGeneration(fresh.status())); assert.equal(writes, 0);
    await policy.replace(config("allow"), 0, policy.generation);
    assert.equal(policy.status().stored, true); assert.equal(writes, 1);
  }
  const saved = new SiteAccessPolicy({ storage: storage(stored(0, "all", [])) }); await saved.ready;
  assert.equal(saved.status().stored, true);
});

test("malformed read results and rejected reads cannot masquerade as absent storage", async () => {
  for (const result of [undefined, null, [], "", 0, { [SITE_ACCESS_POLICY_KEY]: null }, { [SITE_ACCESS_POLICY_KEY]: {} }]) {
    const policy = new SiteAccessPolicy({ storage: { get: async () => result, set: async () => assert.fail("must not write") } });
    const corruptRecord = result !== null && typeof result === "object" && !Array.isArray(result);
    const errorCode = corruptRecord ? /OBU_SITE_ACCESS_STATE_INVALID/ : /OBU_SITE_ACCESS_UNAVAILABLE/;
    await assert.rejects(policy.ready, errorCode);
    assert.equal(policy.status().recovery.state, corruptRecord ? "invalid" : "read-error"); assert.equal(policy.status().stored, undefined);
    assert.equal(policy.loaded, false); assert.equal(policy.allowsUrl("https://example.com"), false);
    await assert.rejects(policy.retryLoad(policy.status().recovery.id), errorCode);
  }
  // Storage error text is untrusted; it cannot select the validation category.
  const policy = new SiteAccessPolicy({ storage: {
    get: async () => { throw new Error("OBU_SITE_ACCESS_STATE_INVALID: private adapter detail"); }, set: async () => {},
  } });
  await assert.rejects(policy.ready, /OBU_SITE_ACCESS_UNAVAILABLE/);
  assert.equal(policy.status().recovery.state, "read-error");
});

test("failed writes, pending writes, and ready settings never grant read recovery authority", async () => {
  let reads = 0;
  const entered = deferred(), save = deferred(), adapter = storage(stored()), read = adapter.get;
  adapter.get = () => { reads++; return read(); };
  adapter.set = () => { entered.resolve(); return save.promise; };
  const policy = new SiteAccessPolicy({ storage: adapter }); await policy.ready;
  assert.throws(() => policy.retryLoad("invented"), /OBU_SITE_ACCESS_RECOVERY_UNAVAILABLE/);
  const replacing = policy.replace(config("block"), 4, policy.generation), rejected = assert.rejects(replacing);
  await entered.promise;
  assert.equal(policy.status().recovery, undefined);
  assert.throws(() => policy.retryLoad("invented"), /OBU_SITE_ACCESS_RECOVERY_UNAVAILABLE/);
  save.reject(new Error("actual save rejection")); await rejected;
  assert.equal(policy.status().retryable, true); assert.equal(policy.status().recovery, undefined);
  assert.throws(() => policy.retryLoad("invented"), /OBU_SITE_ACCESS_RECOVERY_UNAVAILABLE/);
  assert.equal(reads, 1); assert.equal(policy.status().revision, 5);
});

test("replacement: runtime generations reject same-revision identities from another worker", async () => {
  const adapter = storage(stored(1));
  const first = new SiteAccessPolicy({ storage: adapter }); await first.ready;
  const second = new SiteAccessPolicy({ storage: adapter }); await second.ready;
  assert.match(first.generation, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(first.status().generation, first.generation);
  assert.notEqual(second.generation, first.generation);
  await assert.rejects(second.replace(config("all", []), 1, first.generation), /OBU_SITE_ACCESS_GENERATION_CONFLICT/);
  for (const generation of [undefined, null, "", "arbitrary", 1, {}, first.generation]) {
    assert.throws(() => second.assertGeneration(generation), /OBU_SITE_ACCESS_GENERATION_CONFLICT/);
  }
  assert.equal(adapter.writes.length, 0);
});

test("replacement: invalid reservation consumes the ID before awaiting and keeps native pending blocked", async () => {
  const adapter = storage(null), pending = deferred(), entered = deferred();
  const originalSet = adapter.set;
  adapter.set = async value => { entered.resolve(); await pending.promise; return originalSet(value); };
  const policy = new SiteAccessPolicy({ storage: adapter }); await assert.rejects(policy.ready);
  const failed = policy.status(), candidate = config("allow", ["HTTPS://EXAMPLE.COM:443/"]);
  policy.assertInvalidReplacement(failed.recovery.id);
  const operation = policy.replaceInvalid(candidate, failed.recovery.id);
  assert.equal(policy.ready, operation);
  assert.deepEqual(policy.status().recovery, { state: "pending" });
  assert.notEqual(policy.generation, failed.generation);
  candidate.origins[0] = "https://mutated.example";
  assert.throws(() => policy.replaceInvalid(config("all", []), failed.recovery.id), /OBU_SITE_ACCESS_RECOVERY_UNAVAILABLE/);
  assert.throws(() => policy.retryLoad(failed.recovery.id), /OBU_SITE_ACCESS_RECOVERY_UNAVAILABLE/);
  await entered.promise;
  assert.equal(policy.status().ready, false); assert.equal(policy.status().retryable, undefined);
  assert.equal(policy.allowsUrl("https://example.com"), false);
  assert.equal(await Promise.race([operation.then(() => "native"), Promise.resolve("observer ended")]), "observer ended");
  assert.throws(() => policy.assertRetryable(1, policy.generation), /OBU_SITE_ACCESS_RETRY_UNAVAILABLE/);
  pending.resolve(); const saved = await operation;
  assert.equal(saved.ready, true); assert.equal(saved.revision, 1); assert.equal(saved.stored, true);
  assert.deepEqual(adapter.writes, [{ [SITE_ACCESS_POLICY_KEY]: stored(1) }]);
  const restarted = new SiteAccessPolicy({ storage: adapter }); await restarted.ready;
  assert.notEqual(restarted.generation, saved.generation);
  assert.equal(restarted.status().revision, 1); assert.equal(restarted.allowsUrl("https://example.com"), true);
  await policy.replace(config("block"), 1, saved.generation);
  assert.equal(policy.status().revision, 2); assert.equal(policy.generation, saved.generation);
});

test("replacement: actual write rejection grants exact candidate retry despite rejected startup", async () => {
  const adapter = storage({ ...stored(99), mode: "invalid" }), write = adapter.set;
  let attempts = 0;
  adapter.set = value => { attempts++; return attempts === 1 ? Promise.reject(new Error("private native failure")) : write(value); };
  const policy = new SiteAccessPolicy({ storage: adapter }); await assert.rejects(policy.ready);
  const original = policy.status();
  await assert.rejects(policy.replaceInvalid(config("block"), original.recovery.id), /OBU_SITE_ACCESS_UNAVAILABLE/);
  const failed = policy.status();
  assert.equal(failed.revision, 1); assert.equal(failed.retryable, true); assert.equal(failed.recovery, undefined);
  assert.equal(policy.allowsUrl("https://other.example"), false);
  assert.equal(JSON.stringify(failed).includes("private"), false);
  await assert.rejects(policy.retry(1, original.generation), /OBU_SITE_ACCESS_GENERATION_CONFLICT/);
  const result = await policy.retry(1, failed.generation);
  assert.equal(result.generation, failed.generation); assert.equal(result.revision, 2); assert.equal(result.ready, true);
  assert.deepEqual(adapter.writes, [{ [SITE_ACCESS_POLICY_KEY]: stored(2, "block") }]);
  await policy.replace(config("allow"), 2, result.generation);
  assert.equal(policy.status().revision, 3); assert.equal(attempts, 3);
});

test("replacement: pre-dispatch deadline failure makes no write or retry authority and rotates invalid ID", async () => {
  const adapter = storage(null), policy = new SiteAccessPolicy({ storage: adapter }); await assert.rejects(policy.ready);
  const first = policy.status(), error = new Error("original deadline expired");
  const operation = policy.replaceInvalid(config("all", []), first.recovery.id, { beforeWrite() { throw error; } });
  await assert.rejects(operation, value => value === error);
  const next = policy.status();
  assert.equal(adapter.writes.length, 0); assert.equal(next.ready, false); assert.equal(next.retryable, undefined);
  assert.equal(next.recovery.state, "invalid"); assert.notEqual(next.recovery.id, first.recovery.id);
  assert.throws(() => policy.assertInvalidReplacement(first.recovery.id), /OBU_SITE_ACCESS_RECOVERY_CONFLICT/);
  const saved = await policy.replaceInvalid(config("allow"), next.recovery.id);
  assert.equal(saved.ready, true); assert.equal(saved.revision, 1); assert.equal(adapter.writes.length, 1);
});

test("replacement: malformed envelopes and read errors never grant replacement authority", async () => {
  for (const result of [undefined, null, [], "", 0]) {
    const policy = new SiteAccessPolicy({ storage: { get: async () => result, set: async () => assert.fail("no write") } });
    await assert.rejects(policy.ready, /OBU_SITE_ACCESS_UNAVAILABLE/);
    assert.equal(policy.status().recovery.state, "read-error");
    assert.throws(() => policy.assertInvalidReplacement(policy.status().recovery.id), /OBU_SITE_ACCESS_RECOVERY_UNAVAILABLE/);
  }
  for (const result of [{}, { [SITE_ACCESS_POLICY_KEY]: undefined }]) {
    const policy = new SiteAccessPolicy({ storage: { get: async () => result, set: async () => assert.fail("no write") } }); await policy.ready;
    assert.throws(() => policy.assertInvalidReplacement("invented"), /OBU_SITE_ACCESS_RECOVERY_UNAVAILABLE/);
    assert.equal(policy.status().stored, false);
  }
});

test("replacement: reread and replacement cannot reuse each other's recovery ID", async () => {
  const adapter = storage(null), pending = deferred();
  const policy = new SiteAccessPolicy({ storage: adapter }); await assert.rejects(policy.ready);
  const first = policy.status();
  adapter.get = () => pending.promise;
  const reread = policy.retryLoad(first.recovery.id);
  assert.throws(() => policy.replaceInvalid(config("all", []), first.recovery.id), /OBU_SITE_ACCESS_RECOVERY_UNAVAILABLE/);
  pending.resolve({ [SITE_ACCESS_POLICY_KEY]: stored(0, "block") }); await reread;
  assert.notEqual(policy.generation, first.generation);
  await assert.rejects(policy.replace(config("all", []), 0, first.generation), /OBU_SITE_ACCESS_GENERATION_CONFLICT/);
  assert.equal(adapter.writes.length, 0);
});

test("replacement: a failed dispatch guard does not consume revision or grant retry", async () => {
  const adapter = storage(stored()), policy = new SiteAccessPolicy({ storage: adapter }); await policy.ready;
  const generation = policy.generation;
  const error = new Error("admission closed");
  await assert.rejects(policy.replace(config("all", []), 4, generation, { beforeWrite() { throw error; } }), value => value === error);
  assert.equal(adapter.writes.length, 0); assert.equal(policy.status().revision, 4); assert.equal(policy.status().ready, true);
  assert.equal(policy.status().retryable, undefined);
  await assert.rejects(policy.replace(config("all", []), 4, generation, { beforeWrite: async () => {} }), /OBU_SITE_ACCESS_INVALID/);
  assert.equal(adapter.writes.length, 0);
  await policy.replace(config("block"), 4, generation);
  assert.equal(policy.status().revision, 5);
});

test("replacement: a write queued behind the original read cannot inherit its new generation", async () => {
  const read = deferred(); let writes = 0;
  const policy = new SiteAccessPolicy({ storage: { get: () => read.promise, set: async () => { writes++; } } });
  const originalGeneration = policy.generation;
  const saving = policy.replace(config("all", []), 4, originalGeneration);
  const rejected = assert.rejects(saving, /OBU_SITE_ACCESS_GENERATION_CONFLICT/);
  read.resolve({ [SITE_ACCESS_POLICY_KEY]: stored(4) }); await policy.ready; await rejected;
  assert.notEqual(policy.generation, originalGeneration); assert.equal(writes, 0);
  assert.equal(policy.status().revision, 4); assert.equal(policy.status().ready, true);
});

test("replacement: failed retry guard preserves only the prior real failed candidate", async () => {
  let attempts = 0;
  const adapter = storage(null);
  adapter.set = () => { attempts++; return Promise.reject(new Error("real write rejection")); };
  const policy = new SiteAccessPolicy({ storage: adapter }); await assert.rejects(policy.ready);
  await assert.rejects(policy.replaceInvalid(config("block"), policy.status().recovery.id));
  const failed = policy.status(), expired = new Error("original deadline expired");
  await assert.rejects(policy.retry(failed.revision, failed.generation, { beforeWrite() { throw expired; } }), value => value === expired);
  assert.deepEqual(policy.status(), failed); assert.equal(attempts, 1);
  const pending = deferred(), entered = deferred();
  adapter.set = () => { attempts++; entered.resolve(); return pending.promise; };
  const retry = policy.retry(failed.revision, failed.generation), rejected = assert.rejects(retry, /OBU_SITE_ACCESS_UNAVAILABLE/);
  await entered.promise;
  await assert.rejects(policy.retry(failed.revision + 1, failed.generation), /OBU_SITE_ACCESS_RETRY_UNAVAILABLE/);
  assert.equal(policy.status().retryable, undefined); assert.equal(attempts, 2);
  pending.reject(new Error("second real write rejection")); await rejected;
  assert.equal(policy.status().revision, 2); assert.equal(policy.status().generation, failed.generation);
  assert.equal(policy.status().retryable, true); assert.equal(policy.allowsUrl("https://other.example"), false);
});
