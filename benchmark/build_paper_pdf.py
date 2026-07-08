import os, shutil, subprocess

ROOT = r"C:/Foo/raw-converter-wasm"
src = os.path.join(ROOT, "docs", "RAW-pipeline-optimisation-campaign-2026.md")
bdir = os.path.join(ROOT, "docs", "paper-build")
figdir = os.path.join(ROOT, "docs", "outputs", "timing tests", "journal-figures")
os.makedirs(bdir, exist_ok=True)

for f in os.listdir(figdir):
    if f.endswith(".png"):
        shutil.copy(os.path.join(figdir, f), os.path.join(bdir, f))

t = open(src, encoding="utf-8").read()
t = t.replace("outputs/timing%20tests/journal-figures/", "paper-build/")

# Replace ONLY glyphs xelatex's default font lacks / that are LaTeX-hostile, with ASCII.
# Keep x-mult, cubes, middot, en/em dash, >=/<= as unicode (xelatex renders them).
rep = {
    "≈": "approx ",   # ≈
    "⌈": "ceil(",      # ⌈
    "⌉": ")",          # ⌉
    "†": "",           # † (dagger; footnote marker -> drop)
    "−": "-",          # − minus
    "÷": "/",          # ÷
    "§": "Sec. ",      # §
    "…": "...",        # …
    "★": "*",          # ★
    "‑": "-",          # non-breaking hyphen
    "✓": "yes",        # ✓
}
for a, b in rep.items():
    t = t.replace(a, b)

resid = sorted(set(c for c in t if ord(c) > 127))
print("kept unicode codepoints:", [hex(ord(c)) for c in resid])

out = os.path.join(bdir, "paper.md")
open(out, "w", encoding="utf-8").write(t)

pdf = os.path.join(ROOT, "docs", "RAW-pipeline-optimisation-campaign-2026.pdf")
cmd = ["pandoc", out, "-o", pdf, "--pdf-engine=xelatex",
       "--resource-path=" + os.path.join(ROOT, "docs"),
       "-V", "geometry:margin=2.1cm", "-V", "fontsize=10pt",
       "-V", "colorlinks=true", "-V", "linkcolor=RoyalBlue",
       "-V", "mainfont=Segoe UI", "-V", "monofont=Consolas", "--toc"]
r = subprocess.run(cmd, capture_output=True, text=True)
print("pandoc(xelatex, Segoe UI) exit:", r.returncode)
if r.returncode != 0:
    # retry without custom fonts (Latin Modern default)
    cmd2 = [c for c in cmd if not c.startswith("mainfont=") and not c.startswith("monofont=")]
    cmd2 = ["pandoc", out, "-o", pdf, "--pdf-engine=xelatex",
            "--resource-path=" + os.path.join(ROOT, "docs"),
            "-V", "geometry:margin=2.1cm", "-V", "fontsize=10pt",
            "-V", "colorlinks=true", "-V", "linkcolor=RoyalBlue", "--toc"]
    r = subprocess.run(cmd2, capture_output=True, text=True)
    print("retry(default font) exit:", r.returncode)
    if r.returncode != 0:
        print((r.stderr or r.stdout)[-1600:])
print("PDF exists:", os.path.exists(pdf), "bytes:", os.path.getsize(pdf) if os.path.exists(pdf) else 0)
