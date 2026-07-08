import json, glob, re, os, statistics as st
from datetime import datetime

ROOT = r"C:/Foo/raw-converter-wasm"
TDIR = os.path.join(ROOT, "docs", "outputs", "timing tests")
files = sorted(glob.glob(os.path.join(TDIR, "*StandardMultifileTest-general.toon")))

def num(pat, text):
    m = re.search(pat, text)
    return float(m.group(1)) if m else None

points = []
for f in files:
    txt = open(f, encoding="utf-8", errors="ignore").read()
    base = os.path.basename(f)
    ts = base[:24]  # 2026-07-08T13-00-27-305Z
    try:
        dt = datetime.strptime(ts, "%Y-%m-%dT%H-%M-%S-%fZ")
    except Exception:
        dt = None
    points.append({
        "date": ts,
        "epoch": dt.timestamp() if dt else None,
        "raw": num(r"AvgRawMs:\s*([\d.]+)", txt),
        "decompress": num(r"AvgRawDecompressMs:\s*([\d.]+)", txt),
        "demosaic": num(r"AvgRawDemosaicMs:\s*([\d.]+)", txt),
        "tonemap": num(r"AvgRawTonemapMs:\s*([\d.]+)", txt),
        "progFinalSimd": num(r"AvgProgFinalSimdMs:\s*([\d.]+)", txt),
        "progFirstSimd": num(r"AvgProgFirstSimdMs:\s*([\d.]+)", txt),
        "shotDecSimd": num(r"AvgShotDecSimdMs:\s*([\d.]+)", txt),
        "shotEncSimd": num(r"AvgShotEncSimdMs:\s*([\d.]+)", txt),
        "shotDecMt": num(r"AvgShotDecMtMs:\s*([\d.]+)", txt),
        "mtSpeedup": num(r"MultiWorkerSpeedupRatio:\s*([\d.]+)", txt),
    })

# 2026-05-28 ancestor aggregate (raw-format-sweep)
d = json.load(open(os.path.join(ROOT, "benchmark", "raw-format-sweep-results.json")))
rows = d["rows"]
def agg(tier, field, std_only=False):
    xs = [r[field] for r in rows if r["tier"] == tier and field in r
          and (not std_only or (r.get("mode") == "std" and not r.get("chunked") and not r.get("modular")))]
    return round(st.mean(xs), 1) if xs else None

dt0 = datetime(2026, 5, 28, 0, 0, 0)
anc = {
    "date": "2026-05-28T00-00-00-000Z", "epoch": dt0.timestamp(), "ancestor": True,
    "raw": agg("simd", "rawMs"), "rawMt": agg("simd-mt", "rawMs"),
    "decompress": agg("simd", "decompressMs"), "demosaic": agg("simd", "demosaicMs"),
    "tonemap": agg("simd", "tonemapMs"),
    "shotEncSimd": agg("simd", "encodeMs", True), "shotDecSimd": agg("simd", "decodeMs", True),
    "shotEncMt": agg("simd-mt", "encodeMs", True), "shotDecMt": agg("simd-mt", "decodeMs", True),
}

out = os.path.join(ROOT, "benchmark", "timeline-extract.json")
json.dump({"ancestor": anc, "runs": points}, open(out, "w"), indent=1)
print("runs:", len(points), "| first:", points[0]["date"][:10], "| last:", points[-1]["date"][:10])
print("ancestor:", json.dumps(anc))
print("raw span: 05-28 simd=%s -> 06-09=%s -> last=%s" % (anc["raw"], points[0]["raw"], points[-1]["raw"]))
for lib in ("matplotlib", "numpy", "scipy"):
    try:
        m = __import__(lib); print("HAVE", lib, getattr(m, "__version__", "?"))
    except Exception as e:
        print("MISSING", lib)
