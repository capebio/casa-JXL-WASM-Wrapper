# ScannerBot Decode Throughput Lateral Ledger

Branch: `grok/decode-throughput-lateral-2`

Base: `b8bfc5c2`

Start: 2026-07-12

Stop: 2026-07-13

## Acceptance

- Integer-stable changes: byte-identical output.
- Performance: at least 2% relevant-stage improvement, high-trust interleaved measurement,
  and no end-to-end regression.
- Failed candidates are reverted; benchmark evidence remains.

## Baseline

### Setup

- `bun install` failed in unrelated `@casabio/jxl-native` postinstall because
  `jxl.lib` is unavailable in this worktree.
- `bun install --ignore-scripts` completed. Generated `bun.lock` drift was reverted.

### Behavior

| Suite | Result |
|---|---:|
| Progressive visible passes | 1 pass, 0 fail |
| Single Progressive page | 10 pass, 0 fail |
| Browser decode handler | 22 pass, 0 fail |
| WASM facade | 62 pass, 0 fail |
| Raw pipeline library | 399 pass, 0 fail, 12 ignored |

Base-known test defects:

- `decoder-lifecycle.test.ts` resolves `packages/src/decode-handler.ts`; 2 pass, 1 ENOENT.
- `progressive-detail.test.ts` references absent correlation/vendored-libjxl files and one
  stale source-string shape; runtime progressive round-trip still passes.

### Timing

Fresh-context browser harness, 20.5 MP `P2200619-prog-p6-q85.jxl`:

| Tier | Mode | n | Median | IQR | Trust | Disposition |
|---|---|---:|---:|---:|---|---|
| `simd` | final | 10 | 2834.1 ms | 431.9 ms | low (15.24%) | rejected |
| `simd-mt` | final | 0 | >335 s run | n/a | none | hard timeout |

- Pixel hash for completed ST samples: `2196883031`; `max_abs_diff=0`,
  `px_differ_count=0`, dimensions `5240x3912`.
- Earlier uncooled ST run was also rejected: median 2668.2 ms, IQR 1020.8 ms.
- MT timeout used shipped artifact; no speed inference. Controlled runner-count rebuilds
  are required before comparing MT variants.

## Findings

| ID | Hypothesis | State | Local delta | End-to-end delta | Parity |
|---|---|---|---:|---:|---|
| MT-1 | Match libjxl runner width to the four-thread Emscripten pool and charge that measured width to the scheduler | accepted | legacy width 0 hard-stalled past 65 s; fixed width 4 median 641.0 ms | 66.94% lower than SIMD fallback (1939.0 ms), paired n=12/arm, high-trust IQR | exact: hash 2196883031, 0 differing pixels |
| DH-1 | Skip awaiting when browser decoder push() / close() return synchronously | accepted | feed-loop overhead median 6.496 ms -> 0.557 ms for 100k sync chunks, -91.42%, n=30/arm high-trust | not isolated in image decode; removes per-chunk worker microtask overhead on the JXL WASM facade path | protocol output unchanged; handler tests 22 pass |

## Rejections

- Decoder runner width 2: median 1175.6 ms versus width 4 at 880.1 ms in
  independent tournaments; 33.6% slower single-decode. Under concurrency 4,
  width 2 remained 27.93% slower per decode (2409.8 ms versus 1736.8 ms).
- Runner width 0: controlled artifact reproduced the shipped MT hard stall.
- Facade-only box event skip: 681.44 ms control versus 675.67 ms candidate,
  only 0.85% faster across 25 samples per arm. Both arms high-trust and
  byte-exact; below the 2% gate, so the flag/event-mask change was reverted.
- RAW full-mosaic MHC+tone strip fusion: native stage looked strong
  (geomean -19.08% across 12/20/30 MP synthetic mosaics), but browser ORF decode
  did not clear the product gate after fresh rebuild. Reverted production code.
  Evidence: n=12 exact parity but -1.59% (below 2%); n=24 exact parity but
  +0.46% slower. Output digest stayed
  ddd200b1d9d0667e58c8bc793eb931c9bc231cf47c2cd7fa329e35481eddde54,
  dimensions 5240x3912, 61,496,640 bytes.

## Measurement Notes

- Host was shared with other agents. No claim of thermal isolation.
- The accepted final A/B used round-interleaved arms and no outcome tolerance.
  Both arms had high-trust IQR despite background load.
- Concurrency measurements were noisy and are supporting evidence only. Width 4
  produced about 47.2 MP/s aggregate at concurrency 4 versus 32.0 MP/s for one
  final MT decode, but that run was low-trust.

## Conclusion

Accepted: fixed JXL MT runner width/scheduler cost and browser worker sync-push fast path.
Rejected and reverted: runner width 2/0, facade-only box-event skip, and RAW strip fusion.
