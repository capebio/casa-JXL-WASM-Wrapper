import json, os, statistics as st

ROOT = r"C:/Foo/raw-converter-wasm"
d = json.load(open(os.path.join(ROOT, "benchmark", "raw-format-sweep-results.json")))
rows = d["rows"]
files = d["files"]

def find(fname, tier):
    for r in rows:
        if r["file"] == fname and r["tier"] == tier and r.get("mode") == "std" \
           and not r.get("chunked") and not r.get("modular"):
            return r
    return None

def mean(xs):
    xs = [x for x in xs if x is not None]
    return round(st.mean(xs), 1) if xs else 0

cols = ["file", "raw_ms", "raw_decompress_ms", "raw_demosaic_ms", "raw_tonemap_ms",
        "shot_enc_simd_ms", "shot_enc_mt_ms", "shot_dec_simd_ms", "shot_dec_mt_ms"]
recs = []
for f in files:
    s = find(f, "simd"); m = find(f, "simd-mt")
    if not s:
        continue
    recs.append({
        "file": f,
        "raw_ms": round(s["rawMs"]),
        "raw_decompress_ms": round(s.get("decompressMs") or 0),
        "raw_demosaic_ms": round(s.get("demosaicMs") or 0),
        "raw_tonemap_ms": round(s.get("tonemapMs") or 0),
        "shot_enc_simd_ms": round(s.get("encodeMs") or 0),
        "shot_enc_mt_ms": round((m or {}).get("encodeMs") or 0),
        "shot_dec_simd_ms": round(s.get("decodeMs") or 0),
        "shot_dec_mt_ms": round((m or {}).get("decodeMs") or 0),
    })

L = []
L.append("TestName: StandardMultifileTest - ancestor-sweep")
L.append("RunTimestamp: 2026-05-28T00:00:00.000Z")
L.append("Agent: raw-format-sweep (spliced 2026-07-08)")
L.append("Tier: simd+simd-mt")
L.append("Source: multi-format")
L.append("Target: sweep")
L.append("Quality: sweep")
L.append("Efforts: sweep")
L.append("TimeBase: timeBase")
L.append("")
L.append("# Provenance / caveat")
L.append("# Converted from benchmark/raw-format-sweep-results.json (2026-05-28) - the earliest saved")
L.append("# multifile timing result (36-file ORF/CR2/DNG corpus, encode-option sweep, roiSize=512).")
L.append("# RAW-decode metrics (raw/decompress/demosaic/tonemap) are config-independent => directly")
L.append("# comparable to later StandardMultifileTest runs. shot_enc/shot_dec are the std one-shot")
L.append("# rows at the sweep's heavier settings (NOT q85/e3) => indicative only, not apples-to-apples")
L.append("# with post-2026-06-09 encode/decode numbers.")
L.append("")
L.append("---")
L.append("runs[%d]{%s}:" % (len(recs), "|".join(cols)))
for r in recs:
    L.append("  " + " | ".join(str(r[c]) for c in cols))
L.append("")
L.append("# Aggregates")
L.append("TotalRecords: %d" % len(recs))
L.append("")
L.append("# Averages (RAW-decode = comparable; shot enc/dec = sweep-config, indicative)")
L.append("AvgRawMs: %d" % round(mean([r["raw_ms"] for r in recs])))
L.append("AvgRawDecompressMs: %d | AvgRawDemosaicMs: %d | AvgRawTonemapMs: %d" % (
    round(mean([r["raw_decompress_ms"] for r in recs])),
    round(mean([r["raw_demosaic_ms"] for r in recs])),
    round(mean([r["raw_tonemap_ms"] for r in recs]))))
L.append("AvgShotEncSimdMs: %d | AvgShotEncMtMs: %d" % (
    round(mean([r["shot_enc_simd_ms"] for r in recs])), round(mean([r["shot_enc_mt_ms"] for r in recs]))))
L.append("AvgShotDecSimdMs: %d | AvgShotDecMtMs: %d" % (
    round(mean([r["shot_dec_simd_ms"] for r in recs])), round(mean([r["shot_dec_mt_ms"] for r in recs]))))
L.append("")

out = os.path.join(ROOT, "docs", "outputs", "timing tests",
                   "2026-05-28T00-00-00-000Z-StandardMultifileTest-ancestor-sweep.toon")
open(out, "w", encoding="utf-8").write("\n".join(L))
print("wrote", out)
print("files in table:", len(recs))
print("\n".join(L[-8:]))
