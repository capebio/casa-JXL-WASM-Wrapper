# S5 Golden Corpus

**Colour authority:** David (capebio@gmail.com)
**Threshold:** butteraugli < 0.05 for automatic pass; >= 0.05 requires human sign-off.
**Last update:** 2026-07-07

Machine-readable version: `docs/golden-corpus.json`
Golden pixel buffers: `docs/golden-buffers/<id>.rgba` (gitignored; regenerate with `bun --smol scripts/golden-check.mjs --update`)

---

## Corpus files

### 1. P1110226-ORF

| Field | Value |
|-------|-------|
| Path | `C:\Foo\raw-converter\tests\P1110226.ORF` |
| Format | ORF (Olympus E-M5 II) |
| Dimensions | 5240 x 3912 (20.5 MP) |
| SHA256 of RGBA8 (neutral) | `5ad743c210c703153ca433ef476452e565e0dadf74af9d14c15c6e9f0391bed8` |
| Sliders | All zero, camera WB |
| Updated | 2026-07-07 |
| Notes | S4 parity anchor; Rust-side pin `ORF_RGBA8_HASH = 0x8806822277eac608` (SipHash-1-3). WASM RGBA8 SHA256 differs from Rust SHA because Rust uses the RGB8 path (3 ch) and the Rust hash is `std::DefaultHasher`, not SHA-256. Both are independently deterministic. |

### 2. PXL-20260527-DNG

| Field | Value |
|-------|-------|
| Path | `.timing-source/PXL_20260527_180319603.RAW-02.ORIGINAL.dng` (repo-relative) |
| Format | DNG (Google Pixel 2020) |
| Dimensions | 3628 x 2732 (9.9 MP) |
| SHA256 of RGBA8 (neutral) | `db0761ac9f98bcb0e09bcc91a9e272bfe35fef0cec290d199eec38241deb697d` |
| Sliders | All zero, camera WB |
| Updated | 2026-07-07 |
| Notes | S4 parity anchor; Rust-side pin `DNG_RGB8_HASH = 0x3c3fb14139efec5c`. Tracked in git — available in all worktrees. |

### 3. P2200407-ORF

| Field | Value |
|-------|-------|
| Path | `C:\995\2026-02-20 Gobabeb To Windhoek\Gobabeb Herbarium\P2200407.ORF` |
| Format | ORF (Olympus) |
| Dimensions | 5240 x 3912 (20.5 MP) |
| SHA256 of RGBA8 (neutral) | `6e3f17acc43b5859be4a82456832f44259d12b75879b5786a8e5128acaf0d712` |
| Sliders | All zero, camera WB |
| Updated | 2026-07-07 |
| Notes | Gobabeb herbarium expedition. Outdoor scene with complex lighting, foliage, and shadow gradients — sensitive to tone/demosaic changes. Machine-gated (absent on CI). |

---

## Check results (2026-07-07, unmodified pipeline)

```
golden-check  mode=CHECK  threshold=0.05
  PASS   P1110226-ORF: SHA256 match — butteraugli = 0.000
  PASS   PXL-20260527-DNG: SHA256 match — butteraugli = 0.000
  PASS   P2200407-ORF: SHA256 match — butteraugli = 0.000
Results: 3 pass, 0 fail, 0 skip
```

---

## Source provenance

| File | Origin | In git? |
|------|--------|---------|
| P1110226.ORF | `C:\Foo\raw-converter\tests\` — companion repo | No (large binary, external) |
| PXL_20260527…dng | `.timing-source/` | Yes (tracked) |
| P2200407.ORF | `C:\995\2026-02-20 Gobabeb To Windhoek\` | No (machine-local) |
