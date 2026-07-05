const FAMILY_LABEL_OVERRIDES = new Map([
  ["standard-multifile", "Standard Multifile"],
  ["codec-compare", "Codec Compare"],
  ["codec-paper", "Codec Paper"],
  ["multifileab-previewfirst", "Multifile A/B (previewFirst)"],
  ["policy-ab", "Policy A/B"],
  ["policy-matrix", "Policy Matrix"],
  ["effort-sweep-benchmark", "Effort Sweep"],
  ["effort-sweep", "Effort Sweep"],
  ["p3-features-benchmark", "P3 Features"],
  ["p3-features", "P3 Features"],
  ["progressive-byte-benchmark", "Progressive Byte"],
  ["progressive-byte", "Progressive Byte"],
  ["progressive-flag-matrix", "Progressive Flag Matrix"],
  ["progressive-timing", "Progressive Timing"],
  ["session-worker-timings", "Session Worker Timings"],
  ["streaming-ssim-benchmark", "Streaming SSIM"],
  ["streaming-ssim", "Streaming SSIM"],
  ["targeted-wasm-timings", "Targeted WASM Timings"],
  ["raw-format-sweep", "Raw Format Sweep"],
  ["single-progressive", "Single Progressive"],
  ["timing-tests", "Timing Tests"],
]);

const FAMILY_COLOR_OVERRIDES = new Map([
  ["standard-multifile", "#7dd3fc"],
  ["codec-compare", "#e879f9"],
  ["codec-paper", "#14b8a6"],
  ["multifileab-previewfirst", "#fbbf24"],
  ["policy-ab", "#f59e0b"],
  ["policy-matrix", "#f97316"],
  ["effort-sweep", "#34d399"],
  ["p3-features", "#a78bfa"],
  ["progressive-byte", "#60a5fa"],
  ["progressive-flag-matrix", "#fb7185"],
  ["progressive-timing", "#f472b6"],
  ["session-worker-timings", "#22c55e"],
  ["streaming-ssim", "#38bdf8"],
  ["targeted-wasm-timings", "#f59e0b"],
  ["raw-format-sweep", "#f43f5e"],
  ["single-progressive", "#c084fc"],
  ["timing-tests", "#94a3b8"],
]);

const FAMILY_COLOR_PALETTE = [
  "#7dd3fc",
  "#60a5fa",
  "#34d399",
  "#f59e0b",
  "#f472b6",
  "#a78bfa",
  "#fb7185",
  "#38bdf8",
  "#22c55e",
  "#f97316",
  "#c084fc",
  "#94a3b8",
];

export function normalizeFamilyId(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return "unknown";
  return raw
    .replace(/\.toon$/i, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export function deriveFamilyIdFromArtifactName(fileName, testName = "") {
  const stem = String(fileName ?? "").replace(/\.toon$/i, "");
  const name = String(testName ?? "");
  const candidates = [
    stem,
    name,
    stem.replace(/^\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}-\d{3}z-/i, ""),
    stem.replace(/^\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}-\d{3}z/i, ""),
  ].map(normalizeFamilyId);

  if (candidates.some((value) => value.includes("codecpaper"))) return "codec-paper";
  if (candidates.some((value) => value.includes("codeccompare"))) return "codec-compare";
  if (candidates.some((value) => value.includes("multifileab-previewfirst"))) return "multifileab-previewfirst";
  if (candidates.some((value) => value.includes("standardmultifiletest"))) return "standard-multifile";
  if (candidates.some((value) => value.includes("policy-ab"))) return "policy-ab";
  if (candidates.some((value) => value.includes("policy-matrix"))) return "policy-matrix";
  if (candidates.some((value) => value.includes("effort-sweep"))) return "effort-sweep";
  if (candidates.some((value) => value.includes("p3-features"))) return "p3-features";
  if (candidates.some((value) => value.includes("progressive-byte"))) return "progressive-byte";
  if (candidates.some((value) => value.includes("progressive-flag-matrix"))) return "progressive-flag-matrix";
  if (candidates.some((value) => value.includes("progressive-timing"))) return "progressive-timing";
  if (candidates.some((value) => value.includes("session-worker-timings"))) return "session-worker-timings";
  if (candidates.some((value) => value.includes("streaming-ssim"))) return "streaming-ssim";
  if (candidates.some((value) => value.includes("targeted-wasm-timings"))) return "targeted-wasm-timings";
  if (candidates.some((value) => value.includes("raw-format-sweep"))) return "raw-format-sweep";
  if (candidates.some((value) => value.includes("single-progressive"))) return "single-progressive";
  if (candidates.some((value) => value.includes("timing-tests"))) return "timing-tests";

  const fallback = candidates.find((value) => value && value !== "unknown");
  return fallback || "unknown";
}

export function familyLabelFromId(familyId) {
  const normalized = normalizeFamilyId(familyId);
  if (FAMILY_LABEL_OVERRIDES.has(normalized)) return FAMILY_LABEL_OVERRIDES.get(normalized);
  return normalized
    .split("-")
    .filter(Boolean)
    .map((part) => part === "jxtc" ? "JXTC" : part.toUpperCase() === part ? part : part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

export function familyColorFromId(familyId) {
  const normalized = normalizeFamilyId(familyId);
  if (FAMILY_COLOR_OVERRIDES.has(normalized)) return FAMILY_COLOR_OVERRIDES.get(normalized);
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 33 + normalized.charCodeAt(i)) >>> 0;
  }
  return FAMILY_COLOR_PALETTE[hash % FAMILY_COLOR_PALETTE.length];
}

export function familyPrimaryMetricKey(familyId) {
  return `${normalizeFamilyId(familyId)}.primaryMs`;
}

export function buildFamilyMetricDefinition(familyId, { key = null, label = null, color = null, defaultOn = false } = {}) {
  const normalized = normalizeFamilyId(familyId);
  return {
    key: key || familyPrimaryMetricKey(normalized),
    label: label || familyLabelFromId(normalized),
    group: normalized,
    defaultOn,
    color: color || familyColorFromId(normalized),
    isFamilyOverlay: normalized !== "standard-multifile",
  };
}

export function isFamilyOverlayMetric(metric) {
  return Boolean(metric?.isFamilyOverlay);
}
