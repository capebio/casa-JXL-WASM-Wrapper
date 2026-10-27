# FableBraid (CASV fable tier / FBR1) → BLNV parity: gap doc

B-ec, 2026-10-19. Step 1 of the B-cf item (USER request): gaps only, no code.
Source: `C:\Foo\raw-converter-wasm` `b7d4e415`
(`crates/raw-pipeline/src/fable_braid.rs` 2063 lines, `fable_video.rs` 235,
`casa_video.rs` 6462, `casv-format.json`). Scores: `C:\Foo\blizz\docs\FormatMaturity-2026-10-18.html`
(master, untracked file). This doc: branch `lab/fb-parity-ec-20261019` in worktree
`C:\Foo\raw-converter-wasm-ec-fb` (unmerged).

## What FableBraid is (read from source, not run)

- FBR1 image = `"FBR1" | w | h | nplanes u8 | rct u8 | nplanes × (len | plane)`;
  plane = predictor (Zero/Top/External) + transform (none/left-delta) + per-row mode
  (COPY/RANS/RAW) + ONE 8-lane braided rANS stream (12-bit, u8 alphabet).
- Public API is RGB8 only: `encode_rgb8`, `encode_rgb8_delta`, `Delta{En,De}codeSession`.
  rct 1 = subtract-green (G, R−G, B−G).
- CASV fable tier = I-frames (FBR1, predictor Top) + P-frames (predictor External =
  previous frame), GOP-keyed; flag `CASV_HDR_FABLE_FLAG` (header) or CASR box bit 1 (footer
  layout). CSAU audio box rides along. bbox/tile/replace flags exist in CASV but are used
  only by the JXL tiers, not fable.
- std-only (no `use` lines); SIMD = SSSE3/SSE2 + wasm simd128, runtime-detected.

## Row today (criteria 1-17)

| # | Criterion | BLNV | FableBraid | Gap? |
|---|---|---|---|---|
| 1 | Lossless | ● | ● | — |
| 2 | Lossy arm | – (n/a) | ○ | n/a, same as BLNV (CASV has JXL lossy tiers) |
| 3 | Native levels | ● (level-8 front ext 0x07) | ○ | YES |
| 4 | Progressive | ● | ○ | YES (same mechanism as 3) |
| 5 | Ranged ROI | ● (P-frame byte ROI) | ○ | YES |
| 6 | ROI efficiency | ● | ○ | YES (follows 5) |
| 7 | Alpha | ● | ○ | YES |
| 8 | > 8-bit | ● | ○ | YES |
| 9 | Metadata + thumb | ● (META, side track, STACK) | ○ | YES |
| 10 | Browser | ● | ● | — |
| 11 | ORFuly | ● | ○ | YES |
| 12 | Wire | ● | ◐ (pins in rcw, not our registry) | YES |
| 13 | Multichannel | – | ○ | n/a if we copy BLNV; cheap anyway (see 7) |
| 14 | Float / HDR | – | – | — |
| 15 | Layers | – | – | — |
| 16 | Native SIMD | ● | ◐ (SSSE3/SSE2, no AVX2) | YES |
| 17 | WASM SIMD | ◐ | ◐ | parity already |

## Per gap: feasible, cost, source, wire

Costs are hand estimates (CLAUDE.md: hand estimates here ran 2.5-50x optimistic; read as
"order of"). Wire changes pre-approved; each needs a registry row + re-pinned golden.

| Gap | Feasible | Est. cost | Port or new | Wire impact |
|---|---|---|---|---|
| **Wire (12)** | y | 0.5 day | new rows in blizz `docs/WIRE-STABILITY.md` for FBR1 + CASV fable flag/CASR bit; pins already exist in rcw (`fable_golden.rs`, `casv-format.json` parity) | registry only, no byte change. **Do first**: every later gap adds tags |
| **ORFuly reader (11)** | y | 1-2 days | port `fable_braid.rs` decoder (std-only, copy-able) + a CASV walker (header/index/footer, ~300 lines of `casa_video.rs` read path) into blizz; hook ORFuly video open like `.blnv` | none (reader). Licence: our own codec → proprietary side, no AGPL code involved (verify file headers before copy) |
| **Metadata + thumb (9)** | y | 1 day | new CASV box (`CSMT`-style, like CASR/CSAU) carrying BLNV's META record bytes (port `meta_import` record writer); thumb = first-picture FBR1 at 1/8 | new box tag + golden |
| **Levels + progressive (3, 4)** | y | 2-3 days | port BLNV idea (level-8 front picture first, ext 0x07): FBR1 v2 plane list prefixed with a 1/8 box-mean image; decoder stops after it. No FableBraid primitive to reuse; the FBR1 header has room (new `nplanes`/flag byte) | FBR1 v2 (magic or flag bit), golden re-pin. Bytes: +~1.6% per frame for 1/8 (1/64 of pixels, worse compression) — price it, PREDICT before code |
| **Ranged ROI + efficiency (5, 6)** | y, with byte cost | 3-4 days | NEW: today one rANS stream per plane → no row is decodable alone. Need row bands (k bands per plane, each own 8 lane states + `rans_len`), index of band offsets; P-frame ROI then = bands × planes. BLNV's byte-ROI plan logic (region_ranges) ports for the fetch side | FBR1 v2 band table; +36 B state per band per plane (8×u32 + len) + 512 B freqs if per band (share freqs per plane to avoid). Must price with a probe first |
| **Alpha (7)** | y | 0.5 day | `nplanes` is already generic u8; add `encode_rgba8` (4th plane, predictor Top/External, no rct) | new nplanes value, golden; CASV header needs a channel-count field (flag bit) |
| **> 8-bit (8)** | y | 2 days | NEW: alphabet is u8 mod-256 by design (SIMD row add). Cheapest: split u16 sample into hi/lo byte planes (6 planes for RGB16); hi plane is near-COPY on real photos. Keeps every kernel. Alternative u16 rANS = rewrite, not recommended | rct/bitdepth byte in FBR1, golden. Bytes vs BLNV/LAT unknown: PREDICT then measure on Top-5 rgb16 |
| **Native SIMD AVX2 (16)** | y | 1 day + broker A/B | port `simd_detected!` pattern from blizz; AVX2 versions of the two row kernels (`prefix_add_pred_from`, `add_pred_from`) and deinterleave. Gain unknown: rANS decode (scalar, ILP) likely dominates — **profile first**, may be NOISE like BLNV's hand P-frame kernel | none |
| Multichannel (13) | y | with Alpha | same `nplanes` path | as Alpha |
| Lossy (2) | n/a | — | BLNV is n/a too; CASV already serves lossy via JXL replace tier | — |

## Order recommended

1. Wire rows (no bytes) → 2. ORFuly reader (port decoder; makes every later item
visible) → 3. Metadata box → 4. Alpha/multichannel (cheap, nplanes) → 5. >8-bit hi/lo
planes (measure) → 6. levels/progressive → 7. ROI bands (largest, price first) →
8. AVX2 only after a broker profile says kernels > ~10% of decode.

Total ≈ 11-15 days hand estimate (expect more). Items 5-7 each need a PREDICT + byte
probe before code.

## Unknown

- Enc/Dec /10: no current `casv_encode` build (exe 2026-08-31 predates `fable_braid.rs`
  2026-10-05). Needs one build of `fable_golden`/`fable_ab` example to time.
- Whether ORFuly should read CASV JXL tiers too (needs libjxl FFI; out of scope here).
- File-header licence lines in `fable_braid.rs` (none seen in the `//!` block).
