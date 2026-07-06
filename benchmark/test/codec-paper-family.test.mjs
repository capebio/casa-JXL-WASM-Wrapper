import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveFamilyIdFromArtifactName, familyLabelFromId, familyColorFromId } from "../benchmark-history-registry.mjs";

test("codec-paper family resolves stably, no collision", () => {
  for (const ts of ["2026-07-05t00-00-00-000z", "2026-07-06t00-00-00-000z"]) {
    assert.equal(deriveFamilyIdFromArtifactName(`${ts}-CodecPaper-general.toon`, "CodecPaper - general"), "codec-paper");
  }
  assert.equal(familyLabelFromId("codec-paper"), "Codec Paper");
  assert.equal(familyColorFromId("codec-paper"), "#14b8a6");
  assert.equal(deriveFamilyIdFromArtifactName("x-CodecCompare-general.toon", "CodecCompare - general"), "codec-compare");
});
