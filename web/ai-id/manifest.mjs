// Folder manifest builder — indexes every casava-ai sidecar for batch ingest.
export const MANIFEST_SCHEMA = "casava-ai-manifest/1";

/** entries: [{ name, sidecar, sha256, hasGeo, width, height }] → manifest object. */
export function buildManifest(entries) {
  return {
    schema: MANIFEST_SCHEMA,
    count: entries.length,
    items: entries.map((e) => ({
      name: e.name, sidecar: e.sidecar, sha256: e.sha256,
      has_geo: !!e.hasGeo, width: e.width, height: e.height,
    })),
  };
}
