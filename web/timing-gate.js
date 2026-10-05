// Wall-clock assertions are not unit tests on a shared box: a busy box makes a
// timing ratio noise. They run only when asked for (RCW_TIMING=1) and only inside
// a WALL window (C:\Tmp\bench-phase.txt starts with WALL, the holder's own slot);
// otherwise the test is skipped. The default
// suites assert deterministic facts (bytes, dimensions, counts) instead.
import { readFileSync } from 'node:fs';

const BENCH_PHASE = String.raw`C:\Tmp\bench-phase.txt`;

export function timingEnabled() {
    if (process.env.RCW_TIMING !== '1') return false;
    let phase = '';
    try { phase = readFileSync(BENCH_PHASE, 'utf8').trim(); } catch {}
    if (!phase.startsWith('WALL')) {
        console.warn(`RCW_TIMING=1 refused: ${BENCH_PHASE} says '${phase || '(missing)'}', not a WALL window`);
        return false;
    }
    return true;
}
