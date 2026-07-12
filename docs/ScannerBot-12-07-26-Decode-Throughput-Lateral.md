# ScannerBot Decode Throughput Lateral Ledger

Branch: `grok/decode-throughput-lateral-2`

Base: `b8bfc5c2`

Start: 2026-07-12

Stop: OPEN

## Acceptance

- Integer-stable changes: byte-identical output.
- Performance: at least 5% relevant-stage improvement, high-trust interleaved measurement,
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

## Rejections

- Decoder runner width 2: median 1175.6 ms versus width 4 at 880.1 ms in
  independent tournaments; 33.6% slower single-decode. Under concurrency 4,
  width 2 remained 27.93% slower per decode (2409.8 ms versus 1736.8 ms).
- Runner width 0: controlled artifact reproduced the shipped MT hard stall.

## Measurement Notes

- Host was shared with other agents. No claim of thermal isolation.
- The accepted final A/B used round-interleaved arms and no outcome tolerance.
  Both arms had high-trust IQR despite background load.
- Concurrency measurements were noisy and are supporting evidence only. Width 4
  produced about 47.2 MP/s aggregate at concurrency 4 versus 32.0 MP/s for one
  final MT decode, but that run was low-trust.

## Conclusion

Run active.
