import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AssetStore,
  measureBytes,
  contentHash,
  fitWithinBudget,
  isQuotaExceeded,
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
});
