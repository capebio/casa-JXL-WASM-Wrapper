// packages/jxl-progressive/src/progressive-manifest.ts

export type TierName = "dc" | "preview" | "full";

// --- Phase 8 type imports (schema re-exports for FrameSet + capture geometry) ---
// Data model defined in types.ts per handoff spec; re-exported here so progressive-manifest remains the schema surface.
import type {
  CameraPose,
  Relation,
  FrameSetMember,
  FrameSet,
  AssetChannel,
  ChannelDescriptor,
} from "./types.js";

export type { CameraPose, Relation, FrameSetMember, FrameSet, AssetChannel, ChannelDescriptor };

export type ScoreMetric = "ssim" | "psnr" | "butteraugli";

export interface TierScore {
  metric: ScoreMetric;
  /** Metric value of this tier's partial reconstruction vs the reference. */
  value: number;
  /** What the score compares against: the file's own final frame, or the encoder source. */
  reference: "final" | "source";
}

export interface ManifestTier {
  name: TierName;
  byteStart: number;
  byteEnd: number;
  progressionIndex: number | "final";
  intendedUse: string;
  /** Optional measured perceptual score for this tier (Phase A). */
  score?: TierScore;
}

/**
 * K2: build progressive tiers directly from encoder-derived byte offsets — the
 * exact progressive-pass boundaries of a SINGLE codestream (raw-pipeline's
 * `progressive_tier_offsets` / `VariantSet.full_offsets`), instead of the old
 * 4 KiB-granular re-decode profiler. `offsets` is strictly ascending with
 * `offsets.at(-1) === jxlByteLength`. Always emits `dc` (offsets[0]) and `full`
 * (the last offset); emits `preview` only when a distinct pass boundary at or below
 * ~70% of the file exists strictly between them. Tiers are cumulative from byte 0
 * (consumers `Range`-fetch `bytes=0-{byteEnd-1}`), so `byteStart` is always 0.
 */
export function buildTiersFromOffsets(offsets: readonly number[]): ManifestTier[] {
  if (offsets.length < 2) {
    throw new Error(`progressive offsets need >=2 entries (dc + full), got ${offsets.length}`);
  }
  for (let i = 1; i < offsets.length; i++) {
    if (offsets[i]! <= offsets[i - 1]!) {
      throw new Error(`progressive offsets must be strictly ascending: ${JSON.stringify(offsets)}`);
    }
  }
  const full = offsets[offsets.length - 1]!;
  const dcEnd = offsets[0]!;
  const tiers: ManifestTier[] = [
    { name: "dc", byteStart: 0, byteEnd: dcEnd, progressionIndex: 0, intendedUse: "thumbnail" },
  ];
  // preview = the last pass boundary at or below 70% of the file, strictly between
  // dc and full (mirrors the re-decode profiler's preview selection).
  const threshold = full * 0.7;
  let previewIdx = -1;
  for (let i = 1; i < offsets.length - 1; i++) {
    if (offsets[i]! <= threshold) previewIdx = i;
  }
  if (previewIdx > 0 && offsets[previewIdx]! > dcEnd && offsets[previewIdx]! < full) {
    tiers.push({
      name: "preview",
      byteStart: 0,
      byteEnd: offsets[previewIdx]!,
      progressionIndex: previewIdx,
      intendedUse: "visible-card",
    });
  }
  tiers.push({
    name: "full",
    byteStart: 0,
    byteEnd: full,
    progressionIndex: "final",
    intendedUse: "zoom-export",
  });
  return tiers;
}

export interface ScaleFrontierEntry {
  /** Longest-edge display pixels this entry covers (inclusive upper bound). */
  maxDisplayPx: number;
  tier: TierName;
  /** Denormalized from tiers[tier].byteEnd so a consumer can Range-fetch directly. */
  byteEnd: number;
  score: TierScore;
}

export interface ProgressiveManifest {
  version: 1;
  source: {
    width: number;
    height: number;
    hasAlpha: boolean;
    orientation: number;
  };
  jxl: {
    bytes: number;
    sha256: string;
  };
  encoder: {
    name: string;
    libjxlVersion: string;
    flags: string[];
  };
  saliency?: {
    enabled: boolean;
    centerX: number; // normalised 0–1
    centerY: number; // normalised 0–1
    confidence: number;
    method: string;
  };
  /** Optional passthrough for future perceptual / non-Riemannian color engine params
   *  (e.g. from advanced LookRenderer / LUT / geodesic). Transported via manifest to
   *  onManifest consumers for illumination-invariant adjustments etc. No cost here.
   */
  perceptual?: Record<string, unknown>;
  tiers: ManifestTier[];
  /** Optional display-scale → earliest-sufficient-tier frontier (Phase B). */
  scaleFrontier?: ScaleFrontierEntry[];

  // Phase 8: reserved ingest CV fields + channel semantics (PG2/PG4/PG5/ST8).
  // Populated for photogrammetry/transect assets; FrameSet groups multiple such manifests.
  // These are optional and forward-compat; validateManifest passes through unknown optionals.
  capture?: {
    pose?: CameraPose;
    intrinsics?: FrameSetMember["intrinsics"];
    extrinsics?: FrameSetMember["extrinsics"];
    depthLayer?: FrameSetMember["depthLayer"];
    featureSidecar?: FrameSetMember["featureSidecar"];
  };
  /** Concurrent loadable channels alongside rgb (PG4). */
  channels?: AssetChannel[];
  channelDescriptors?: ChannelDescriptor[];
}

export class ManifestValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

export class ManifestStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestStaleError";
  }
}

function assertField(
  condition: boolean,
  field: string,
  message: string,
): asserts condition {
  if (!condition) throw new ManifestValidationError(message, field);
}

const VALID_TIER_NAMES = new Set<string>(["dc", "preview", "full"]);
const VALID_SCORE_METRICS = new Set<string>(["ssim", "psnr", "butteraugli"]);

export function validateManifest(json: unknown): ProgressiveManifest {
  assertField(
    typeof json === "object" && json !== null,
    "root",
    "Manifest must be an object",
  );
  const obj = json as Record<string, unknown>;

  assertField(obj["version"] === 1, "version", "Manifest version must be 1");

  // source
  assertField(
    typeof obj["source"] === "object" && obj["source"] !== null,
    "source",
    "source must be an object",
  );
  const src = obj["source"] as Record<string, unknown>;
  assertField(typeof src["width"] === "number", "source.width", "source.width must be a number");
  assertField((src["width"] as number) > 0, "source.width", "source.width must be > 0");
  assertField(typeof src["height"] === "number", "source.height", "source.height must be a number");
  assertField((src["height"] as number) > 0, "source.height", "source.height must be > 0");
  assertField(typeof src["hasAlpha"] === "boolean", "source.hasAlpha", "source.hasAlpha must be a boolean");
  assertField(typeof src["orientation"] === "number", "source.orientation", "source.orientation must be a number");

  // jxl
  assertField(
    typeof obj["jxl"] === "object" && obj["jxl"] !== null,
    "jxl",
    "jxl must be an object",
  );
  const jxl = obj["jxl"] as Record<string, unknown>;
  assertField(typeof jxl["bytes"] === "number", "jxl.bytes", "jxl.bytes must be a number");
  assertField(
    Number.isInteger(jxl["bytes"] as number) && (jxl["bytes"] as number) > 0,
    "jxl.bytes",
    "jxl.bytes must be a positive integer"
  );
  assertField(typeof jxl["sha256"] === "string", "jxl.sha256", "jxl.sha256 must be a string");

  // encoder
  assertField(
    typeof obj["encoder"] === "object" && obj["encoder"] !== null,
    "encoder",
    "encoder must be an object",
  );
  const enc = obj["encoder"] as Record<string, unknown>;
  assertField(typeof enc["name"] === "string", "encoder.name", "encoder.name must be a string");
  assertField((enc["name"] as string).length <= 256, "encoder.name", "encoder.name must be <= 256 chars");
  assertField(typeof enc["libjxlVersion"] === "string", "encoder.libjxlVersion", "encoder.libjxlVersion must be a string");
  assertField((enc["libjxlVersion"] as string).length <= 64, "encoder.libjxlVersion", "encoder.libjxlVersion must be <= 64 chars");
  assertField(Array.isArray(enc["flags"]), "encoder.flags", "encoder.flags must be an array");
  assertField((enc["flags"] as unknown[]).length <= 64, "encoder.flags", "encoder.flags must have <= 64 entries");
  for (let fi = 0; fi < (enc["flags"] as unknown[]).length; fi++) {
    assertField(typeof (enc["flags"] as unknown[])[fi] === "string", `encoder.flags[${fi}]`, `encoder.flags[${fi}] must be a string`);
  }

  // saliency (optional; tighten ranges when present so scheduler boosts are safe)
  if (obj["saliency"] !== undefined) {
    assertField(
      typeof obj["saliency"] === "object" && obj["saliency"] !== null,
      "saliency",
      "saliency must be an object if present"
    );
    const s = obj["saliency"] as Record<string, unknown>;
    assertField(typeof s["enabled"] === "boolean", "saliency.enabled", "saliency.enabled must be a boolean");
    assertField(
      typeof s["centerX"] === "number" && (s["centerX"] as number) >= 0 && (s["centerX"] as number) <= 1,
      "saliency.centerX",
      "saliency.centerX must be number in [0,1]"
    );
    assertField(
      typeof s["centerY"] === "number" && (s["centerY"] as number) >= 0 && (s["centerY"] as number) <= 1,
      "saliency.centerY",
      "saliency.centerY must be number in [0,1]"
    );
    assertField(
      typeof s["confidence"] === "number" && (s["confidence"] as number) >= 0 && (s["confidence"] as number) <= 1,
      "saliency.confidence",
      "saliency.confidence must be number in [0,1]"
    );
    assertField(typeof s["method"] === "string", "saliency.method", "saliency.method must be a string");
  }

  // perceptual passthrough (optional, loose for future color science transport)
  if (obj["perceptual"] !== undefined) {
    assertField(
      typeof obj["perceptual"] === "object" && obj["perceptual"] !== null && !Array.isArray(obj["perceptual"]),
      "perceptual",
      "perceptual must be an object if present"
    );
    assertField(
      Object.keys(obj["perceptual"] as object).length <= 32,
      "perceptual",
      "perceptual must have <= 32 keys"
    );
  }

  // tiers
  assertField(Array.isArray(obj["tiers"]), "tiers", "tiers must be an array");
  const tiersArr = obj["tiers"] as unknown[];
  assertField(tiersArr.length > 0, "tiers", "tiers must not be empty");

  for (let i = 0; i < tiersArr.length; i++) {
    const t = tiersArr[i] as Record<string, unknown>;
    const f = `tiers[${i}]`;
    assertField(typeof t === "object" && t !== null, f, `${f} must be an object`);
    assertField(VALID_TIER_NAMES.has(t["name"] as string), `${f}.name`, `${f}.name must be dc|preview|full`);
    assertField(typeof t["byteStart"] === "number", `${f}.byteStart`, `${f}.byteStart must be a number`);
    assertField(
      Number.isFinite(t["byteStart"] as number) && (t["byteStart"] as number) >= 0,
      `${f}.byteStart`,
      `${f}.byteStart must be a finite non-negative number`
    );
    assertField(typeof t["byteEnd"] === "number", `${f}.byteEnd`, `${f}.byteEnd must be a number`);
    assertField(
      Number.isFinite(t["byteEnd"] as number) && (t["byteEnd"] as number) > 0,
      `${f}.byteEnd`,
      `${f}.byteEnd must be a finite positive number`
    );
    assertField(
      (t["byteEnd"] as number) > (t["byteStart"] as number),
      `${f}.byteEnd`,
      `${f}.byteEnd must be greater than ${f}.byteStart`
    );
    assertField(
      (t["byteEnd"] as number) <= (jxl["bytes"] as number),
      `${f}.byteEnd`,
      `${f}.byteEnd (${t["byteEnd"]}) exceeds jxl.bytes (${jxl["bytes"]})`
    );
    assertField(
      typeof t["progressionIndex"] === "number" || t["progressionIndex"] === "final",
      `${f}.progressionIndex`,
      `${f}.progressionIndex must be number or "final"`,
    );
    assertField(typeof t["intendedUse"] === "string", `${f}.intendedUse`, `${f}.intendedUse must be a string`);

    if (t["score"] !== undefined) {
      assertField(typeof t["score"] === "object" && t["score"] !== null, `${f}.score`, `${f}.score must be an object if present`);
      const sc = t["score"] as Record<string, unknown>;
      assertField(VALID_SCORE_METRICS.has(sc["metric"] as string), `${f}.score.metric`, `${f}.score.metric must be ssim|psnr|butteraugli`);
      assertField(typeof sc["value"] === "number" && Number.isFinite(sc["value"] as number), `${f}.score.value`, `${f}.score.value must be a finite number`);
      assertField(sc["reference"] === "final" || sc["reference"] === "source", `${f}.score.reference`, `${f}.score.reference must be "final" or "source"`);
    }
  }

  // Cross-tier: each tier name must appear at most once.
  const seenNames = new Set<string>();
  for (let i = 0; i < tiersArr.length; i++) {
    const name = (tiersArr[i] as Record<string, unknown>)["name"] as string;
    assertField(!seenNames.has(name), `tiers[${i}].name`, `tier name "${name}" must appear at most once`);
    seenNames.add(name);
  }

  // Cross-tier: byteEnd must be strictly ascending across tiers (all tiers are cumulative
  // from byte 0; the consumer issues Range: bytes=0-{byteEnd-1} per tier).
  for (let i = 1; i < tiersArr.length; i++) {
    const prev = (tiersArr[i - 1] as Record<string, unknown>)["byteEnd"] as number;
    const curr = (tiersArr[i] as Record<string, unknown>)["byteEnd"] as number;
    assertField(
      curr > prev,
      `tiers[${i}].byteEnd`,
      `tiers[${i}].byteEnd (${curr}) must be greater than tiers[${i - 1}].byteEnd (${prev})`
    );
  }

  if (obj["scaleFrontier"] !== undefined) {
    assertField(Array.isArray(obj["scaleFrontier"]), "scaleFrontier", "scaleFrontier must be an array if present");
    const fr = obj["scaleFrontier"] as unknown[];
    assertField(fr.length <= 16, "scaleFrontier", "scaleFrontier must have <= 16 entries");
    for (let i = 0; i < fr.length; i++) {
      const e = fr[i] as Record<string, unknown>;
      const f = `scaleFrontier[${i}]`;
      assertField(typeof e === "object" && e !== null, f, `${f} must be an object`);
      assertField(typeof e["maxDisplayPx"] === "number" && (e["maxDisplayPx"] as number) > 0, `${f}.maxDisplayPx`, `${f}.maxDisplayPx must be a positive number`);
      assertField(VALID_TIER_NAMES.has(e["tier"] as string), `${f}.tier`, `${f}.tier must be dc|preview|full`);
      assertField(
        typeof e["byteEnd"] === "number" && (e["byteEnd"] as number) > 0 && (e["byteEnd"] as number) <= (jxl["bytes"] as number),
        `${f}.byteEnd`, `${f}.byteEnd must be in (0, jxl.bytes]`
      );
      if (i > 0) {
        assertField(
          (e["maxDisplayPx"] as number) > ((fr[i - 1] as Record<string, unknown>)["maxDisplayPx"] as number),
          `${f}.maxDisplayPx`, `${f}.maxDisplayPx must be strictly ascending`
        );
      }
    }
  }

  return json as ProgressiveManifest;
}

export function lookupTier(
  manifest: ProgressiveManifest,
  name: TierName,
): ManifestTier | undefined {
  return manifest.tiers.find((t) => t.name === name);
}

export async function checkHash(
  manifest: ProgressiveManifest,
  jxlBytes: ArrayBuffer,
): Promise<boolean> {
  let hashHex: string;

  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.subtle?.digest === "function"
  ) {
    const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", jxlBytes);
    const hashBytes = new Uint8Array(hashBuf);
    let hex = "";
    for (let i = 0; i < hashBytes.length; i++) {
      hex += hashBytes[i]!.toString(16).padStart(2, "0");
    }
    hashHex = hex;
  } else {
    // Node.js fallback (crypto.subtle not available or not cross-origin-isolated)
    const { createHash } = await import("node:crypto");
    hashHex = createHash("sha256")
      .update(Buffer.from(jxlBytes))
      .digest("hex");
  }

  return hashHex === manifest.jxl.sha256;
}

export function migrateManifest(json: unknown): ProgressiveManifest {
  if (typeof json === "object" && json !== null) {
    const v = (json as Record<string, unknown>)["version"];
    if (typeof v === "number" && v > 1) {
      throw new ManifestValidationError(
        `Cannot migrate manifest version ${v} (only version 1 supported)`,
        "version",
      );
    }
  }
  return validateManifest(json);
}
