# Seed corpus

Each subdirectory maps to a fuzz target by the same name.
Every target has at least one checked-in synthetic seed (compact blobs derived
from real file headers + structured byte patterns, sized 54 B–16 KB).

| Directory | Seed(s) | Source |
|-----------|---------|--------|
| `casv_audio_box/` | `seed_bbox.bin` (8 KB) | Synthetic CSAU-shaped box header |
| `casv_footer/` | `seed_bbox_tail.bin` (8 KB) | Synthetic CASV frame-index tail |
| `casv_header/` | `seed_bbox.bin` (8 KB) | Synthetic CASV container header |
| `cr2_decode/` | `seed_orf.bin` (16 KB) | Synthetic CR2/TIFF IFD header fragment |
| `decompress/` | `seed_synth.bin` (512 B) | Synthetic ORF decompressor bitstream |
| `dng_decode/` | `seed_dng.bin`, `seed_orf.bin` (16 KB each) | Synthetic DNG/TIFF IFD fragments |
| `jxtc_header/` | `seed_sinkrate.bin`, `seed_tilev2.bin` (8 KB each) | Synthetic JXTC tile-grid headers |
| `ljpeg_decode/` | `seed_min_sof3.bin` (54 B) | Minimal valid LJPEG SOF3 marker stream |
| `tiff_parse/` | `seed_orf.bin` (16 KB) | Synthetic TIFF/ORF IFD header fragment |

## Why synthetic seeds?

Real ORF/DNG/CR2 source files are 17–40 MB each — too large to commit.
The synthetic seeds are valid-prefix-shaped inputs that exercise the parser's
header-reading paths without inflating the repo.

## Adding real files (optional, Linux only)

Real source files are available at `C:\995\` on the development machine.
To seed with a real file and minimize it for commit:

```sh
# copy the file into the corpus directory
cp /path/to/P2200407.ORF \
    crates/raw-pipeline/fuzz/corpus/tiff_parse/real_orf.bin

cd crates/raw-pipeline

# minimize: cargo-fuzz shrinks the corpus to the smallest covering set
cargo +nightly fuzz cmin tiff_parse

# commit only the minimized result (usually <64 KB after cmin)
git add crates/raw-pipeline/fuzz/corpus/tiff_parse/
git commit -m "fuzz: add minimized ORF seed for tiff_parse"
```

Do the same for `cr2_decode` (use a `.CR2`), `dng_decode` (use a `.dng`),
and `ljpeg_decode` (use the LJPEG tile extracted from any CR2/ORF).

## What is NOT tracked

`cargo fuzz run` grows the corpus into this directory over time.
Fuzzer-discovered corpus entries, crash artifacts, and coverage data are in
`.gitignore` (`target/`, `artifacts/`, `coverage/`) and must not be committed.
Only manually reviewed, minimized seeds belong here.
