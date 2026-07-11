import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportFolder } from "./export.mjs";

test("exportFolder writes a lean sidecar + manifest for a folder of RAWs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiid-"));
  copyFileSync("c:/Foo/raw-converter/tests/ADH 1248.CR2", join(dir, "ADH 1248.CR2"));
  const { sidecars, manifestPath } = await exportFolder(dir, {});
  assert.equal(sidecars.length, 1);

  const sc = JSON.parse(readFileSync(join(dir, "ADH 1248.ai.json"), "utf8"));
  assert.equal(sc.schema, "casava-ai/1");
  assert.equal(sc.source.format, "cr2");
  assert.equal(sc.image.width, 6000);
  assert.equal("camera" in sc, false); // lean: no photographic EXIF

  assert.ok(existsSync(manifestPath));
  const mf = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(mf.schema, "casava-ai-manifest/1");
  assert.equal(mf.count, 1);
  assert.equal(mf.items[0].name, "ADH 1248.CR2");
});
