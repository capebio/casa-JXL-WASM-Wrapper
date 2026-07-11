// Batch CLI: scan a folder of RAWs, write a lean casava-ai/1 sidecar per image + a
// folder manifest.json. No proxy is generated or stored (proxies are on-demand).
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, decodeRaw, SUPPORTED_RAW } from "./decode.mjs";
import { buildSidecar } from "./sidecar.mjs";
import { buildManifest } from "./manifest.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Decode one RAW → lean sidecar object (no proxy generated/stored). */
async function sidecarForFile(path) {
  const bytes = readFileSync(path);
  const { result, width, height } = await decodeRaw(path);
  return buildSidecar({
    filename: basename(path), sha256: sha256(bytes), bytes: bytes.length,
    format: extname(path).toLowerCase().slice(1),
    width, height, orientationApplied: true,
    datetimeExif: result.datetime,
    decoded: result,
  });
}

export async function exportFolder(dir, { outDir } = {}) {
  await initWasm();
  const dest = outDir ?? dir;
  const files = readdirSync(dir).filter((f) => SUPPORTED_RAW.has(extname(f).toLowerCase()) && statSync(join(dir, f)).isFile());
  const sidecars = [];
  const entries = [];
  for (const f of files) {
    const sc = await sidecarForFile(join(dir, f));
    const sidecarName = f.replace(/\.[^.]+$/, "") + ".ai.json";
    writeFileSync(join(dest, sidecarName), JSON.stringify(sc, null, 2));
    sidecars.push(sidecarName);
    entries.push({ name: f, sidecar: sidecarName, sha256: sc.source.sha256, hasGeo: sc.geo != null, width: sc.image.width, height: sc.image.height });
  }
  const manifestPath = join(dest, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(buildManifest(entries), null, 2));
  return { sidecars, manifestPath };
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, outDir] = process.argv.slice(2);
  if (!dir) { console.error("usage: node web/ai-id/export.mjs <dir> [outDir]"); process.exit(1); }
  exportFolder(dir, { outDir }).then((r) => console.log(`wrote ${r.sidecars.length} sidecars + ${r.manifestPath}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
