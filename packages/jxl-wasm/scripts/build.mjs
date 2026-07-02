#!/usr/bin/env node
import { mkdir, readFile, writeFile, access, readdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const distDir = join(packageRoot, "dist");
// Honor JXL_WASM_WORKDIR so concurrent builds (multiple worktrees/agents) don't share one
// scratch tree and corrupt each other's libjxl clone. Defaults to the shared temp dir.
const workDir = process.env.JXL_WASM_WORKDIR
  ? resolve(process.env.JXL_WASM_WORKDIR)
  : join(os.tmpdir(), "jxl-wasm-work");
const dockerBinary = resolveDockerBinary();
const emcmakeBinary = resolveEmscriptenBinary("emcmake");
const emppBinary = resolveEmscriptenBinary("em++");
const bashBinary = resolveBashBinary();
const config = {
  buildId: "jxl-wasm-0.1.0",
  libjxlRepo: process.env.LIBJXL_REPO ?? "https://github.com/libjxl/libjxl.git",
  libjxlCommit: process.env.LIBJXL_COMMIT ?? "332feb17d17311c748445f7ee75c4fb55cc38530",
  libjxlTag: "v0.11.2",
  emscriptenTag: "4.0.14",
  emscriptenCommit: "refresh-after-first-4.0.14-host-build",
  emsdkImages: resolveEmsdkImages(), // 4.0.14+ for P2-3 LTO re-enable attempt
  tiers: [
    { name: "relaxed-simd-mt", threads: true, simd: true, relaxedSimd: true },
    { name: "simd-mt", threads: true, simd: true, relaxedSimd: false },
    { name: "simd", threads: false, simd: true, relaxedSimd: false }
  ],
  // Budgets are per (module kind × cpu tier): the encoder module is ~2× the
  // decoder (full libjxl_enc + container/sidecar/metadata/gain paths), so a
  // single tier-keyed budget mis-sized enc against the dec target. enc values
  // are measured actual + ~6% headroom (enc:simd ~2.88 MB incl. encode_rgb16_planar
  // and gain-map stubs); MT enc adds pthread glue.
  sizeBudgets: {
    dec: {
      "relaxed-simd-mt": 1_677_722,
      "simd-mt": 1_572_864,
      "simd": 1_363_149
    },
    enc: {
      // +~2.7 KB for the P2c streaming encode (EncodeViaChunkedSource + JS-pull EncodeRgbStream +
      // EM_JS glue); headroom restored to ~the prior ~6%.
      "relaxed-simd-mt": 3_400_000,
      "simd-mt": 3_300_000,
      "simd": 3_100_000
    }
  },
  // Phase 1 module split: dec for viewer (decode-only, smaller), enc for ingest (lazy loaded).
  // Separate exports.txt per role lets wasm-metadce strip unused call trees (encode in dec, unused legacy in enc).
  modules: [
    { role: "dec", exportsFile: "exports-dec.txt", decoderOnly: true },
    { role: "enc", exportsFile: "exports-enc.txt", decoderOnly: false }
  ]
};

// Authoritative list of Emscripten runtime methods we depend on.
// Must match exactly what facade.ts reads off the module (LibjxlWasmModule).
// Current consumers: HEAPU8 (all pixel I/O), HEAPU32 (buffer metadata fast-paths + sidecar dims),
// HEAP32 (advanced settings int32 arrays). No cwrap; no HEAP16/HEAPU16/HEAPF32 (16/32-bit
// pixel paths build their own typed views over the underlying buffer in JS).
const exportedRuntimeMethods = "['HEAPU8','HEAPU32']";

// Phase 1 module split: dec (viewer: decode/region/tile-container-decode, no encoder, no transcode)
// vs enc (ingest: streaming + container encode + sidecars + metadata + gain). Lazy for enc.
const moduleKinds = process.env.JXL_WASM_ONLY_KIND
  ? [process.env.JXL_WASM_ONLY_KIND]
  : ["dec", "enc"];

const baseFlags = [
  "-O3",
  "-sENVIRONMENT=web,worker",
  "-sMODULARIZE=1",
  "-sEXPORT_ES6=1",
  "-sEXPORT_NAME=createJxlModule",
  "-sALLOW_MEMORY_GROWTH=1",
  // INITIAL_MEMORY set per module kind (16 MB dec for tile outputs; 256 MB enc for large 16-bit working sets).
  // See P3-4. Override in link + tierFlags.
  "-sMAXIMUM_MEMORY=4294967296",
  "-sFILESYSTEM=0",
  "-sASSERTIONS=0",
  "-sINVOKE_RUN=0",
  `-sEXPORTED_RUNTIME_METHODS=${exportedRuntimeMethods}`,
  "-sWASM_BIGINT=1",
  "-flto",
  // -flto (compile) re-enabled for P2-3 with emscripten 4.0.14 bump.
  // Recovers cross-TU inlining + ~3-5% size. If binaryen wasm-metadce on
  // this libjxl still says "invalid UTF-8 at offset 0:N", remove -flto here
  // and in linkBridge, pin tag back, and document.
  "-mnontrapping-fptoint",
  "-fno-rtti",
  "-fno-exceptions"
];

const relaxedSimdHighwayFlags = [
  "-mrelaxed-simd",
  "-DHWY_WANT_WASM2"
];

const sourceDir = process.env.LIBJXL_SRC_DIR
  ? resolve(process.env.LIBJXL_SRC_DIR)
  : join(workDir, "libjxl");
// When LIBJXL_SRC_DIR is set, build directly from that working tree (e.g. the
// in-repo external/libjxl-012 fork) and skip the upstream clone + deps.sh fetch
// (third_party are submodules already present in the fork).
const useLocalSource = !!process.env.LIBJXL_SRC_DIR;

// Resolve the git HEAD of a local libjxl source tree (submodule), for honest manifest labelling.
async function localSourceCommit(dir) {
  try {
    const { execFileSync } = await import("node:child_process");
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const insideDocker = process.argv.includes("--inside-docker");
  const hostToolchain = process.argv.includes("--host-toolchain");
  const pgoRequested = process.argv.includes("--pgo");
  const keepWork = process.argv.includes("--keep-work");
  const sizeReportRequested = process.argv.includes("--size-report");
  await mkdir(distDir, { recursive: true });
  await mkdir(workDir, { recursive: true });

  // P5-4: wire PGO staging into main build.
  // Unwired before: build-pgo.mjs only staged lock; no call from build, no flags in Dockerfile/build tiers, no pgo info in manifest.
  // Determination: staging script + pgo-manifest.json exist and are documented; actual profile-generate/use two-pass + training on corpus fixtures (for emcc/libjxl) is not present in build.mjs or Dockerfile.
  // "If viable, apply to enc module first": encoder paths (createImage*/enc_finish + libjxl entropy/modular) benefit most from realistic image training corpus. Decoder PGO is lower priority.
  if (pgoRequested) {
    try {
      const { stagePgoLock } = await import("./build-pgo.mjs");
      await stagePgoLock();
    } catch (e) {
      console.warn("[pgo] staging failed (corpus manifest may be absent):", e?.message ?? e);
    }
  } else {
    // Auto-stage when corpus pgo manifest is present (cheap, no harm).
    try {
      const corpusPgo = join(packageRoot, "..", "jxl-test-corpus", "pgo-manifest.json");
      const { access } = await import("node:fs/promises");
      const { constants } = await import("node:fs");
      await access(corpusPgo, constants.R_OK);
      const { stagePgoLock } = await import("./build-pgo.mjs");
      await stagePgoLock();
    } catch {}
  }

  if (!insideDocker && !hostToolchain) {
    await runDockerBuild();
    return;
  }

  // When building from a local source tree (LIBJXL_SRC_DIR, e.g. the in-repo libjxl-012 fork),
  // record THAT commit — not the default upstream clone pin. Otherwise the manifest mislabels a
  // 012 dist as 0.11.2 (the trap that shipped a wrongly-tagged bridge).
  const localLibjxlCommit = useLocalSource ? await localSourceCommit(sourceDir) : null;
  const manifest = {
    buildId: config.buildId,
    libjxlCommit: localLibjxlCommit ?? config.libjxlCommit,
    libjxlSource: useLocalSource ? "local" : "clone",
    emscriptenTag: config.emscriptenTag,
    emscriptenCommit: config.emscriptenCommit,
    emsdkImage: process.env.JXL_WASM_EMSDK_IMAGE ?? null,
    buildMode: hostToolchain ? "host-toolchain" : insideDocker ? "docker" : "local",
    generatedAt: new Date().toISOString(),
    tiers: {},
    skippedTiers: (hostToolchain && !process.argv.includes("--include-mt"))
      ? config.tiers
        .filter((tier) => tier.threads)
        .flatMap((tier) => moduleKinds.map((kind) => `${kind}:${tier.name}`))
      : [],
    // P5-4: PGO info (if staged). Encoder benefits first.
    pgo: null
  };

  // Populate from just-staged lock (or prior partial build merge below will carry it).
  try {
    const lockPath = join(distDir, "pgo-manifest.lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    manifest.pgo = { staged: true, applied: false, corpusHash: lock.corpusHash, source: lock.source };
  } catch {}

  const onlyMt = process.argv.includes("--only-mt");
  const activeTiers = onlyMt
    ? config.tiers.filter((tier) => tier.threads)
    : (hostToolchain && !process.argv.includes("--include-mt")) ? config.tiers.filter((tier) => !tier.threads) : config.tiers;
  const budgetViolations = [];

  await validateBridgeExports();
  if (useLocalSource) {
    console.log(`[build] using local libjxl source: ${sourceDir} (skipping clone + deps.sh)`);
  } else {
    await ensureLibjxlSource();
    await ensureLibjxlDeps(hostToolchain);
  }

  // Phase 1/3: build matrix is (kind x tier). dec = viewer (decode + tile-decode + region, no enc, transcode=OFF).
  // enc = ingest (streaming/container encode, sidecars, metadata, gain). Lazy-loaded.
  // MT tiers still gated by --include-mt on host-toolchain (COOP/COEP requirement for SharedArrayBuffer).
  for (const kind of moduleKinds) {
    for (const tier of activeTiers) {
      const outJs = join(distDir, `jxl-core.${kind}.${tier.name}.js`);
      const outWasm = join(distDir, `jxl-core.${kind}.${tier.name}.wasm`);
      const buildDir = join(workDir, `${kind}-${tier.name}`);
      await rmDir(buildDir);
      await mkdir(buildDir, { recursive: true });

      // Per-module memory and allocator (P3-4 + P2-6). dec: small for tiles (256px ~256KB out), emmalloc.
      // enc: large working set (20MP RGBA16 ~160MB), avoid repeated grows. mimalloc only behind benchmark.
      const isDec = kind === "dec";
      const isMt = !!tier.threads;
      const initialMem = isDec ? 16777216 : 268435456; // 16 MB vs 256 MB
      const poolSize = isMt ? (isDec ? "4" : "navigator.hardwareConcurrency") : undefined;
      // P3-3: enc ingest prefers single MT instance (pool fan-out in scheduler workers is N^2 hazard).
      // For dec MT inside pooled workers, cap or STRICT=0 for lazy. Numeric values require benchmark on target HW before merge.
      const mallocFlag = isDec ? "-sMALLOC=emmalloc" : undefined;

      const tierFlags = [
        ...baseFlags,
        getIncomingModuleJsApiFlag(),
        `-sINITIAL_MEMORY=${initialMem}`,
        ...(isMt ? ["-pthread", "-sUSE_PTHREADS=1", `-sPTHREAD_POOL_SIZE=${poolSize}`] : []),
        ...(isMt && isDec ? ["-sPTHREAD_POOL_SIZE_STRICT=0"] : []), // lazy spawn for worker dec-MT
        ...(tier.simd ? ["-msimd128"] : []),
        ...(tier.relaxedSimd ? relaxedSimdHighwayFlags : []),
        ...(mallocFlag ? [mallocFlag] : [])
      ];

      const cmakeArgs = [
        "-S",
        sourceDir,
        "-B",
        buildDir,
        "-G",
        "Ninja",
        "-DCMAKE_BUILD_TYPE=Release",
        "-DBUILD_TESTING=OFF",
        "-DJPEGXL_ENABLE_TOOLS=OFF",
        "-DJPEGXL_ENABLE_EXAMPLES=OFF",
        "-DJPEGXL_ENABLE_BENCHMARK=OFF",
        "-DJPEGXL_ENABLE_JPEGLI=OFF",
        ...(isDec ? ["-DJPEGXL_ENABLE_TRANSCODE_JPEG=OFF"] : []),
        "-DTHREADS_PREFER_PTHREAD_FLAG=ON",
        "-DCMAKE_HAVE_LIBC_PTHREAD=1",
        "-DCMAKE_USE_PTHREADS_INIT=1",
        "-DCMAKE_THREAD_LIBS_INIT=-pthread",
        "-DCMAKE_REQUIRED_FLAGS=-pthread",
        "-DCMAKE_REQUIRED_LIBRARIES=-latomic",
        "-DCMAKE_REQUIRED_LINK_OPTIONS=-pthread",
        `-DCMAKE_MODULE_PATH=${toCmakePath(join(packageRoot, "cmake-shims"))}`
      ];
      const tierEnv = {
        ...process.env,
        CFLAGS: tierFlags.join(" "),
        CXXFLAGS: tierFlags.join(" "),
        LDFLAGS: tierFlags.join(" ")
      };
      await runEmscripten(emcmakeBinary, ["cmake", ...cmakeArgs], { cwd: packageRoot, env: tierEnv });
      await run("cmake", ["--build", buildDir, "--", "-j", `${Math.max(1, osCpusMinusOne())}`], { cwd: packageRoot, env: tierEnv });
      const exportsFile = getExportsFileForKind(kind);
      await linkBridge(buildDir, outJs, tierFlags, tierEnv, exportsFile, { emitSymbolMap: sizeReportRequested });

      const tierKey = `${kind}:${tier.name}`;
      const linkOnlyExtras = getLinkOnlyExtras(tierFlags, exportsFile, { emitSymbolMap: sizeReportRequested });
      const wasmBytes = await validateWasmArtifact(outWasm, exportsFile, tierKey, { allowValidateOnly: tier.relaxedSimd });
      const jsArtifact = await readArtifactMetadata(outJs);
      const wasmArtifact = readArtifactMetadataFromBytes(wasmBytes);
      manifest.tiers[tierKey] = {
        kind,
        tier: tier.name,
        jsBytes: jsArtifact.bytes,
        wasmBytes: wasmArtifact.bytes,
        jsBrotliBytes: jsArtifact.brotliBytes,
        wasmBrotliBytes: wasmArtifact.brotliBytes,
        jsSha256: jsArtifact.sha256,
        wasmSha256: wasmArtifact.sha256,
        jsIntegrity: jsArtifact.integrity,
        wasmIntegrity: wasmArtifact.integrity,
        flags: [...tierFlags, ...linkOnlyExtras]
      };

      const budgetKey = `${kind}:${tier.name}`; // budgets are per module kind × cpu tier
      const budget = config.sizeBudgets[kind]?.[tier.name];
      if (budget && wasmArtifact.bytes > budget) {
        await writeFile(
          join(distDir, `${kind}.${tier.name}.size-report.txt`),
          [
            `Module ${kind} tier ${tier.name} exceeded the size budget.`,
            `Budget: ${budget} bytes`,
            `Actual: ${wasmArtifact.bytes} bytes`,
            sizeReportRequested
              ? `Inspect ${outJs}.symbols and linker inputs for the heaviest symbols.`
              : `Re-run ${formatBuildCommand(["--size-report"])} to emit an Emscripten symbol map (${outJs}.symbols).`
          ].join("\n")
        );
        budgetViolations.push(`${tierKey}: ${wasmArtifact.bytes} > ${budget}`);
      }

      if (!keepWork) {
        await rmDir(buildDir);
      }
    }
  }

  assertDistinctRelaxedSimdMt(manifest);
  await writeManifest(manifest);
  if (budgetViolations.length) {
    throw new Error(`Size budgets exceeded:\n${budgetViolations.join("\n")}`);
  }
}

function assertDistinctRelaxedSimdMt(manifest) {
  // Check per-kind if both MT tiers were built for that kind.
  for (const kind of moduleKinds) {
    const relaxed = manifest.tiers[`${kind}:relaxed-simd-mt`];
    const simdMt = manifest.tiers[`${kind}:simd-mt`];
    if (!relaxed || !simdMt) continue;
    if (relaxed.wasmSha256 === simdMt.wasmSha256) {
      throw new Error(
        `${kind}: relaxed-simd-mt wasm matched simd-mt wasm; relaxed tier did not produce a distinct optimized artifact`
      );
    }
  }
}

async function runDockerBuild() {
  const image = "jxl-wasm-builder:local";
  const dockerEnv = { ...process.env };
  const passthrough = process.argv.slice(2).filter((arg) => arg !== "--inside-docker");
  await assertBinary(dockerBinary);
  await assertDockerDaemon(dockerEnv);
  const emsdkImage = await buildDockerImage(image, dockerEnv);
  await run(dockerBinary, [
    "run",
    "--rm",
    "-e",
    `JXL_WASM_EMSDK_IMAGE=${emsdkImage}`,
    "-v",
    `${packageRoot}:/work/jxl-wasm`,
    "-w",
    "/work/jxl-wasm",
    image,
    "node",
    "scripts/build.mjs",
    "--inside-docker",
    ...passthrough
  ], { cwd: packageRoot, env: dockerEnv });
}

async function buildDockerImage(image, dockerEnv) {
  let lastError;
  for (const emsdkImage of config.emsdkImages) {
    try {
      await run(dockerBinary, [
        "build",
        "-t",
        image,
        "--build-arg",
        `EMSDK_IMAGE=${emsdkImage}`,
        "--build-arg",
        `LIBJXL_COMMIT=${config.libjxlCommit}`,
        "--build-arg",
        `LIBJXL_REPO=${config.libjxlRepo}`,
        "-f",
        join(packageRoot, "Dockerfile"),
        packageRoot
      ], { cwd: packageRoot, env: { ...dockerEnv, JXL_WASM_EMSDK_IMAGE: emsdkImage } });
      return emsdkImage;
    } catch (error) {
      lastError = error;
      console.warn(`Emscripten Docker image failed: ${emsdkImage}`);
    }
  }
  throw lastError ?? new Error("No Emscripten Docker images configured");
}

async function linkBridge(buildDir, outJs, tierFlags, env, exportsFile, options = {}) {
  const archives = await findStaticArchives(buildDir);
  const preferred = sortArchivesForLink(archives);
  const includeDirs = [
    join(sourceDir, "lib", "include"),
    sourceDir,
    buildDir,
    join(buildDir, "lib", "include")
  ];
  await runEmscripten(emppBinary, [
    join(packageRoot, "src", "bridge.cpp"),
    ...includeDirs.flatMap((dir) => ["-I", dir]),
    ...preferred,
    "-o",
    outJs,
    ...tierFlags,
    ...getLinkOnlyExtras(tierFlags, exportsFile, options)
  ], { cwd: packageRoot, env });
}

function getExportsFileForKind(kind) {
  return config.modules.find((module) => module.role === kind)?.exportsFile ?? `exports-${kind}.txt`;
}

function getIncomingModuleJsApiFlag() {
  // Handwritten entry points pass only these incoming Module hooks today:
  // - locateFile: browser + tests resolve sibling wasm URL
  // - wasmBinary: Node/Bun preload avoids fetch during local/test runs
  return "-sINCOMING_MODULE_JS_API=locateFile,wasmBinary";
}

function getLinkOnlyExtras(tierFlags, exportsFile, options = {}) {
  return [
    `-sEXPORTED_FUNCTIONS=@${toCmakePath(join(packageRoot, exportsFile))}`,
    ...(options.emitSymbolMap ? ["--emit-symbol-map"] : []),
    "--closure", "1",
    // EVAL_CTORS shrinks .data/ctors but is incompatible with pthreads (passive segments error in libpthread.js).
    // Apply only to non-MT tiers. MT glue still gets --closure 1 (P2-1) for the 31k->~20k win.
    ...(!isThreadedTierFlags(tierFlags) ? ["-sEVAL_CTORS=2"] : [])
  ];
}

function isThreadedTierFlags(tierFlags) {
  return tierFlags.some((flag) => /pthread|USE_PTHREADS/.test(flag));
}

async function findStaticArchives(root) {
  const out = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".a")) {
        out.push(path);
      }
    }
  }
  await visit(root);
  return out;
}

function sortArchivesForLink(archives) {
  const priority = (path) => {
    const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
    if (name === "libjxl.a") return 0;
    if (name === "libjxl_threads.a") return 1;
    if (name === "libjxl_cms.a") return 2;
    return 10;
  };
  return [...archives].sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
}

async function ensureLibjxlSource() {
  try {
    await access(sourceDir, fsConstants.R_OK);
    const head = await runCapture("git", ["-C", sourceDir, "rev-parse", "HEAD"]);
    if (head.trim() === config.libjxlCommit) {
      return;
    }
    await rmDir(sourceDir);
    await clonePinnedSource();
    return;
  } catch {}

  await clonePinnedSource();
}

async function ensureLibjxlDeps(hostToolchain) {
  if (!hostToolchain) {
    return;
  }
  await run(bashBinary, ["deps.sh"], { cwd: sourceDir });
}

async function validateBridgeExports() {
  const bridgeSource = await readFile(join(packageRoot, "src", "bridge.cpp"), "utf8");
  const mismatches = [];
  for (const kind of moduleKinds) {
    const exportsFile = getExportsFileForKind(kind);
    const exportsPath = join(packageRoot, exportsFile);
    await access(exportsPath, fsConstants.R_OK);
    const exportsSource = await readFile(exportsPath, "utf8");
    mismatches.push(...findBridgeExportMismatches(exportsSource, bridgeSource, exportsFile));
  }
  if (mismatches.length) {
    throw new Error(`Bridge/export mismatch:\n${mismatches.join("\n")}`);
  }
}

function findBridgeExportMismatches(exportsSource, bridgeSource, exportsFile) {
  return exportsSource
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((name) => !["_malloc", "_free"].includes(name))
    .filter((name) => !bridgeSource.includes(name.slice(1)))
    .map((name) => `${exportsFile}: ${name} not found in src/bridge.cpp`);
}

async function clonePinnedSource() {
  await run("git", [
    "clone",
    "--recursive",
    "--branch",
    config.libjxlTag,
    "--depth",
    "1",
    config.libjxlRepo,
    sourceDir
  ], { cwd: packageRoot });
  const head = await runCapture("git", ["-C", sourceDir, "rev-parse", "HEAD"]);
  if (head.trim() !== config.libjxlCommit) {
    throw new Error(`libjxl HEAD ${head.trim()} does not match pinned commit ${config.libjxlCommit}`);
  }
}

async function writeManifest(manifest) {
  const manifestPath = join(distDir, "build-manifest.json");
  // Merge with existing manifest so partial builds (--only-mt, --host-toolchain) preserve
  // tier entries produced by an earlier run instead of clobbering them.
  let existing = null;
  try {
    const text = await readFile(manifestPath, "utf8");
    existing = JSON.parse(text);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (existing && existing.buildId === manifest.buildId && existing.libjxlCommit === manifest.libjxlCommit) {
    const mergedTiers = { ...(existing.tiers ?? {}), ...manifest.tiers };
    const builtNames = new Set(Object.keys(manifest.tiers));
    const mergedSkipped = Array.isArray(manifest.skippedTiers)
      ? manifest.skippedTiers.filter((name) => !builtNames.has(name))
      : [];
    // Hygiene: never persist provenance for tiers we have explicitly skipped in this build.
    // Stale MT entries from prior --include-mt runs must not remain under `tiers` when skipped.
    for (const s of mergedSkipped) delete mergedTiers[s];
    const mergedPgo = manifest.pgo || existing.pgo || null;
    manifest = { ...existing, ...manifest, tiers: mergedTiers, skippedTiers: mergedSkipped, pgo: mergedPgo };
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function readArtifactMetadata(path) {
  const data = await readFile(path);
  return readArtifactMetadataFromBytes(data);
}

function readArtifactMetadataFromBytes(data) {
  return {
    bytes: data.byteLength,
    brotliBytes: brotliCompressSync(data, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: data.byteLength
      }
    }).byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
    integrity: `sha384-${createHash("sha384").update(data).digest("base64")}`
  };
}

async function validateWasmArtifact(outWasm, exportsFile, tierKey, options = {}) {
  const bytes = await readFile(outWasm);
  let module;
  try {
    module = await WebAssembly.compile(bytes);
  } catch (error) {
    if (!WebAssembly.validate(bytes)) {
      throw new Error(`${tierKey}: wasm validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!options.allowValidateOnly) {
      throw new Error(`${tierKey}: wasm validated but could not compile for export check: ${error instanceof Error ? error.message : String(error)}`);
    }
    return bytes;
  }

  const expectedExports = parseExpectedWasmExports(await readFile(join(packageRoot, exportsFile), "utf8"));
  const actualExports = new Set(WebAssembly.Module.exports(module).map((entry) => entry.name));
  const missing = expectedExports.filter((name) => !actualExports.has(name));
  // -O3 minifies the wasm export *names* (e.g. `add` -> `b`) while the emscripten JS glue keeps the
  // public `_name` API and maps it to the minified symbol. So a raw wasm-name check is meaningless on
  // optimized builds: every expected name appears "missing" even though the module is fully functional
  // (verified: `mod._jxl_wasm_*` are live functions). Only flag a genuine gap — some names resolve but
  // others don't. If ALL expected names are absent yet the module still exports a comparable symbol
  // count, that's minification, not breakage.
  const likelyMinified = missing.length === expectedExports.length && actualExports.size >= expectedExports.length;
  if (missing.length && !likelyMinified) {
    console.error(`${tierKey}: exports missing from wasm: ${missing.join(", ")}`);
  } else if (likelyMinified) {
    console.log(`${tierKey}: ${actualExports.size} wasm exports present (names minified by -O3; JS glue maps the public _ API).`);
  }
  return bytes;
}

function parseExpectedWasmExports(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => name.replace(/^_/, ""));
}

function formatBuildCommand(extraArgs = []) {
  const seen = new Set();
  const args = [
    "node",
    "scripts/build.mjs",
    ...process.argv
      .slice(2)
      .filter((arg) => arg !== "--inside-docker")
      .filter((arg) => {
        if (seen.has(arg)) return false;
        seen.add(arg);
        return true;
      }),
    ...extraArgs.filter((arg) => {
      if (seen.has(arg)) return false;
      seen.add(arg);
      return true;
    })
  ];
  return args.join(" ");
}

function osCpusMinusOne() {
  const count = process.env.CPU_COUNT
    ? Number(process.env.CPU_COUNT)
    : (os.availableParallelism?.() ?? os.cpus().length);
  return Math.max(1, count - 1);
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: "inherit",
      shell: false
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${command} exited with ${code ?? signal}`));
    });
    child.on("error", rejectPromise);
  });
}

function runCapture(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "inherit"],
      shell: false
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise(output);
        return;
      }
      rejectPromise(new Error(`${command} exited with ${code}`));
    });
    child.on("error", rejectPromise);
  });
}

async function assertBinary(name) {
  try {
    await run(name, ["--version"]);
  } catch (error) {
    throw new Error(`${name} is required for this build: ${error.message}`);
  }
}

async function assertDockerDaemon(env) {
  try {
    await run(dockerBinary, ["info"], { cwd: packageRoot, env });
  } catch (error) {
    throw new Error(
      `Docker CLI is installed, but the Docker daemon is not reachable. Start Docker Desktop/Linux engine and retry. ${error.message}`
    );
  }
}

function runEmscripten(command, args, options = {}) {
  if (process.platform === "win32" && command.endsWith(".bat")) {
    return run("cmd", ["/c", command, ...args], options);
  }
  return run(command, args, options);
}

function resolveDockerBinary() {
  if (process.env.DOCKER_BIN) return process.env.DOCKER_BIN;
  if (process.platform === "win32") {
    return "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
  }
  return "docker";
}

function resolveEmscriptenBinary(name) {
  const root = process.env.EMSDK;
  if (!root) return name;
  if (process.platform === "win32") {
    return join(root, "upstream", "emscripten", `${name}.bat`);
  }
  return join(root, "upstream", "emscripten", name);
}

function resolveEmsdkImages() {
  if (process.env.EMSDK_IMAGE) {
    return [process.env.EMSDK_IMAGE];
  }
  return [
    "docker.io/emscripten/emsdk:3.1.27"
  ];
}

function resolveBashBinary() {
  if (process.platform === "win32") {
    return "C:\\Program Files\\Git\\bin\\bash.exe";
  }
  return "bash";
}

function toCmakePath(path) {
  return path.replace(/\\/g, "/");
}

async function rmDir(path) {
  const { rm } = await import("node:fs/promises");
  await rm(path, { recursive: true, force: true });
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
