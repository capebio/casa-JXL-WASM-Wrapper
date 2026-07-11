import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest } from "./manifest.mjs";

test("buildManifest aggregates entries with count + schema", () => {
  const m = buildManifest([
    { name: "a.CR2", sidecar: "a.ai.json", sha256: "h1", hasGeo: true, width: 6000, height: 4000 },
    { name: "b.dng", sidecar: "b.ai.json", sha256: "h2", hasGeo: false, width: 4032, height: 3024 },
  ]);
  assert.equal(m.schema, "casava-ai-manifest/1");
  assert.equal(m.count, 2);
  assert.deepEqual(m.items[0], { name: "a.CR2", sidecar: "a.ai.json", sha256: "h1", has_geo: true, width: 6000, height: 4000 });
  assert.equal(m.items[1].has_geo, false);
});

test("buildManifest handles empty input", () => {
  const m = buildManifest([]);
  assert.equal(m.count, 0);
  assert.deepEqual(m.items, []);
});
