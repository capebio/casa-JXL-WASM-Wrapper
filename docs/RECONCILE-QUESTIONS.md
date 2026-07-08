# RECONCILE-QUESTIONS — deferred judgment calls from the WASM⇄Tauri reconciliation

Autonomous engine-port sessions log blocked/deferred items here for the driver to
sign off. Each entry: what was attempted, the evidence, and the recommended path.

---

## A.1.1 MHC — port the fork-unique branch-free MHC demosaic interior

**Status: BLOCKED — do NOT land the fork's `interior_row_fast` as-is. It is the
"symmetric B-at-R" colour-changing kernel (out of scope) and is NOT byte-exact
to canonical's current MHC. The performance win the task describes is ALREADY
present in canonical.**

Session: reconcile/portA-mhc @ worktree C:\Foo\rcw-pa-mhc, 2026-07-08.
Baseline was left **unmodified** (zero code edits); baseline is green:
- `cargo test --no-default-features --features parallel --lib demosaic` → **19 passed, 1 ignored**.
- `cargo test --no-default-features --features "parallel,jxl-codec" --test parity_corpus -- --test-threads=1` → **7 passed** (ORF pin `0xfb91a7f35549eaeb` + DNG pin `0x7a2717d8cdbbe4c2` hold — both are `assert_eq!` inside the passing tests).

### What the task asked for
Port the Tauri fork's branch-free scalar MHC interior (`interior_row_fast` /
`demosaic_rggb_mhc_variant_into`, in `origin/handoff/phase0-slice-20260706:raw-pipeline/src/demosaic.rs`)
into `crates/raw-pipeline/src/demosaic.rs`, **byte-identical** to canonical's
current clamped MHC. Explicitly excluded: AVX2/wasm SIMD interior (rejected) and
any "symmetric B-at-R variant" (colour-changing, separate sign-off).

### Why it is BLOCKED — two independent divergences

The two `demosaic.rs` files are **different lineages**, not clamped-vs-fast of the
same kernel. The fork's flip-flop (`docs/outputs/timing tests/flipflop/demosaic-interior-2026-07-05.md`)
compares the fork's OWN naive per-pixel-clamped interior against the fork's OWN
`interior_row_fast`. Canonical never had that naive clamped interior.

**Divergence 1 (fatal, colour-changing): B-at-R interpolation.**
At an interior R-site (even row, even col) the opposite channel (B) is
reconstructed differently:

| Site | Canonical production (`mhc_pixel_phased`, and the unrolled interior in `demosaic_rggb_mhc`) | Fork `interior_row_fast` (Symmetric) |
|---|---|---|
| B at R-site (0,0) | `b_v = (B_NE+B_NW+B_SE+B_SW) >> 2` — **plain bilinear diagonal** | `b_v = (2·Bdiag + 4·R_C − R_lap) >> 3` — **Laplacian-corrected (symmetric)** |
| R at B-site (1,1) | `r_v = (2·Rdiag + 4·B_C − B_lap) >> 3` — Laplacian-corrected | `r_v = (2·Rdiag + 4·B_C − B_lap) >> 3` — same ✓ |

Canonical is deliberately **asymmetric**: R-at-B gets the MHC Laplacian
correction, B-at-R does not (`sum_b4 >> 2` at demosaic.rs:1117-1121 and :1722-1726).
The fork makes B-at-R **also** Laplacian-corrected — i.e. the symmetric variant.

Empirical proof (standalone rustc probe) on a curved R-site
(R_C=4000, diagonals≈200, R-at-2 ≈100-120 so the R-Laplacian is large):
- canonical B-at-R = **200**
- fork(Symmetric) B-at-R = **2147** → **DIFFER**

They coincide only when `4·R_C − R_lap == 0` (a flat red field). On any real edge —
exactly where demosaic quality is judged — they diverge by hundreds→thousands of
counts. Canonical even pins the plain-bilinear behaviour indirectly, and the fork
pins the opposite (`mhc_b_at_r_correction_matches_formula` asserts B-at-R **uses**
the symmetric Laplacian). The two are contradictory by design.

`interior_row_fast` is **inseparable** from this change: its (0,0) B path only
offers `Symmetric => (2·Bdiag+4·rc−rlap)>>3` or `Canonical => …`; there is **no**
branch that reproduces canonical's `(Bdiag)>>2`. So it cannot be ported "interior
only, byte-exact" — porting it *is* adopting the symmetric B-at-R kernel, which
the task lists as out-of-scope and which fails the byte-exact gate + would move
the pinned ORF/DNG digests.

**Divergence 2 (also colour-changing): border/halo handling.**
Fork MHC uses a CFA-aware in-bounds-only `bilinear_border_pixel` for the outer
2-pixel halo. Canonical uses coordinate-**clamped** `mhc_pixel_phased` for the
whole frame including borders. Even if divergence 1 were resolved, the
whole-function outputs differ at every border pixel. (This is a genuine quality
question — CFA-aware borders avoid folding wrong-colour samples — but it is a
colour change, not a byte-exact perf port.)

### The performance win is already in canonical (nothing to port)
The task's stated goal — a branch-free, clamp-free interior — **already exists**
in the canonical crate and is byte-exact-guarded:
- `demosaic_rggb_mhc` (src/demosaic.rs:1594): interior is a 2-col-unrolled block
  over `[2, w-2)` with 5 hoisted row slices (`n2/north/here/south/s2`), direct
  slice indexing, row-parity hoisted out of the loop, CSE'd sums, and **no
  per-pixel clamp on the interior** (borders/tail keep clamping). Same class of
  optimization as `interior_row_fast`.
- `demosaic_bayer_mhc` (:1179): interior split `[2, w-2)` unclamped + an AVX2
  interior kernel `mhc_row_interior_avx2` (commit edad188b).
- Guarded byte-exact by `bayer_mhc_interior_split_matches_clamped_reference` and
  `bayer_mhc_avx2_bit_identical_to_clamped_reference` vs
  `demosaic_bayer_mhc_clamped_ref` (all in the 19 passing tests).

So there is no branch-free-interior *perf* deficit to close, and the only thing
`interior_row_fast` would add is the symmetric-B-at-R colour change.

### Recommendation for the driver (sign-off needed)
1. **Do not port `interior_row_fast`.** Mark F1.2 "MHC branch-free interior" as
   **already-satisfied in canonical** (like the other §A.1 items that turned out
   redundant). No canonical change required for the perf goal.
2. Treat **symmetric B-at-R** as its own quality proposal (matches the task's
   "separate sign-off item" note). If desired, evaluate it deliberately:
   flip-flop for quality (zipper / |R−B| on fine structure) AND accept that it
   re-pins ORF/DNG digests via the S5 golden-approval workflow. It is a
   colour-pipeline evolution, not a byte-exact port — out of scope for this
   autonomous run.
3. Same for the **CFA-aware border halo** (`bilinear_border_pixel`): a border
   quality change, separate colour sign-off, would also re-pin digests.

No commits made on this branch (nothing byte-exact to land). Tree left clean
apart from this questions file.
