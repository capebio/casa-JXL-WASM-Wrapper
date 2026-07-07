import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AssetStore,
  measureBytes,
  contentHash,
  fitWithinBudget,
  isQuotaExceeded,
  persistentBackendFromCache,
  estimateDecodePeakBytes,
  OUT_FULL_RGB8,
  OUT_LIGHTBOX,
  OUT_THUMB,
  OUT_FULL_16,
  OUT_FULL_DISP16,
  OUT_BATCH_DEFAULT,
} from "../src/index.js";

const buf = (n, fill = 0) => new Uint8Array(n).fill(fill);

// ---- measureBytes ----
test("measureBytes handles the byte-carriers the caches hold", () => {
  assert.equal(measureBytes(new Uint8Array(10)), 10);
  assert.equal(measureBytes(new ArrayBuffer(16)), 16);
  assert.equal(measureBytes(new Uint16Array(4)), 8);
  assert.equal(measureBytes("abcd"), 8); // UTF-16 code units
  assert.equal(measureBytes(null), 0);
  assert.ok(Number.isNaN(measureBytes({ rgba: new Uint8Array(4) }))); // opaque → NaN
});

// ---- contentHash ----
test("contentHash is deterministic and content-addressed", () => {
  const a = contentHash(new Uint8Array([1, 2, 3, 4]));
  const b = contentHash(new Uint8Array([1, 2, 3, 4]));
  const c = contentHash(new Uint8Array([1, 2, 3, 5]));
  assert.equal(a, b, "same bytes → same key");
  assert.notEqual(a, c, "different bytes → different key");
  assert.match(a, /^[0-9a-f]{16}$/);
  // string vs equivalent utf-8 bytes agree
  assert.equal(contentHash("hello"), contentHash(new TextEncoder().encode("hello")));
});

// ---- fitWithinBudget ----
test("fitWithinBudget admits in priority order until the cap", () => {
  const items = [
    { name: "a", size: 10 },
    { name: "b", size: 20 },
    { name: "c", size: 5 },
    { name: "d", size: 100 },
  ];
  const r = fitWithinBudget(items, 30, (i) => i.size);
  assert.deepEqual(
    r.admitted.map((i) => i.name),
    ["a", "b"],
  );
  assert.deepEqual(
    r.skipped.map((i) => i.name),
    ["c", "d"],
  );
  assert.equal(r.usedBytes, 30);
});

test("fitWithinBudget with a 32 MiB cap mirrors the file-picker policy", () => {
  const MB = 1024 * 1024;
  const files = [
    { n: "raw1", size: 20 * MB },
    { n: "raw2", size: 20 * MB }, // would overflow → metadata-only
    { n: "small", size: 1 * MB }, // still fits after raw2 skipped
  ];
  const r = fitWithinBudget(files, 32 * MB, (f) => f.size);
  assert.deepEqual(
    r.admitted.map((f) => f.n),
    ["raw1", "small"],
  );
  assert.equal(r.usedBytes, 21 * MB);
});

// ---- isQuotaExceeded ----
test("isQuotaExceeded recognizes cross-browser quota errors", () => {
  assert.ok(isQuotaExceeded({ name: "QuotaExceededError" }));
  assert.ok(isQuotaExceeded({ code: 22 }));
  assert.ok(isQuotaExceeded({ code: 1014 }));
  assert.ok(isQuotaExceeded({ name: "NS_ERROR_DOM_QUOTA_REACHED" }));
  assert.ok(!isQuotaExceeded(new Error("boom")));
  assert.ok(!isQuotaExceeded(null));
});

// ---- core get/set/has/peek/delete ----
test("basic set/get/has/peek/delete + byte accounting", () => {
  const s = new AssetStore({ maxBytes: 1000 });
  s.set("a", buf(100));
  s.set("b", buf(200));
  assert.equal(s.size, 2);
  assert.equal(s.bytes, 300);
  assert.ok(s.has("a"));
  assert.equal(s.peek("a").byteLength, 100);
  assert.equal(s.get("missing"), undefined);
  assert.ok(s.delete("a"));
  assert.equal(s.bytes, 200);
  assert.ok(!s.delete("a"));
});

test("set replaces without double-counting and without firing onEvict", () => {
  const evicted = [];
  const s = new AssetStore({ maxBytes: 1000, onEvict: (k, sz, r) => evicted.push([k, r]) });
  s.set("a", buf(100));
  s.set("a", buf(300)); // update, not evict
  assert.equal(s.bytes, 300);
  assert.equal(s.size, 1);
  assert.deepEqual(evicted, []);
});

test("opaque value requires explicit sizeBytes", () => {
  const s = new AssetStore({ maxBytes: 1000 });
  assert.throws(() => s.set("x", { rgba: buf(4), w: 1, h: 1 }));
  // explicit size is accepted (this is how peepCache decoded {rgba,w,h} registers)
  const decoded = { rgba: buf(400), w: 10, h: 10 };
  s.set("peep:0:75", decoded, decoded.rgba.byteLength);
  assert.equal(s.bytes, 400);
  assert.equal(s.get("peep:0:75"), decoded);
});

// ---- LRU eviction ----
test("byte-budget LRU evicts oldest first", () => {
  const evicted = [];
  const s = new AssetStore({ maxBytes: 300, onEvict: (k, sz, r) => evicted.push([k, r]) });
  s.set("a", buf(100));
  s.set("b", buf(100));
  s.set("c", buf(100)); // full
  s.set("d", buf(100)); // evicts "a"
  assert.ok(!s.has("a"));
  assert.ok(s.has("d"));
  assert.deepEqual(evicted, [["a", "lru"]]);
  assert.equal(s.bytes, 300);
});

test("get() promotes to most-recently-used so it survives eviction", () => {
  const s = new AssetStore({ maxBytes: 300 });
  s.set("a", buf(100));
  s.set("b", buf(100));
  s.set("c", buf(100));
  s.get("a"); // touch a → now newest; b is oldest
  s.set("d", buf(100)); // evicts b, not a
  assert.ok(s.has("a"));
  assert.ok(!s.has("b"));
});

test("never evicts the key currently being inserted", () => {
  const s = new AssetStore({ maxBytes: 300 });
  s.set("a", buf(100));
  s.set("b", buf(100));
  s.set("big", buf(250)); // must evict a AND b, keep big
  assert.ok(s.has("big"));
  assert.equal(s.size, 1);
});

test("oversized single value is kept and counted", () => {
  const s = new AssetStore({ maxBytes: 100 });
  s.set("huge", buf(500));
  assert.ok(s.has("huge"));
  assert.equal(s.stats().oversized, 1);
});

test("setMaxBytes shrinks the budget and evicts to fit", () => {
  const s = new AssetStore({ maxBytes: 1000 });
  s.set("a", buf(300));
  s.set("b", buf(300));
  s.set("c", buf(300));
  s.setMaxBytes(400);
  assert.ok(s.bytes <= 400);
  assert.ok(s.has("c")); // newest survives
});

test("clear fires onEvict('clear') for every entry", () => {
  const reasons = [];
  const s = new AssetStore({ maxBytes: 1000, onEvict: (k, sz, r) => reasons.push(r) });
  s.set("a", buf(10));
  s.set("b", buf(10));
  s.clear();
  assert.equal(s.size, 0);
  assert.equal(s.bytes, 0);
  assert.deepEqual(reasons, ["clear", "clear"]);
});

// ---- governor-via-callback (peepCache migration shape) ----
test("onEvict lets a client cache drop its own reference (governor model)", () => {
  // Mimic peepCache: decoded pixels live in `client`, the store governs bytes.
  const client = new Map();
  const gov = new AssetStore({
    maxBytes: 250,
    onEvict: (key) => client.delete(key),
  });
  const put = (key, bytes) => {
    client.set(key, buf(bytes));
    gov.set(key, true, bytes); // marker value; store tracks bytes only
  };
  put("0:75", 100);
  put("0:80", 100);
  put("0:85", 100); // evicts 0:75 from BOTH store and client
  assert.ok(!client.has("0:75"));
  assert.equal(client.size, 2);
});

// ---- namespace ----
test("namespace isolates keys under one shared budget", () => {
  const s = new AssetStore({ maxBytes: 1000 });
  const peep = s.namespace("peep");
  const fp = s.namespace("filepicker");
  peep.set("0:75", buf(100));
  fp.set("0:75", buf(200)); // same logical key, different namespace
  assert.equal(peep.get("0:75").byteLength, 100);
  assert.equal(fp.get("0:75").byteLength, 200);
  assert.equal(s.size, 2);
  assert.deepEqual([...peep.keys()], ["0:75"]);
});

// ---- quota awareness ----
test("refreshQuota clamps the persistent ceiling to quotaFraction*remaining", async () => {
  const s = new AssetStore({
    maxBytes: 1000,
    quotaFraction: 0.5,
    estimateStorage: async () => ({ quota: 1000, usage: 200 }),
  });
  const r = await s.refreshQuota();
  assert.equal(r.remaining, 800);
  assert.equal(r.persistentLimit, 400); // 0.5 * 800
  assert.equal(s.persistentLimit, 400);
});

test("refreshQuota leaves ceiling unconstrained when estimate unavailable", async () => {
  const s = new AssetStore({ maxBytes: 1000, estimateStorage: async () => null });
  const r = await s.refreshQuota();
  assert.equal(r.persistentLimit, Infinity);
});

// ---- persistent tier + single quota policy ----
class FakeBackend {
  constructor({ failTimes = 0 } = {}) {
    this.map = new Map();
    this.failTimes = failTimes;
    this.setCalls = 0;
  }
  async get(k) {
    return this.map.get(k);
  }
  async set(k, v) {
    this.setCalls++;
    if (this.setCalls <= this.failTimes) {
      const e = new Error("quota");
      e.name = "QuotaExceededError";
      throw e;
    }
    this.map.set(k, v);
  }
  async delete(k) {
    this.map.delete(k);
  }
}

test("load reads through to the persistent backend and promotes to memory", async () => {
  const backend = new FakeBackend();
  await backend.set("k", buf(50, 7));
  const s = new AssetStore({ maxBytes: 1000, persistent: backend });
  assert.equal(s.peek("k"), undefined); // not in memory yet
  const v = await s.load("k");
  assert.equal(v.byteLength, 50);
  assert.ok(s.has("k")); // promoted
  assert.equal(s.stats().persistentReads, 1);
});

test("store write-through recovers from one QuotaExceededError (single policy)", async () => {
  const backend = new FakeBackend({ failTimes: 1 });
  const s = new AssetStore({
    maxBytes: 1000,
    persistent: backend,
    estimateStorage: async () => ({ quota: 1000, usage: 900 }),
  });
  s.set("old1", buf(200));
  s.set("old2", buf(200));
  await s.store("new", buf(100)); // backend rejects once → handleQuota → retry succeeds
  assert.equal(backend.setCalls, 2);
  assert.ok(backend.map.has("new"));
  assert.equal(s.stats().quotaHits, 1);
  // The RAM tier is never evicted for a disk-quota error — value + prior entries stay.
  assert.ok(s.has("new") && s.has("old1") && s.has("old2"));
});

test("store gives up quietly if the backend stays full, keeping the RAM copy", async () => {
  const backend = new FakeBackend({ failTimes: 99 });
  const s = new AssetStore({
    maxBytes: 1000,
    persistent: backend,
    estimateStorage: async () => null,
  });
  await s.store("x", buf(100)); // rejects, retries, still fails → resolves without throwing
  assert.ok(!backend.map.has("x")); // disk write never landed
  assert.ok(s.has("x")); // but the L1 RAM fallback still holds it
  assert.equal(s.stats().quotaHits, 1);
});

test("store without a backend is just an in-memory set", async () => {
  const s = new AssetStore({ maxBytes: 1000 });
  await s.store("x", buf(100));
  assert.ok(s.has("x"));
});

test("stats() reports the governed totals", () => {
  const s = new AssetStore({ maxBytes: 500, name: "peep" });
  s.set("a", buf(100));
  s.get("a");
  s.get("miss");
  const st = s.stats();
  assert.equal(st.name, "peep");
  assert.equal(st.entries, 1);
  assert.equal(st.bytes, 100);
  assert.equal(st.hits, 1);
  assert.equal(st.misses, 1);
  assert.equal(st.admissionWarnings, 0);
});

// ---- decode-admission preflight (S3-Q3, log-only) ----
test("admit warns (log-only) when projected peak exceeds budget, never rejects", () => {
  const s = new AssetStore({ maxBytes: 1000, name: "gate" });
  const logs = [];
  // Mock the estimate with a value that would blow the budget.
  const r = s.admit(1_000_000, { budgetBytes: 100_000, warn: (m) => logs.push(m) });
  assert.equal(r.admitted, true); // NOT a hard reject
  assert.equal(r.wouldExceed, true);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /log-only/);
  assert.match(logs[0], /gate/);
  assert.equal(s.stats().admissionWarnings, 1);
});

test("admit is silent on the hot path when the decode fits", () => {
  const s = new AssetStore({ maxBytes: 1000 });
  const logs = [];
  const r = s.admit(1000, { budgetBytes: 100_000, warn: (m) => logs.push(m) });
  assert.equal(r.admitted, true);
  assert.equal(r.wouldExceed, false);
  assert.equal(logs.length, 0);
  assert.equal(s.stats().admissionWarnings, 0);
});

test("admit default budget is the store's remaining RAM headroom", () => {
  const s = new AssetStore({ maxBytes: 1000 });
  s.set("a", buf(900)); // 100 bytes headroom left
  const logs = [];
  const r = s.admit(200, { multiplier: 1, warn: (m) => logs.push(m) }); // 200 > 100
  assert.equal(r.budgetBytes, 100);
  assert.equal(r.wouldExceed, true);
  assert.equal(logs.length, 1);
});

test("admit composes with estimateDecodePeak — the wired admission gate", () => {
  const s = new AssetStore({ maxBytes: 1 });
  const budgetBytes = 384 * 1024 * 1024; // documented ~384 MB WASM-heap budget
  const logs = [];
  // 24 MP all-flags decode (~517 MB peak × 1.5 ≈ 776 MB) blows the budget → warn.
  const bigFlags = OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB | OUT_FULL_16 | OUT_FULL_DISP16;
  const bigPeak = estimateDecodePeakBytes(6000, 4000, bigFlags);
  const r = s.admit(bigPeak, { budgetBytes, warn: (m) => logs.push(m) });
  assert.equal(r.wouldExceed, true);
  assert.equal(logs.length, 1);
  // A 12 MP shipping-flags decode fits under the same budget → silent.
  const smallPeak = estimateDecodePeakBytes(4000, 3000, OUT_BATCH_DEFAULT);
  const r2 = s.admit(smallPeak, { budgetBytes, warn: (m) => logs.push(m) });
  assert.equal(r2.wouldExceed, false);
  assert.equal(logs.length, 1); // no new warning
});

// ---- jxl-cache OPFS adapter (S3-Q5) ----
class FakeJxlCache {
  constructor() {
    this.map = new Map(); // key → ArrayBuffer (the OPFS L2)
    this.initCalls = 0;
  }
  async init() {
    this.initCalls++;
  }
  async get(k) {
    return this.map.get(k);
  }
  async set(k, buffer) {
    this.map.set(k, buffer);
  }
  async delete(k) {
    this.map.delete(k);
  }
  async has(k) {
    return this.map.has(k);
  }
}

test("persistentBackendFromCache: store → RAM evict → load reads through OPFS L2", async () => {
  const cache = new FakeJxlCache();
  const backend = persistentBackendFromCache(cache);
  const s = new AssetStore({ maxBytes: 250, persistent: backend });
  await s.store("a", buf(100, 1));
  await s.store("b", buf(100, 2));
  await s.store("c", buf(100, 3)); // RAM full (250) → "a" evicted from memory
  assert.ok(!s.has("a"), "a evicted from RAM tier");
  assert.ok(cache.map.has("a"), "a persisted to OPFS L2 during write-through");
  assert.ok(cache.initCalls >= 1, "cache.init() awaited before first op");
  // Miss in RAM → read through the L2 backend → promote back into RAM.
  const v = await s.load("a");
  assert.ok(v, "loaded from L2");
  assert.equal(new Uint8Array(v)[0], 1);
  assert.ok(s.has("a"), "promoted back into RAM");
  assert.equal(s.stats().persistentReads, 1);
});

test("persistentBackendFromCache normalizes a view to a tight non-shared ArrayBuffer", async () => {
  const cache = new FakeJxlCache();
  const backend = persistentBackendFromCache(cache);
  const parent = new Uint8Array(10).fill(9);
  const view = parent.subarray(2, 6); // offset 2, length 4
  await backend.set("k", view);
  const stored = cache.map.get("k");
  assert.ok(stored instanceof ArrayBuffer, "stored as a plain ArrayBuffer");
  assert.equal(stored.byteLength, 4, "tight copy, not the 10-byte parent");
  assert.deepEqual([...new Uint8Array(stored)], [9, 9, 9, 9]);
});

test("persistentBackendFromCache requires get()+set()", () => {
  assert.throws(() => persistentBackendFromCache({}));
  assert.throws(() => persistentBackendFromCache(null));
});

test("persistentBackendFromCache.has falls back to get() when the cache lacks has()", async () => {
  const store = new Map();
  const cache = {
    async get(k) {
      return store.get(k);
    },
    async set(k, b) {
      store.set(k, b);
    },
    async delete(k) {
      store.delete(k);
    },
  };
  const backend = persistentBackendFromCache(cache);
  await backend.set("x", new Uint8Array([1, 2]).buffer);
  assert.equal(await backend.has("x"), true);
  assert.equal(await backend.has("y"), false);
});
