// Regenerate GraphAggregateResults.html from the full .toon history (now incl. the
// 2026-05-28 ancestor splice) without running the full benchmark. Mirrors the graph
// step of StandardMultifileTest.mjs.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { buildGraphAggregateHtml, buildGraphHistory } from "./standard-multifile-history-graph.mjs";
import { consolidateBenchmarkHistory } from "./benchmark-history-conversion.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const OUT_DIR = join(repoRoot, "docs", "outputs", "timing tests");

const consolidation = consolidateBenchmarkHistory({
  timingDir: OUT_DIR,
  legacyRoots: [join(repoRoot, "docs", "Benchmark results"), join(OUT_DIR, "backup")],
  backupDirName: "backup",
});
const historicalRuns = consolidation.toonFiles
  .filter((name) => name.endsWith(".toon"))
  .filter((name) => !name.endsWith("GraphAggregateResults.toon"));
const graphModel = buildGraphHistory(historicalRuns);
const graphHtml = buildGraphAggregateHtml(graphModel, { launchBadge: "regenerated w/ 2026-05-28 ancestor splice" });
writeFileSync(join(OUT_DIR, "GraphAggregateResults.html"), graphHtml);
console.log("regenerated GraphAggregateResults.html from", historicalRuns.length, "toon runs");
try {
  const dates = (graphModel.runs || graphModel.points || []).map((r) => r.date || r.timestamp || r.x).filter(Boolean).sort();
  if (dates.length) console.log("earliest:", dates[0], "| latest:", dates[dates.length - 1]);
} catch {}
