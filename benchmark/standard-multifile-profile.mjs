export const BENCHMARK_SCHEMA_VERSION = 2;

const PROFILE_DEFAULTS = {
  full: {
    workloadProfile: "standard-full",
    runPyramidBench: true,
    runAdditionalBenches: true,
    openGraph: true,
  },
  core: {
    workloadProfile: "standard-core",
    runPyramidBench: false,
    runAdditionalBenches: false,
    openGraph: false,
  },
};

function envFlag(env, name, fallback) {
  if (env[name] === "0") return false;
  if (env[name] === "1") return true;
  return fallback;
}

function avgRounded(rows, selector) {
  if (rows.length === 0) return 0;
  return Math.round(rows.reduce((sum, row) => sum + (selector(row) || 0), 0) / rows.length);
}

export function resolveBenchmarkProfile(env = process.env) {
  const profileName = String(env.STANDARD_MULTIFILE_PROFILE || "full").toLowerCase();
  const base = PROFILE_DEFAULTS[profileName] || PROFILE_DEFAULTS.full;

  return {
    benchmarkSchemaVersion: BENCHMARK_SCHEMA_VERSION,
    profileName: profileName in PROFILE_DEFAULTS ? profileName : "full",
    workloadProfile: base.workloadProfile,
    runPyramidBench: envFlag(env, "STANDARD_MULTIFILE_RUN_PYRAMID", base.runPyramidBench),
    runAdditionalBenches: env.SKIP_ADDITIONAL_BENCHES ? false : base.runAdditionalBenches,
    openGraph: envFlag(env, "STANDARD_MULTIFILE_OPEN_GRAPH", base.openGraph),
    jpegArchivalInRawMs: true,
  };
}

export function computeSourceDecodeMetrics(loadedFiles) {
  const jpegRows = loadedFiles.filter((row) => /\.(jpe?g)$/i.test(row.file));
  const rawRows = loadedFiles.filter((row) => !/\.(jpe?g)$/i.test(row.file));

  return {
    avgSourceDecodeMs: avgRounded(loadedFiles, (row) => row.rawMs),
    avgRawMs: avgRounded(loadedFiles, (row) => row.rawMs),
    avgRawOnlyMs: avgRounded(rawRows, (row) => row.rawMs),
    avgJpegDecodeMs: avgRounded(jpegRows, (row) => row.jpegDecodeMs),
    avgJpegArchivalMs: avgRounded(jpegRows, (row) => row.jpegTranscodeMs),
    avgRawOnlyDecompressMs: avgRounded(rawRows, (row) => row.rawDecompress),
    avgRawOnlyDemosaicMs: avgRounded(rawRows, (row) => row.rawDemosaic),
    avgRawOnlyTonemapMs: avgRounded(rawRows, (row) => row.rawTonemap),
  };
}
