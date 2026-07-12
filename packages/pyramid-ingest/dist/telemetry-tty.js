export const noOpTelemetry = {
    stage() { },
    progress() { },
    event() { },
};
/** Human-facing renderer. Selected by --verbose.
 *  - TTY-1: all status goes to STDERR so stdout stays machine-clean (--json / pipes).
 *  - TTY-2: TTY-aware — uses \r only on a real terminal, else emits plain progress lines.
 *  - TTY-3: stages print when `showStages` (passed from -vv) or VERBOSE/DEBUG env is set.
 *  - TTY-4: redraws throttled to ~10fps, line width-clamped, with rate/ETA.
 */
export function createTtyTelemetry(opts = {}) {
    const out = process.stderr;
    const tty = !!out.isTTY;
    const showStages = !!opts.showStages || !!(process.env.VERBOSE || process.env.DEBUG);
    let last = "";
    let lastPct = -1;
    let lastPaint = 0;
    const start = Date.now();
    return {
        stage(name, fields) {
            if (!showStages)
                return;
            const f = fields ? " " + JSON.stringify(fields) : "";
            out.write(`[stage] ${name}${f}\n`);
        },
        progress(done, total, currentItem) {
            const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
            const complete = done >= total && total > 0;
            if (tty) {
                const now = Date.now();
                if (!complete && now - lastPaint < 100)
                    return; // throttle to ~10fps
                lastPaint = now;
                const cols = out.columns ?? 80;
                let body = `${pct}% (${done}/${total})`;
                const elapsed = (now - start) / 1000;
                if (done > 0 && elapsed > 0.5) {
                    const rate = done / elapsed;
                    const eta = rate > 0 ? Math.round((total - done) / rate) : 0;
                    body += ` ${rate.toFixed(1)}/s eta ${eta}s`;
                }
                if (currentItem)
                    body += ` ${currentItem}`;
                if (body.length > cols - 1)
                    body = body.slice(0, cols - 2) + "…";
                const line = "\r" + body.padEnd(cols - 1); // padEnd clears residue from a longer prior line
                if (line !== last) {
                    out.write(line);
                    last = line;
                }
                if (complete) {
                    out.write("\n");
                    last = "";
                    lastPct = -1;
                }
            }
            else {
                // non-tty (piped/CI): no carriage returns; one line per percent change.
                if (pct !== lastPct) {
                    out.write(`${pct}% (${done}/${total})\n`);
                    lastPct = pct;
                }
            }
        },
        event() { }, // events go to json/runlog in CLI wrapper; tty silent
    };
}
//# sourceMappingURL=telemetry-tty.js.map