// Wall-clock assertions are not unit tests on a shared box: a busy box makes a
// timing ratio noise. They run only when asked for (RCW_TIMING=1) and only while
// C:\Tmp\bench-phase.txt says BUILD; otherwise the test is skipped. The default
// suites assert deterministic facts (bytes, dimensions, counts) instead.
import { readFileSync } from 'node:fs';

const BENCH_PHASE = String.raw`C:\Tmp\bench-phase.txt`;

export function timingEnabled() {
    if (process.env.RCW_TIMING !== '1') return false;
    let phase = '';
    try { phase = readFileSync(BENCH_PHASE, 'utf8').trim(); } catch {}
    if (phase !== 'BUILD') {
        console.warn(`RCW_TIMING=1 refused: ${BENCH_PHASE} says '${phase || '(missing)'}', not BUILD`);
        return false;
    }
    return true;
}
