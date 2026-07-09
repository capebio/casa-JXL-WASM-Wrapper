// Build the revert manifest from the banked verdicts of the 2026-07-08 optimize run.
// One isolated diff per LANDED production change. Status column marks what actually
// reaches the after-benchmark:
//   landed-harness  -> wired into StandardMultifileTest.mjs (moves after-dump metrics)
//   landed-worktree -> accepted isolated diff, committed in a workflow worktree, but NOT
//                      rebuilt into the shipped pkg/dist the benchmark loads (after-dump
//                      unaffected; revertable via the copied diff)
//   not-landed      -> config-only flipflop candidate, never wired to production source
//                      (no diff to revert; the flipflop test IS the artifact)
import { addEntry, renderManifest } from './manifest.mjs';
import { writeFileSync } from 'node:fs';

let list = [];

// --- LANDED in the measurement harness (reflected in after-dump.json) ---
list = addEntry(list, {
  id: 'OPT-01', status: 'landed-harness',
  layer: 'benchmark-harness (JS->WASM encode opts)',
  lens: 'aerial/tactical: rgb8/no-alpha on mod_prog_enc',
  file: 'StandardMultifileTest.mjs:612',
  accept_reason: 'faster', saved_pct: 20.5,
  diffPath: 'benchmark/optimize/docs/reverts/01-mod_prog-rgb8-noalpha.diff',
  note: 'drop constant alpha Modular Squeeze pass; Butteraugli d=0; also 21.9% run',
});
list = addEntry(list, {
  id: 'OPT-02', status: 'landed-harness',
  layer: 'benchmark-harness (JS->WASM encode opts)',
  lens: 'tactical: qProgressiveAc:0 on photon_prog_enc',
  file: 'StandardMultifileTest.mjs:651',
  accept_reason: 'faster', saved_pct: 2.2,
  diffPath: 'benchmark/optimize/docs/reverts/02-photon_prog-qprogressiveac0.diff',
  note: 'collapse 2nd quantized-AC pass; enc_ms 3-20% by size; Butteraugli d=0',
});

// --- LANDED in an isolated worktree, NOT rebuilt into shipped artifacts (after-dump unaffected) ---
list = addEntry(list, {
  id: 'OPT-03', status: 'landed-worktree',
  layer: 'rust (crates/raw-pipeline src/lib.rs)',
  lens: 'operational: fuse RGB8+DISP16 dual pass (one pre-LUT gather + one tone matvec)',
  file: 'crates/raw-pipeline/src/pipeline.rs (process_dual_simd) + src/lib.rs (finish_from_raw)',
  accept_reason: 'faster', saved_pct: 23.3,
  diffPath: 'benchmark/optimize/docs/reverts/03-fuse-rgb8-disp16-dual.diff',
  note: 'ORF flags=33 +23.3% pixel-exact; latent (no flags=33 caller); needs pkg rebuild; not in loaded pkg/',
});
list = addEntry(list, {
  id: 'OPT-04', status: 'landed-worktree',
  layer: 'cpp (external/libjxl-012 stage_noise.cc)',
  lens: 'mathematical: separable box conv in ConvolveNoiseStage (decode noise-shaping)',
  file: 'external/libjxl-012/lib/jxl/render_pipeline/stage_noise.cc',
  accept_reason: 'faster', saved_pct: 9.3,
  diffPath: 'benchmark/optimize/docs/reverts/04-noise-separable-box-conv.patch',
  note: 'whole-decode ~9.3% on noise streams; Butteraugli <=0.109; needs emsdk rebuild; not in shipped dist/',
});

// --- NOT LANDED: config-only flipflop candidates (no production diff; flipflop test IS the artifact) ---
const notLanded = [
  { id: 'CAND-05', lens: 'photon distance 1.0->1.5 (VarDCT)', saved_pct: 3.2,
    test: 'benchmark/optimize/.flipflop/tests/photon-distance15.mjs',
    note: 'enc ~5-16% on noisy content; ~24% smaller; Butteraugli 0.088-0.357; near noise floor end-to-end' },
  { id: 'CAND-06', lens: 'photon effort 3->2 (kThunder, LZ77Method::kNone cliff)', saved_pct: 7.9,
    test: 'benchmark/optimize/.flipflop/tests/photon-effort2-rgb8.mjs',
    note: 'Butteraugli d=0; magnitude env-noisy (1.4-7.9%); rgba8 sibling photon-effort2.mjs is wrong shape' },
  { id: 'CAND-07', lens: 'photon progressiveFlavor:dc (drop entire AC progression)', saved_pct: 20.7,
    test: 'benchmark/optimize/.flipflop/tests/photon-flavor-dc.mjs',
    note: 'Butteraugli d=0; 20-23% across 2 runs; MUTUALLY EXCLUSIVE with OPT-02 (both on photon path)' },
  { id: 'CAND-08', lens: 'mod_prog decodingSpeed:2 (prune MA-tree search)', saved_pct: 2.9,
    test: '.flipflop/tests/mod-prog-enc-decoding-speed.mjs',
    note: 'Butteraugli d=0; +2.9% at 2048px but SIGN FLIPS to -13% <=1024px; size-gated; +2% bytes' },
];
for (const c of notLanded) {
  list = addEntry(list, {
    id: c.id, status: 'not-landed', layer: 'benchmark-harness (candidate)',
    lens: c.lens, file: c.test, accept_reason: 'faster', saved_pct: c.saved_pct,
    diffPath: '(none — flipflop test only)', note: c.note,
  });
}

const md = renderManifest(list);
writeFileSync('benchmark/optimize/docs/reverts/MANIFEST.md', md);
console.log(md);
