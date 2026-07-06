import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveFamilyIdFromArtifactName, familyLabelFromId, familyColorFromId } from "../benchmark-history-registry.mjs";

test("codec-compare family resolves stably across timestamps, no collision", () => {
  for (const ts of ["2026-07-04t20-00-00-000z", "2026-07-05t09-30-00-000z"]) {
    const id = deriveFamilyIdFromArtifactName(`${ts}-CodecCompare-general.toon`, "CodecCompare - general");
    assert.equal(id, "codec-compare");
  }
  assert.equal(familyLabelFromId("codec-compare"), "Codec Compare");
  assert.equal(familyColorFromId("codec-compare"), "#e879f9");
  // standard family unaffected
  assert.equal(deriveFamilyIdFromArtifactName("x-StandardMultifileTest-general.toon", "StandardMultifileTest - general"), "standard-multifile");
});
