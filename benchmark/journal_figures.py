import json, os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from datetime import datetime

ROOT = r"C:/Foo/raw-converter-wasm"
OUT = os.path.join(ROOT, "docs", "outputs", "timing tests", "journal-figures")
os.makedirs(OUT, exist_ok=True)
data = json.load(open(os.path.join(ROOT, "benchmark", "timeline-extract.json")))
anc, runs = data["ancestor"], data["runs"]

# Okabe-Ito colourblind-safe palette
C = dict(blue="#0072B2", orange="#E69F00", green="#009E73", verm="#D55E00",
         purple="#CC79A7", sky="#56B4E9", grey="#7f7f7f", ink="#222222")

plt.rcParams.update({
    "figure.dpi": 120, "savefig.dpi": 300, "savefig.bbox": "tight",
    "font.family": "DejaVu Sans", "font.size": 10.5, "axes.titlesize": 12,
    "axes.titleweight": "bold", "axes.labelsize": 11,
    "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.alpha": 0.22, "grid.linewidth": 0.6,
    "axes.linewidth": 0.9, "xtick.direction": "out", "ytick.direction": "out",
    "legend.frameon": False, "legend.fontsize": 9.5,
})

def series(key, include_anc=False):
    xs, ys = [], []
    if include_anc and anc.get(key):
        xs.append(anc["epoch"]); ys.append(anc[key])
    for r in runs:
        if r.get(key) is not None and r.get("epoch"):
            xs.append(r["epoch"]); ys.append(r[key])
    return np.array(xs, float), np.array(ys, float)

def lowess(x, y, frac=0.28, logy=True, it=2):
    xv = np.asarray(x, float)
    yv = np.log(np.asarray(y, float)) if logy else np.asarray(y, float)
    n = len(xv)
    order = np.argsort(xv); xs, ys = xv[order], yv[order]
    r = max(int(np.ceil(frac * n)), 4)
    yst = np.zeros(n); wr = np.ones(n)
    for _ in range(it + 1):
        for i in range(n):
            d = np.abs(xs - xs[i]); h = np.sort(d)[min(r, n - 1)] or 1.0
            w = np.clip(d / h, 0, 1); w = (1 - w ** 3) ** 3 * wr
            W = w.sum()
            if W == 0:
                yst[i] = ys[i]; continue
            mx = (w * xs).sum() / W; my = (w * ys).sum() / W
            bxx = (w * (xs - mx) ** 2).sum()
            b = (w * (xs - mx) * (ys - my)).sum() / bxx if bxx > 0 else 0.0
            yst[i] = my + b * (xs[i] - mx)
        res = ys - yst; s = np.median(np.abs(res))
        if s == 0: break
        u = np.clip(res / (6 * s), -1, 1); wr = (1 - u ** 2) ** 2
    return xs, (np.exp(yst) if logy else yst)

def dt(ts): return datetime.fromtimestamp(ts)
def dts(arr): return [dt(t) for t in arr]

def style_dates(ax):
    ax.xaxis.set_major_locator(mdates.DayLocator(interval=7))
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
    ax.xaxis.set_minor_locator(mdates.DayLocator(interval=1))
    for t in ax.get_xticklabels(): t.set_rotation(0)

def save(fig, name):
    for ext in ("png", "svg", "pdf"):
        fig.savefig(os.path.join(OUT, f"{name}.{ext}"))
    plt.close(fig)

# ---- Figure 1: RAW decode latency, full span, headline ----------------------
fig, ax = plt.subplots(figsize=(7.2, 4.4))
x, y = series("raw", include_anc=False)
ax.scatter(dts(x), y, s=16, color=C["blue"], alpha=0.32, edgecolor="none",
           label="StandardMultifileTest run", zorder=2)
sx, sy = lowess(x, y, frac=0.25, logy=True)
ax.plot(dts(sx), sy, color=C["ink"], lw=2.4, zorder=4, label="LOWESS trend (log-latency)")
# ancestor point + dashed bridge (no data 05-29..06-08)
ax.scatter([dt(anc["epoch"])], [anc["raw"]], marker="*", s=320, color=C["verm"],
           edgecolor="white", linewidth=0.8, zorder=6, label="Ancestor sweep (2026-05-28)")
ax.plot([dt(anc["epoch"]), dt(sx[0])], [anc["raw"], sy[0]], ls=(0, (4, 3)),
        color=C["verm"], lw=1.4, alpha=0.7, zorder=3)
floor = float(np.min(sy))
ax.set_yscale("log")
ax.set_yticks([400, 600, 1000, 2000, 4000])
ax.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f"{v:.0f}"))
ax.yaxis.set_minor_formatter(matplotlib.ticker.NullFormatter())
ax.annotate(f"ancestor  {anc['raw']:.0f} ms", (dt(anc["epoch"]), anc["raw"]),
            xytext=(8, 10), textcoords="offset points", color=C["verm"], fontsize=9)
ax.annotate(f"optimised floor  ~{floor:.0f} ms\n({anc['raw']/floor:.1f}× faster)",
            (dts(sx)[-1], sy[-1]), xytext=(-4, -38), textcoords="offset points",
            ha="right", color=C["ink"], fontsize=9.5,
            bbox=dict(boxstyle="round,pad=0.3", fc="#f4f4f4", ec="none"))
ax.set_ylabel("RAW decode latency  (ms, mean of corpus)")
ax.set_title("RAW decode latency across the optimisation campaign")
ax.set_xlabel("2026")
style_dates(ax); ax.legend(loc="upper right", ncol=1)
ax.text(0.01, -0.16, "Config-independent metric (raw sensor → RGB); comparable across all runs. "
        "Scatter = individual runs (incl. thermal/power noise); curve = robust local regression on log-latency.",
        transform=ax.transAxes, fontsize=7.6, color=C["grey"], va="top")
save(fig, "fig1_rawdecode_trajectory")

# ---- Figure 2: RAW-decode stage decomposition (ancestor vs floor) -----------
# floor = median of last 12 runs that carry sub-timers
def floor_avg(key):
    vals = [r[key] for r in runs if r.get(key) is not None][-12:]
    return float(np.median(vals)) if vals else 0.0
stages = ["decompress", "demosaic", "tonemap"]
labels = ["Decompress", "Demosaic", "Tonemap"]
a_vals = [anc[s] for s in stages]
f_vals = [floor_avg(s) for s in stages]
fig, ax = plt.subplots(figsize=(6.6, 4.2))
xpos = np.arange(2); wid = 0.62; bottom_a = 0.0; bottom_f = 0.0
cols = [C["sky"], C["orange"], C["purple"]]
for lab, av, fv, cc in zip(labels, a_vals, f_vals, cols):
    ax.bar(0, av, wid, bottom=bottom_a, color=cc, edgecolor="white", linewidth=0.8, label=lab)
    ax.bar(1, fv, wid, bottom=bottom_f, color=cc, edgecolor="white", linewidth=0.8)
    if av > 60: ax.text(0, bottom_a + av/2, f"{av:.0f}", ha="center", va="center", color="white", fontsize=9, fontweight="bold")
    if fv > 12: ax.text(1, bottom_f + fv/2, f"{fv:.0f}", ha="center", va="center", color="white", fontsize=8)
    bottom_a += av; bottom_f += fv
ax.text(0, bottom_a + 60, f"{bottom_a:.0f} ms", ha="center", fontsize=10, fontweight="bold")
ax.text(1, bottom_f + 60, f"{bottom_f:.0f} ms", ha="center", fontsize=10, fontweight="bold")
ax.set_xticks(xpos); ax.set_xticklabels([f"Ancestor\n2026-05-28", f"Optimised\n2026-07"])
ax.set_ylabel("RAW decode time  (ms, mean of corpus)")
ax.set_title("Where the RAW-decode time went")
ax.legend(loc="upper right", title="Stage", title_fontsize=9)
ax.set_ylim(0, bottom_a * 1.16)
save(fig, "fig2_stage_decomposition")

# ---- Figure 3: pipeline latencies over the consistent-config era -----------
fig, ax = plt.subplots(figsize=(7.4, 4.6))
metrics = [("raw", "RAW decode", C["blue"]),
           ("progFinalSimd", "Progressive final (SIMD)", C["green"]),
           ("shotDecSimd", "One-shot decode (SIMD)", C["purple"]),
           ("shotEncSimd", "One-shot encode (SIMD)", C["orange"])]
for key, lab, cc in metrics:
    x, y = series(key, include_anc=False)
    ax.scatter(dts(x), y, s=10, color=cc, alpha=0.22, edgecolor="none", zorder=2)
    sx, sy = lowess(x, y, frac=0.30, logy=True)
    ax.plot(dts(sx), sy, color=cc, lw=2.2, zorder=4, label=lab)
ax.set_yscale("log")
ax.set_yticks([200, 300, 500, 1000, 2000, 4000])
ax.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f"{v:.0f}"))
ax.yaxis.set_minor_formatter(matplotlib.ticker.NullFormatter())
ax.set_ylabel("Latency  (ms, mean of corpus)")
ax.set_title("Pipeline latencies over the q85 / effort-3 era")
ax.set_xlabel("2026"); style_dates(ax)
ax.legend(loc="upper right", ncol=2)
save(fig, "fig3_pipeline_latencies")

# ---- Figure 4: multi-worker parallel speed-up -------------------------------
fig, ax = plt.subplots(figsize=(7.2, 4.0))
x, y = series("mtSpeedup", include_anc=False)
ax.scatter(dts(x), y, s=16, color=C["green"], alpha=0.3, edgecolor="none",
           label="run", zorder=2)
sx, sy = lowess(x, y, frac=0.22, logy=False)
ax.plot(dts(sx), sy, color=C["ink"], lw=2.4, zorder=4, label="LOWESS trend")
ax.axhline(1.0, ls=(0, (4, 3)), color=C["verm"], lw=1.2, zorder=1)
ax.annotate("break-even (serial = parallel)", (dts(x)[2], 1.0), xytext=(6, 6),
            textcoords="offset points", color=C["verm"], fontsize=8.5)
ax.set_ylabel("Multi-worker speed-up  (×)")
ax.set_title("Multi-file parallel speed-up (sequential ÷ parallel wall)")
ax.set_xlabel("2026"); style_dates(ax); ax.legend(loc="upper left")
save(fig, "fig4_parallel_speedup")

# ---- Figure 5: per-format RAW decode (small multiples) ----------------------
import glob, re, statistics as _st
TDIR = os.path.join(ROOT, "docs", "outputs", "timing tests")
def fmt_of(fn):
    fl = fn.lower()
    return "ORF" if fl.endswith(".orf") else "CR2" if fl.endswith(".cr2") else "DNG" if fl.endswith(".dng") else None
perfmt = {"ORF": [], "CR2": [], "DNG": []}
for f in sorted(glob.glob(os.path.join(TDIR, "*StandardMultifileTest-general.toon"))):
    txt = open(f, encoding="utf-8", errors="ignore").read()
    try: ep = datetime.strptime(os.path.basename(f)[:24], "%Y-%m-%dT%H-%M-%S-%fZ").timestamp()
    except Exception: continue
    m = re.search(r"runs\[\d+\]\{([^}]*)\}:\s*\n(.*?)(?:\n\s*\n|\n#)", txt, re.S)
    if not m: continue
    cols = [c.strip() for c in m.group(1).split("|")]
    if "file" not in cols or "raw_ms" not in cols: continue
    ci, ri = cols.index("file"), cols.index("raw_ms")
    for line in m.group(2).splitlines():
        vals = [v.strip() for v in line.split("|")]
        if len(vals) <= max(ci, ri): continue
        fm = fmt_of(vals[ci])
        if fm:
            try: perfmt[fm].append((ep, float(vals[ri])))
            except Exception: pass
_d = json.load(open(os.path.join(ROOT, "benchmark", "raw-format-sweep-results.json")))
anc_fmt = {fm: (round(_st.mean([r["rawMs"] for r in _d["rows"] if r["format"] == fm and r["tier"] == "simd"]), 0)
               if any(r["format"] == fm and r["tier"] == "simd" for r in _d["rows"]) else None)
           for fm in ("ORF", "CR2", "DNG")}
fig, axs = plt.subplots(1, 3, figsize=(11.5, 3.9), sharey=True)
fcol = {"ORF": C["blue"], "CR2": C["green"], "DNG": C["purple"]}
for ax, fm in zip(axs, ("ORF", "CR2", "DNG")):
    pts = perfmt[fm]; floor_f = 0
    if pts:
        xs = np.array([p[0] for p in pts]); ys = np.array([p[1] for p in pts])
        ax.scatter(dts(xs), ys, s=12, color=fcol[fm], alpha=0.28, edgecolor="none")
        sx, sy = lowess(xs, ys, frac=0.30, logy=True)
        ax.plot(dts(sx), sy, color=C["ink"], lw=2.2); floor_f = float(np.min(sy))
    if anc_fmt[fm]:
        ax.scatter([dt(anc["epoch"])], [anc_fmt[fm]], marker="*", s=240,
                   color=C["verm"], edgecolor="white", zorder=6)
        ax.set_title(f"{fm}   {anc_fmt[fm]:.0f} → ~{floor_f:.0f} ms  ({anc_fmt[fm]/floor_f:.1f}×)"
                     if floor_f else fm, fontsize=11)
    ax.set_yscale("log"); ax.set_yticks([300, 500, 1000, 2000, 4000])
    ax.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f"{v:.0f}"))
    ax.yaxis.set_minor_formatter(matplotlib.ticker.NullFormatter())
    style_dates(ax); ax.set_xlabel("2026")
axs[0].set_ylabel("RAW decode  (ms / file)")
fig.suptitle("RAW decode latency by format  (★ = 2026-05-28 ancestor)", fontsize=12, fontweight="bold")
fig.tight_layout(rect=[0, 0, 1, 0.94])
save(fig, "fig5_per_format")

# ---- summary ----------------------------------------------------------------
print("floor(raw)= %.0f ms | ancestor= %.0f | x= %.1f" % (floor, anc["raw"], anc["raw"]/floor))
print("stage drops: decompress %.0f->%.0f  demosaic %.0f->%.0f  tonemap %.0f->%.0f"
      % (a_vals[0], f_vals[0], a_vals[1], f_vals[1], a_vals[2], f_vals[2]))
print("figures written to", OUT)
for f in sorted(os.listdir(OUT)):
    print("  ", f)
