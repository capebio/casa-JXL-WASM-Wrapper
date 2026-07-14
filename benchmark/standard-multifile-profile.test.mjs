import test from "node:test";
import assert from "node:assert/strict";

import {
  computeSourceDecodeMetrics,
  resolveBenchmarkProfile,
} from "./standard-multifile-profile.mjs";

test("standard-core profile disables pyramid, additional benches, and graph launch", () => {
  const profile = resolveBenchmarkProfile({ STANDARD_MULTIFILE_PROFILE: "core" });

  assert.equal(profile.workloadProfile, "standard-core");
  assert.equal(profile.runPyramidBench, false);
  assert.equal(profile.runAdditionalBenches, false);
  assert.equal(profile.openGraph, false);
});

test("standard-full profile preserves full diagnostic defaults", () => {
  const profile = resolveBenchmarkProfile({ STANDARD_MULTIFILE_PROFILE: "full" });

  assert.equal(profile.workloadProfile, "standard-full");
  assert.equal(profile.runPyramidBench, true);
  assert.equal(profile.runAdditionalBenches, true);
  assert.equal(profile.openGraph, true);
});

test("explicit benchmark env overrides profile defaults", () => {
  const profile = resolveBenchmarkProfile({
    STANDARD_MULTIFILE_PROFILE: "full",
    STANDARD_MULTIFILE_RUN_PYRAMID: "0",
    SKIP_ADDITIONAL_BENCHES: "1",
    STANDARD_MULTIFILE_OPEN_GRAPH: "0",
  });

  assert.equal(profile.workloadProfile, "standard-full");
  assert.equal(profile.runPyramidBench, false);
  assert.equal(profile.runAdditionalBenches, false);
  assert.equal(profile.openGraph, false);
});

test("source decode metrics split RAW and JPEG archival work", () => {
  const metrics = computeSourceDecodeMetrics([
    { file: "a.jpg", rawMs: 120, jpegDecodeMs: 40, jpegTranscodeMs: 80 },
    { file: "b.dng", rawMs: 300, rawDecompress: 90, rawDemosaic: 60, rawTonemap: 120 },
    { file: "c.ORF", rawMs: 500, rawDecompress: 200, rawDemosaic: 80, rawTonemap: 180 },
  ]);

  assert.equal(metrics.avgSourceDecodeMs, 307);
  assert.equal(metrics.avgRawMs, 307);
  assert.equal(metrics.avgRawOnlyMs, 400);
  assert.equal(metrics.avgJpegDecodeMs, 40);
  assert.equal(metrics.avgJpegArchivalMs, 80);
  assert.equal(metrics.avgRawOnlyDecompressMs, 145);
  assert.equal(metrics.avgRawOnlyDemosaicMs, 70);
  assert.equal(metrics.avgRawOnlyTonemapMs, 150);
});
