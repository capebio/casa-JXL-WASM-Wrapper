/**
 * web/tools/benchmark.js — benchmark harness + JXL decoder bench
 *
 * Finding 47 (P4 T8): extracted from main.js to break it out of the static
 * parse graph.  Loaded lazily via makeLazyModule on first button click.
 *
 * Call `initBenchmark(deps)` once.  It wires all benchmark buttons and returns
 * void.  All communication with main.js goes through the `deps` object — no
 * static imports back into main.js.
 *
 * deps:
 *   invoke          — Tauri invoke (or undefined in browser)
 *   listen          — Tauri listen (or undefined in browser)
 *   IS_TAURI        — boolean
 *   pushStat        — (line: string) => void
 *   updateStat      — (key: string, line: string) => void
 *   currentOptions  — () => { quality, lossless, look }
 *   lookToSnake     — (look) => string
 */
export function initBenchmark({ invoke, listen, IS_TAURI, pushStat, updateStat, currentOptions, lookToSnake }) {

    // ─── A/B benchmark harness ─────────────────────────────────────────────────
    // 2-config 200-file probe.  Topology axis exhausted (c=3 t=4 wins at 3/6/20
    // file scales).  Effort axis barely tested.  Two configs at champ topology
    // vary only effort: e=3 Falcon vs e=2 Thunder.
    const BENCH_CONFIGS = [
        { label: 'c=3 t=4 e=3  Falcon (champ)',  concurrency: 3, encoder_threads: 4, effort: 3 },
        { label: 'c=3 t=4 e=2  Thunder (probe)', concurrency: 3, encoder_threads: 4, effort: 2 },
    ];

    function _pct(arr, p) {
        if (!arr.length) return 0;
        const s = arr.slice().sort((a, b) => a - b);
        const i = Math.min(s.length - 1, Math.floor(s.length * p));
        return s[i];
    }
    function _stats(arr) {
        if (!arr.length) return { avg: 0, p50: 0, p95: 0, min: 0, max: 0 };
        return {
            avg: arr.reduce((s, x) => s + x, 0) / arr.length,
            p50: _pct(arr, 0.5),
            p95: _pct(arr, 0.95),
            min: arr.reduce((m, x) => Math.min(m, x), Infinity),
            max: arr.reduce((m, x) => Math.max(m, x), -Infinity),
        };
    }

    async function runOneConfig(paths, cfg, opts) {
        await invoke('set_concurrency', { n: cfg.concurrency });
        // Pre-size + write-by-index so completion-race doesn't shuffle drift order.
        const perFile = new Array(paths.length);
        const t0 = performance.now();
        await Promise.allSettled(paths.map(async (path, idx) => {
            const tStart = performance.now();
            try {
                const result = await invoke('process_file', {
                    path,
                    options: {
                        quality: opts.quality,
                        effort: cfg.effort,
                        lossless: opts.lossless,
                        look: lookToSnake(opts.look),
                        user_rotation: 0,
                        wb_r: null,
                        wb_b: null,
                        encoder_threads: cfg.encoder_threads,
                    },
                });
                const tEnd = performance.now();
                const t = result?.timings || {};
                perFile[idx] = {
                    path,
                    wall_ms:    tEnd - tStart,
                    start_ms:   tStart - t0,
                    end_ms:     tEnd - t0,
                    dec_ms:     t.decompress_ms || 0,
                    dem_ms:     t.demosaic_ms   || 0,
                    tone_ms:    t.tone_ms       || 0,
                    enc_ms:     t.encode_ms     || 0,
                    qwait_ms:   result?.queue_wait_ms || 0,
                    jxl_bytes:  result?.jxl?.length || 0,
                };
            } catch (err) {
                perFile[idx] = { error: String(err), path };
            }
        }));
        const wallMs = performance.now() - t0;
        return { cfg, wallMs, perFile };
    }

    function reportConfig(r) {
        const n = r.perFile.length;
        const ok = r.perFile.filter(p => !p.error);
        const errs = n - ok.length;
        const amortMs = r.wallMs / n;
        const tput = n / (r.wallMs / 1000);
        pushStat(
            `[bench] ${r.cfg.label}  total ${(r.wallMs / 1000).toFixed(2)}s  ` +
            `amort ${amortMs.toFixed(0)} ms/f  tput ${tput.toFixed(2)} f/s` +
            (errs ? `  ERRORS ${errs}` : '')
        );
        if (!ok.length) return;

        const dec   = _stats(ok.map(p => p.dec_ms));
        const dem   = _stats(ok.map(p => p.dem_ms));
        const tone  = _stats(ok.map(p => p.tone_ms));
        const enc   = _stats(ok.map(p => p.enc_ms));
        const qwait = _stats(ok.map(p => p.qwait_ms));
        const wall  = _stats(ok.map(p => p.wall_ms));
        const sizes = _stats(ok.map(p => p.jxl_bytes / 1024));

        pushStat(`[bench]   dec   avg ${dec.avg.toFixed(0)}  p50 ${dec.p50}  p95 ${dec.p95}  max ${dec.max} ms`);
        pushStat(`[bench]   dem   avg ${dem.avg.toFixed(0)}  p50 ${dem.p50}  p95 ${dem.p95}  max ${dem.max} ms`);
        pushStat(`[bench]   tone  avg ${tone.avg.toFixed(0)}  p50 ${tone.p50}  p95 ${tone.p95}  max ${tone.max} ms`);
        pushStat(`[bench]   enc   avg ${enc.avg.toFixed(0)}  p50 ${enc.p50}  p95 ${enc.p95}  max ${enc.max} ms`);
        pushStat(`[bench]   qwait avg ${qwait.avg.toFixed(0)}  p50 ${qwait.p50}  p95 ${qwait.p95}  max ${qwait.max} ms  (priority promotion effect under C/D)`);
        pushStat(`[bench]   wall  avg ${wall.avg.toFixed(0)}  p50 ${wall.p50.toFixed(0)}  p95 ${wall.p95.toFixed(0)}  max ${wall.max.toFixed(0)} ms`);
        pushStat(`[bench]   size  avg ${sizes.avg.toFixed(0)}  p50 ${sizes.p50.toFixed(0)}  p95 ${sizes.p95.toFixed(0)}  min ${sizes.min.toFixed(0)}  max ${sizes.max.toFixed(0)} KB  total ${(sizes.avg * ok.length / 1024).toFixed(1)} MB`);

        // Drift: split by dispatch index, compare first vs last half stage averages
        const half = Math.floor(ok.length / 2);
        const firstHalf = ok.slice(0, half);
        const lastHalf  = ok.slice(ok.length - half);
        const avg = (arr, k) => arr.reduce((s, p) => s + p[k], 0) / arr.length;
        const driftAmort  = (avg(lastHalf, 'wall_ms') - avg(firstHalf, 'wall_ms'));
        const driftDec    = (avg(lastHalf, 'dec_ms')  - avg(firstHalf, 'dec_ms'));
        const driftEnc    = (avg(lastHalf, 'enc_ms')  - avg(firstHalf, 'enc_ms'));
        const pct = (delta, base) => base > 0 ? `${delta >= 0 ? '+' : ''}${(100 * delta / base).toFixed(1)}%` : 'n/a';
        pushStat(
            `[bench]   drift  wall ${avg(firstHalf, 'wall_ms').toFixed(0)}→${avg(lastHalf, 'wall_ms').toFixed(0)} ms (${pct(driftAmort, avg(firstHalf, 'wall_ms'))})  ` +
            `dec ${pct(driftDec, avg(firstHalf, 'dec_ms'))}  enc ${pct(driftEnc, avg(firstHalf, 'enc_ms'))}`
        );

        // Top 3 slowest by wall_ms
        const fname = (p) => (p.split(/[\\/]/).pop() || p);
        const slowest = ok.slice().sort((a, b) => b.wall_ms - a.wall_ms).slice(0, 3);
        pushStat('[bench]   slowest 3:');
        for (const p of slowest) {
            pushStat(`[bench]     ${fname(p.path)}  wall ${p.wall_ms.toFixed(0)} ms  dec ${p.dec_ms} dem ${p.dem_ms} tone ${p.tone_ms} enc ${p.enc_ms} qwait ${p.qwait_ms}  ${(p.jxl_bytes/1024).toFixed(0)} KB`);
        }
        pushStat('');
    }

    async function runBenchmark() {
        if (!IS_TAURI) {
            pushStat('[bench] tauri-only — benchmark needs the native pipeline');
            return;
        }
        let paths;
        try {
            paths = await invoke('pick_files');
        } catch (err) {
            pushStat(`[bench] pick_files failed: ${err}`);
            return;
        }
        if (!paths?.length) { pushStat('[bench] cancelled — no files'); return; }
        const opts = currentOptions();
        pushStat(`[bench] ${paths.length} files × ${BENCH_CONFIGS.length} configs starting…`);

        const rows = [];
        for (let i = 0; i < BENCH_CONFIGS.length; i++) {
            const cfg = BENCH_CONFIGS[i];
            updateStat('bench:status', `[bench] running ${i + 1}/${BENCH_CONFIGS.length}  ${cfg.label}…`);
            const r = await runOneConfig(paths, cfg, opts);
            rows.push(r);
            reportConfig(r);
        }

        // A/B Pareto comparison (only meaningful for 2 configs).
        if (rows.length === 2) {
            pushStat('[bench] === A vs B Pareto ===');
            const a = rows[0], b = rows[1];
            const okA = a.perFile.filter(p => !p.error);
            const okB = b.perFile.filter(p => !p.error);
            const tputA = a.perFile.length / (a.wallMs / 1000);
            const tputB = b.perFile.length / (b.wallMs / 1000);
            const avgSizeA = okA.reduce((s, p) => s + p.jxl_bytes, 0) / okA.length / 1024;
            const avgSizeB = okB.reduce((s, p) => s + p.jxl_bytes, 0) / okB.length / 1024;
            const totalA = okA.reduce((s, p) => s + p.jxl_bytes, 0) / 1024 / 1024;
            const totalB = okB.reduce((s, p) => s + p.jxl_bytes, 0) / 1024 / 1024;
            const speedDelta = 100 * (tputB - tputA) / tputA;
            const sizeDelta  = 100 * (avgSizeB - avgSizeA) / avgSizeA;
            pushStat(`[bench]   A: ${a.cfg.label}`);
            pushStat(`[bench]   B: ${b.cfg.label}`);
            pushStat(`[bench]   speed  A ${tputA.toFixed(2)} f/s  →  B ${tputB.toFixed(2)} f/s  (${speedDelta >= 0 ? '+' : ''}${speedDelta.toFixed(1)}%)`);
            pushStat(`[bench]   size   A ${avgSizeA.toFixed(0)} KB/f → B ${avgSizeB.toFixed(0)} KB/f  (${sizeDelta >= 0 ? '+' : ''}${sizeDelta.toFixed(1)}%)`);
            pushStat(`[bench]   total  A ${totalA.toFixed(1)} MB    → B ${totalB.toFixed(1)} MB`);
            let verdict;
            if (speedDelta > 0 && sizeDelta <= 2) verdict = 'B WINS — faster, no size cost (replace default)';
            else if (speedDelta > 0 && sizeDelta < speedDelta) verdict = 'B Pareto-wins on speed (gains > size cost)';
            else if (speedDelta > 0)                          verdict = 'TRAP — B faster but size cost ≥ speed gain (Lightning-style)';
            else if (Math.abs(speedDelta) < 2)                verdict = 'TIE — keep A (smaller)';
            else                                              verdict = 'A holds — B slower';
            pushStat(`[bench]   ⇒ ${verdict}`);
        }

        updateStat('bench:status', `[bench] done — ${rows.length} configs, ${paths.length} files each`);

        // Restore the default concurrency for normal operation.
        await invoke('set_concurrency', { n: 3 });
    }

    // Effort sweep: e=1..9 at fixed c=3 t=4.  Reports per-file output size.
    async function runEffortSweep() {
        if (!IS_TAURI) {
            pushStat('[sweep] tauri-only — needs the native pipeline');
            return;
        }
        let paths;
        try { paths = await invoke('pick_files'); }
        catch (err) { pushStat(`[sweep] pick_files failed: ${err}`); return; }
        if (!paths?.length) { pushStat('[sweep] cancelled — no files'); return; }
        const opts = currentOptions();
        const fname = (p) => (p.split(/[\\/]/).pop() || p);

        pushStat(`[sweep] ${paths.length} files × 9 efforts (c=3 t=4, q=${opts.quality}, lossless=${opts.lossless})`);
        pushStat('[sweep] effort key: 1 Lightning · 2 Thunder · 3 Falcon · 4 Cheetah · 5 Hare · 6 Wombat · 7 Squirrel · 8 Kitten · 9 Tortoise');

        const rows = [];
        for (let e = 1; e <= 9; e++) {
            const cfg = { label: `c=3 t=4 e=${e}`, concurrency: 3, encoder_threads: 4, effort: e };
            updateStat('bench:status', `[sweep] running e=${e}…`);
            const r = await runOneConfig(paths, cfg, opts);
            rows.push({ effort: e, ...r });
            const ok = r.perFile.filter(p => !p.error);
            const totalKB = ok.reduce((s, p) => s + p.jxl_bytes, 0) / 1024;
            const avgKB   = ok.length ? totalKB / ok.length : 0;
            const avgEnc  = ok.length ? ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length : 0;
            const sizesStr = r.perFile.map((p, i) =>
                p.error ? `${fname(paths[i])}=ERR` : `${fname(paths[i])}=${(p.jxl_bytes/1024).toFixed(0)}KB`
            ).join(' · ');
            pushStat(
                `[sweep] e=${e}  ` +
                `wall ${(r.wallMs/1000).toFixed(2)}s  ` +
                `enc ${avgEnc.toFixed(0)} ms/file  ` +
                `avg ${avgKB.toFixed(0)} KB  ` +
                `total ${totalKB.toFixed(0)} KB`
            );
            pushStat(`[sweep]   sizes: ${sizesStr}`);
        }

        pushStat('');
        pushStat('[sweep] === effort vs size table ===');
        pushStat('[sweep]  e   wall_s   enc_ms   avg_KB   total_KB');
        for (const r of rows) {
            const ok = r.perFile.filter(p => !p.error);
            const totalKB = ok.reduce((s, p) => s + p.jxl_bytes, 0) / 1024;
            const avgKB   = ok.length ? totalKB / ok.length : 0;
            const avgEnc  = ok.length ? ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length : 0;
            pushStat(
                `[sweep]  ${r.effort}` +
                `   ${(r.wallMs/1000).toFixed(2).padStart(6)}` +
                `   ${avgEnc.toFixed(0).padStart(6)}` +
                `   ${avgKB.toFixed(0).padStart(6)}` +
                `   ${totalKB.toFixed(0).padStart(8)}`
            );
        }
        updateStat('bench:status', `[sweep] done — 9 efforts × ${paths.length} files`);
        await invoke('set_concurrency', { n: 3 });
    }

    // Variance × effort bench: picks 5 size-spread files from the user's
    // pick, sweeps effort 3/6/7/8/9, reports size matrix + upload-quota
    // economics.
    const VARIANCE_TARGETS = [
        'P1110187',  // ~973 KB Falcon — smooth scene, low entropy
        'P1100086',  // ~1866 KB
        'P1110179',  // ~3182 KB
        'P1100149',  // ~4788 KB
        'P1110202',  // ~5575 KB — high entropy
    ];
    const VARIANCE_EFFORTS = [3, 6, 7, 8, 9];
    const VARIANCE_TOPOLOGY = { concurrency: 3, encoder_threads: 4 };
    // Starlink-ish assumptions for upload-time economics.  Edit as needed.
    const QUOTA_GB = 50;
    const UPLOAD_MBPS = 25;  // typical Starlink upload, MB-per-sec ≈ Mbps/8

    async function runVarianceBench() {
        if (!IS_TAURI) { pushStat('[var] tauri-only'); return; }
        let allPaths;
        try { allPaths = await invoke('pick_files'); }
        catch (err) { pushStat(`[var] pick_files failed: ${err}`); return; }
        if (!allPaths?.length) { pushStat('[var] cancelled'); return; }

        const fname = (p) => (p.split(/[\\/]/).pop() || p);
        const baseUC = (p) => fname(p).replace(/\.[Oo][Rr][Ff]$/, '').toUpperCase();
        const selected = [];
        const missing = [];
        for (const target of VARIANCE_TARGETS) {
            const tu = target.toUpperCase();
            const hit = allPaths.find(p => baseUC(p).startsWith(tu));
            if (hit) selected.push({ target, path: hit });
            else missing.push(target);
        }
        if (missing.length) pushStat(`[var] missing: ${missing.join(', ')}`);
        if (!selected.length) { pushStat('[var] no targets found in selection'); return; }

        const opts = currentOptions();
        pushStat(`[var] ${selected.length} files × ${VARIANCE_EFFORTS.length} efforts  c=${VARIANCE_TOPOLOGY.concurrency} t=${VARIANCE_TOPOLOGY.encoder_threads} q=${opts.quality} lossless=${opts.lossless}`);
        pushStat(`[var] targets: ${selected.map(s => fname(s.path)).join(', ')}`);
        pushStat('[var] effort key: 3 Falcon · 5 Hare · 6 Wombat · 7 Squirrel · 8 Kitten · 9 Tortoise');

        const paths = selected.map(s => s.path);
        const matrix = [];
        for (let i = 0; i < VARIANCE_EFFORTS.length; i++) {
            const e = VARIANCE_EFFORTS[i];
            const cfg = { label: `e=${e}`, concurrency: VARIANCE_TOPOLOGY.concurrency, encoder_threads: VARIANCE_TOPOLOGY.encoder_threads, effort: e };
            updateStat('bench:status', `[var] ${i+1}/${VARIANCE_EFFORTS.length}  effort ${e}…`);
            const r = await runOneConfig(paths, cfg, opts);
            matrix.push({ effort: e, ...r });
            const ok = r.perFile.filter(p => !p.error);
            const totalKB = ok.reduce((s, p) => s + p.jxl_bytes, 0) / 1024;
            const avgKB   = ok.length ? totalKB / ok.length : 0;
            const avgEnc  = ok.length ? ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length : 0;
            pushStat(`[var] e=${e}  wall ${(r.wallMs/1000).toFixed(2)}s  enc ${avgEnc.toFixed(0)} ms/f  avg ${avgKB.toFixed(0)} KB  total ${totalKB.toFixed(0)} KB`);
        }

        // === size matrix: rows = files, columns = effort ===
        pushStat('');
        pushStat('[var] === size matrix (KB per file) ===');
        const header = 'file              ' + VARIANCE_EFFORTS.map(e => `   e=${e}`).join('  ');
        pushStat('[var] ' + header);
        for (let f = 0; f < paths.length; f++) {
            const row = VARIANCE_EFFORTS.map((_, ei) => {
                const p = matrix[ei].perFile[f];
                return p && !p.error ? (p.jxl_bytes/1024).toFixed(0).padStart(6) : '   ERR';
            }).join('  ');
            pushStat(`[var] ${fname(paths[f]).padEnd(18)}${row}`);
        }

        // === aggregate Pareto + quota economics ===
        pushStat('');
        pushStat('[var] === effort vs size + upload economics ===');
        pushStat(`[var]  quota = ${QUOTA_GB} GB/mo  upload = ${UPLOAD_MBPS} Mbps (${(UPLOAD_MBPS/8).toFixed(1)} MB/s)`);
        pushStat('[var]  e   avgKB   enc_s   vs_e3_size   vs_e3_enc   files/quota   upload_s   total_s');
        const baseE3 = matrix[0];
        const baseOk = baseE3.perFile.filter(p => !p.error);
        const baseAvgKB = baseOk.reduce((s, p) => s + p.jxl_bytes, 0) / baseOk.length / 1024;
        const baseAvgEnc = baseOk.reduce((s, p) => s + p.enc_ms, 0) / baseOk.length / 1000;
        const uploadMBps = UPLOAD_MBPS / 8;
        for (const r of matrix) {
            const ok = r.perFile.filter(p => !p.error);
            const avgKB  = ok.reduce((s, p) => s + p.jxl_bytes, 0) / ok.length / 1024;
            const avgEnc = ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length / 1000;
            const sizeDelta = 100 * (avgKB  - baseAvgKB)  / baseAvgKB;
            const encDelta  = 100 * (avgEnc - baseAvgEnc) / baseAvgEnc;
            const filesPerQuota = (QUOTA_GB * 1024 * 1024) / avgKB;
            const uploadS = (avgKB / 1024) / uploadMBps;   // KB → MB → s
            const totalS  = avgEnc + uploadS;
            const sdStr = (sizeDelta >= 0 ? '+' : '') + sizeDelta.toFixed(1) + '%';
            const edStr = (encDelta  >= 0 ? '+' : '') + encDelta.toFixed(1)  + '%';
            pushStat(
                `[var]  ${r.effort}` +
                `  ${avgKB.toFixed(0).padStart(6)}` +
                `  ${avgEnc.toFixed(2).padStart(6)}` +
                `  ${sdStr.padStart(11)}` +
                `  ${edStr.padStart(10)}` +
                `  ${filesPerQuota.toFixed(0).padStart(12)}` +
                `  ${uploadS.toFixed(2).padStart(8)}` +
                `  ${totalS.toFixed(2).padStart(8)}`
            );
        }

        // === verdict: pick the effort that minimises total time-to-upload ===
        pushStat('');
        let bestTotal = { effort: 0, totalS: Infinity };
        let bestSize  = { effort: 0, avgKB: Infinity };
        let bestQuota = { effort: 0, files: 0 };
        for (const r of matrix) {
            const ok = r.perFile.filter(p => !p.error);
            const avgKB  = ok.reduce((s, p) => s + p.jxl_bytes, 0) / ok.length / 1024;
            const avgEnc = ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length / 1000;
            const totalS = avgEnc + (avgKB / 1024) / uploadMBps;
            const files  = (QUOTA_GB * 1024 * 1024) / avgKB;
            if (totalS < bestTotal.totalS) bestTotal = { effort: r.effort, totalS };
            if (avgKB  < bestSize.avgKB)   bestSize  = { effort: r.effort, avgKB };
            if (files  > bestQuota.files)  bestQuota = { effort: r.effort, files };
        }
        pushStat(`[var] BEST encode+upload total time:  e=${bestTotal.effort}  (${bestTotal.totalS.toFixed(2)} s/file)`);
        pushStat(`[var] BEST output size:               e=${bestSize.effort}  (${bestSize.avgKB.toFixed(0)} KB/file)`);
        pushStat(`[var] BEST files per ${QUOTA_GB} GB quota:        e=${bestQuota.effort}  (${bestQuota.files.toFixed(0)} files)`);
        updateStat('bench:status', `[var] done`);
        await invoke('set_concurrency', { n: 3 });
    }

    // Quality sweep: q=80/85/90/95 at fixed c=3 t=4 e=3 Falcon on 10 files
    // sampled with even spread across the picked folder.
    const QUALITY_VALUES = [80, 85, 90, 95];
    const QUALITY_TOPOLOGY = { concurrency: 3, encoder_threads: 4, effort: 3 };
    const QUALITY_SAMPLE_N = 10;

    async function runQualitySweep() {
        if (!IS_TAURI) { pushStat('[q] tauri-only'); return; }
        let allPaths;
        try { allPaths = await invoke('pick_files'); }
        catch (err) { pushStat(`[q] pick_files failed: ${err}`); return; }
        if (!allPaths?.length) { pushStat('[q] cancelled'); return; }

        const fname = (p) => (p.split(/[\\/]/).pop() || p);
        const n = allPaths.length;
        const paths = [];
        if (n <= QUALITY_SAMPLE_N) {
            paths.push(...allPaths);
        } else {
            for (let i = 0; i < QUALITY_SAMPLE_N; i++) {
                paths.push(allPaths[Math.floor(i * n / QUALITY_SAMPLE_N)]);
            }
        }

        const baseOpts = currentOptions();
        pushStat(`[q] picked ${n} files, sampling ${paths.length} with even spread`);
        pushStat(`[q] sweep q=${QUALITY_VALUES.join('/')} at c=${QUALITY_TOPOLOGY.concurrency} t=${QUALITY_TOPOLOGY.encoder_threads} e=${QUALITY_TOPOLOGY.effort} Falcon  lossless=${baseOpts.lossless}`);
        pushStat('[q] chosen files:');
        for (let i = 0; i < paths.length; i++) {
            pushStat(`[q]   ${String(i+1).padStart(2)}. ${fname(paths[i])}`);
        }

        const matrix = [];
        for (let i = 0; i < QUALITY_VALUES.length; i++) {
            const q = QUALITY_VALUES[i];
            const cfg = { label: `q=${q}`, ...QUALITY_TOPOLOGY };
            const opts = { ...baseOpts, quality: q };
            updateStat('bench:status', `[q] ${i+1}/${QUALITY_VALUES.length}  q=${q}…`);
            const r = await runOneConfig(paths, cfg, opts);
            matrix.push({ quality: q, ...r });
            const ok = r.perFile.filter(p => !p.error);
            const totalKB = ok.reduce((s, p) => s + p.jxl_bytes, 0) / 1024;
            const avgKB   = ok.length ? totalKB / ok.length : 0;
            const avgEnc  = ok.length ? ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length : 0;
            pushStat(`[q] q=${q}  wall ${(r.wallMs/1000).toFixed(2)}s  enc ${avgEnc.toFixed(0)} ms/f  avg ${avgKB.toFixed(0)} KB  total ${totalKB.toFixed(0)} KB`);
        }

        // === size matrix: rows = files, columns = quality ===
        pushStat('');
        pushStat('[q] === size matrix (KB per file) ===');
        const header = 'file                  ' + QUALITY_VALUES.map(q => `  q=${q}`).join('  ');
        pushStat('[q] ' + header);
        for (let f = 0; f < paths.length; f++) {
            const row = QUALITY_VALUES.map((_, qi) => {
                const p = matrix[qi].perFile[f];
                return p && !p.error ? (p.jxl_bytes/1024).toFixed(0).padStart(5) : '  ERR';
            }).join('  ');
            pushStat(`[q] ${fname(paths[f]).padEnd(22)}${row}`);
        }

        // === aggregate Pareto + quota economics, anchored at q=90 ===
        pushStat('');
        pushStat('[q] === quality vs size + upload economics ===');
        pushStat(`[q]  quota = ${QUOTA_GB} GB/mo  upload = ${UPLOAD_MBPS} Mbps (${(UPLOAD_MBPS/8).toFixed(1)} MB/s)  anchor = q=90`);
        pushStat('[q]  q    avgKB   p50KB   p95KB   enc_ms   vs_q90_size   files/quota   upload_s   total_s');
        const baseIdx = QUALITY_VALUES.indexOf(90);
        const baseRow = matrix[baseIdx];
        const baseOk = baseRow.perFile.filter(p => !p.error);
        const baseAvgKB = baseOk.reduce((s, p) => s + p.jxl_bytes, 0) / baseOk.length / 1024;
        const uploadMBps = UPLOAD_MBPS / 8;
        for (const r of matrix) {
            const ok = r.perFile.filter(p => !p.error);
            const sizesKB = ok.map(p => p.jxl_bytes / 1024);
            const sStats  = _stats(sizesKB);
            const avgKB   = sStats.avg;
            const avgEnc  = ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length;
            const sizeDelta = 100 * (avgKB - baseAvgKB) / baseAvgKB;
            const filesPerQuota = (QUOTA_GB * 1024 * 1024) / avgKB;
            const uploadS = (avgKB / 1024) / uploadMBps;
            const totalS  = (avgEnc / 1000) + uploadS;
            const sdStr = (sizeDelta >= 0 ? '+' : '') + sizeDelta.toFixed(1) + '%';
            pushStat(
                `[q]  ${r.quality}` +
                `  ${avgKB.toFixed(0).padStart(6)}` +
                `  ${sStats.p50.toFixed(0).padStart(6)}` +
                `  ${sStats.p95.toFixed(0).padStart(6)}` +
                `  ${avgEnc.toFixed(0).padStart(7)}` +
                `  ${sdStr.padStart(12)}` +
                `  ${filesPerQuota.toFixed(0).padStart(12)}` +
                `  ${uploadS.toFixed(2).padStart(8)}` +
                `  ${totalS.toFixed(2).padStart(8)}`
            );
        }

        // === verdicts ===
        pushStat('');
        let bestTotal = { quality: 0, totalS: Infinity };
        let bestSize  = { quality: 0, avgKB: Infinity };
        let bestQuota = { quality: 0, files: 0 };
        for (const r of matrix) {
            const ok = r.perFile.filter(p => !p.error);
            const avgKB  = ok.reduce((s, p) => s + p.jxl_bytes, 0) / ok.length / 1024;
            const avgEnc = ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length / 1000;
            const totalS = avgEnc + (avgKB / 1024) / uploadMBps;
            const files  = (QUOTA_GB * 1024 * 1024) / avgKB;
            if (totalS < bestTotal.totalS) bestTotal = { quality: r.quality, totalS };
            if (avgKB  < bestSize.avgKB)   bestSize  = { quality: r.quality, avgKB };
            if (files  > bestQuota.files)  bestQuota = { quality: r.quality, files };
        }
        pushStat(`[q] BEST encode+upload total time:  q=${bestTotal.quality}  (${bestTotal.totalS.toFixed(2)} s/file)`);
        pushStat(`[q] BEST output size:               q=${bestSize.quality}  (${bestSize.avgKB.toFixed(0)} KB/file)`);
        pushStat(`[q] BEST files per ${QUOTA_GB} GB quota:        q=${bestQuota.quality}  (${bestQuota.files.toFixed(0)} files)`);
        updateStat('bench:status', `[q] done`);
        await invoke('set_concurrency', { n: 3 });
    }

    // ─── JXL decoder bench ─────────────────────────────────────────────────────

    // Measure canvas paint cost (putImageData) at each unique W×H in the bench
    // rows. Paint cost depends only on dimensions, not on which decoder produced
    // the buffer — so a synthetic RGBA of the right size gives an accurate paint
    // timing without round-tripping the real decoded pixels through IPC (which
    // would dominate the measurement with JSON-array encoding overhead).
    function measurePaintTimings(rows) {
        const canvas = document.createElement('canvas');
        canvas.style.position = 'fixed';
        canvas.style.left = '-99999px';
        canvas.style.top = '0';
        document.body.appendChild(canvas);
        const ctx = canvas.getContext('2d');
        const cache = new Map();
        const ITERS = 3;
        for (const r of rows) {
            if (!r.width || !r.height) { r.paint_ms = 0; continue; }
            const key = `${r.width}x${r.height}`;
            if (cache.has(key)) { r.paint_ms = cache.get(key); continue; }
            canvas.width = r.width;
            canvas.height = r.height;
            const rgba = new Uint8ClampedArray(r.width * r.height * 4);
            // Mid-grey opaque; avoids any all-zero fast-path the browser might take.
            for (let i = 0; i < rgba.length; i += 4) {
                rgba[i] = 128; rgba[i+1] = 128; rgba[i+2] = 128; rgba[i+3] = 255;
            }
            const imgData = new ImageData(rgba, r.width, r.height);
            // Warm up — first putImageData on a fresh canvas size pays extra cost.
            ctx.putImageData(imgData, 0, 0);
            const t0 = performance.now();
            for (let i = 0; i < ITERS; i++) ctx.putImageData(imgData, 0, 0);
            const ms = (performance.now() - t0) / ITERS;
            cache.set(key, ms);
            r.paint_ms = ms;
        }
        canvas.remove();
    }

    // JXL decoder bench — encodes a chosen ORF then decodes it with jpegxl-rs
    // (libjxl, current encoder) and jxl-oxide (pure-Rust) at a ladder of sizes
    // and regions, printing the timing matrix to the stats panel.
    const _benchPad = (s, n) => String(s).padEnd(n, ' ');
    const _benchPadN = (s, n) => String(s).padStart(n, ' ');
    const _benchFmtMs1 = (ms) => `${(ms || 0).toFixed(1)}ms`;

    function printBenchResult(label, result) {
        pushStat(`[${label}] file ${result.source_path}`);
        pushStat(`[${label}] full ${result.full_width}×${result.full_height}  jxl ${(result.encoded_bytes/1024).toFixed(0)} KB  encode ${result.encode_ms} ms`);
        measurePaintTimings(result.rows);
        pushStat(`[${label}] ${_benchPad('library', 11)} ${_benchPad('operation', 22)} ${_benchPadN('w', 5)}×${_benchPadN('h', 5)} ${_benchPadN('decode', 9)} ${_benchPadN('post', 8)} ${_benchPadN('paint', 9)} ${_benchPadN('total', 9)}  note`);
        for (const r of result.rows) {
            const totalWithPaint = (r.decode_ms || 0) + (r.resize_ms || 0) + (r.paint_ms || 0);
            pushStat(
                `[${label}] ${_benchPad(r.library, 11)} ${_benchPad(r.operation, 22)} ${_benchPadN(r.width, 5)}×${_benchPadN(r.height, 5)} ` +
                `${_benchPadN(r.decode_ms + 'ms', 9)} ${_benchPadN(r.resize_ms + 'ms', 8)} ${_benchPadN(_benchFmtMs1(r.paint_ms), 9)} ` +
                `${_benchPadN(totalWithPaint.toFixed(1) + 'ms', 9)}  ${r.note}`,
            );
        }
    }

    async function runJxlDecodeBench() {
        if (!IS_TAURI) {
            pushStat('[jxl-bench] Tauri-only — run inside the desktop app');
            return;
        }
        const defaultPath = 'C:\\995\\2026-01-09 Birthday at Cederberg\\P1100080.ORF';
        const path = prompt('JXL bench — ORF path to encode + decode:', defaultPath) || defaultPath;
        pushStat(`[jxl-bench] starting on ${path}`);
        const t0 = performance.now();
        let result;
        try {
            result = await invoke('bench_jxl_decode', { path });
        } catch (e) {
            pushStat(`[jxl-bench] FAILED: ${e?.message || e}`);
            return;
        }
        const wallMs = (performance.now() - t0).toFixed(0);
        pushStat(`[jxl-bench] wall ${wallMs} ms`);
        printBenchResult('jxl-bench', result);
        pushStat('[jxl-bench] done');
    }

    async function runJxlSweep() {
        if (!IS_TAURI) {
            pushStat('[jxl-sweep] Tauri-only — run inside the desktop app');
            return;
        }
        const defaultFolder = 'C:\\995\\2026-01-09 Birthday at Cederberg';
        const folder = prompt('JXL sweep — folder of ORFs:', defaultFolder) || defaultFolder;
        pushStat(`[jxl-sweep] starting on folder ${folder}`);
        const t0 = performance.now();
        const unlisten = await listen('bench_progress', ({ payload }) => {
            if (payload?.stage === 'sweep') pushStat(`[jxl-sweep] ${payload.msg}`);
        });
        let sweep;
        try {
            sweep = await invoke('bench_jxl_sweep', { folder });
        } catch (e) {
            pushStat(`[jxl-sweep] FAILED: ${e?.message || e}`);
            unlisten();
            return;
        }
        unlisten();
        const wallMs = (performance.now() - t0).toFixed(0);
        pushStat(`[jxl-sweep] ${sweep.per_image.length} images  wall ${wallMs} ms`);
        sweep.picks.forEach((p, i) => pushStat(`[jxl-sweep] pick ${i + 1}/${sweep.picks.length}  ${p}`));
        sweep.per_image.forEach((res, i) => {
            pushStat(`[jxl-sweep] ─── image ${i + 1}/${sweep.per_image.length} ───`);
            printBenchResult('jxl-sweep', res);
        });
        pushStat('[jxl-sweep] done');
    }

    async function runJxlStress() {
        if (!IS_TAURI) {
            pushStat('[jxl-stress] Tauri-only — run inside the desktop app');
            return;
        }
        const defaultFolder = 'C:\\995\\2026-01-09 Birthday at Cederberg';
        const folder = prompt('JXL stress — folder of ORFs:', defaultFolder) || defaultFolder;
        const sizes = [180, 480, 1080];
        const repeats = 3;
        pushStat(`[jxl-stress] starting on folder ${folder}  sizes ${sizes.join('/')}  repeats ${repeats}`);
        const t0 = performance.now();
        const unlisten = await listen('bench_progress', ({ payload }) => {
            if (payload?.stage === 'stress') pushStat(`[jxl-stress] ${payload.msg}`);
        });
        let stress;
        try {
            stress = await invoke('bench_jxl_stress', { folder, sizes, repeats });
        } catch (e) {
            pushStat(`[jxl-stress] FAILED: ${e?.message || e}`);
            unlisten();
            return;
        }
        unlisten();
        const wallMs = (performance.now() - t0).toFixed(0);
        pushStat(`[jxl-stress] picks=${stress.picks.length} sizes=${stress.sizes.length} repeats=${stress.repeats}  wall ${wallMs} ms`);
        stress.picks.forEach((p, i) => {
            const enc = stress.encode_ms_per_image[i];
            const sz = (stress.encoded_bytes_per_image[i] / 1024).toFixed(0);
            pushStat(`[jxl-stress] pick ${i + 1}  enc ${enc} ms  ${sz} KB  ${p}`);
        });

        pushStat(`[jxl-stress] ${_benchPad('image', 32)} ${_benchPad('lib', 11)} ${_benchPadN('size', 5)} ${_benchPadN('min', 8)} ${_benchPadN('mean', 8)} ${_benchPadN('p50', 8)} ${_benchPadN('p95', 8)} ${_benchPadN('max', 8)} ${_benchPadN('rs-mean', 9)} ${_benchPadN('total', 9)}`);
        const fmt = (v) => `${(v || 0).toFixed(1)}ms`;
        for (const r of stress.rows) {
            const name = r.source_path.split(/[\\/]/).pop();
            pushStat(
                `[jxl-stress] ${_benchPad(name, 32)} ${_benchPad(r.library, 11)} ${_benchPadN(r.target_long_edge, 5)} ` +
                `${_benchPadN(fmt(r.decode_min_ms), 8)} ${_benchPadN(fmt(r.decode_mean_ms), 8)} ${_benchPadN(fmt(r.decode_p50_ms), 8)} ` +
                `${_benchPadN(fmt(r.decode_p95_ms), 8)} ${_benchPadN(fmt(r.decode_max_ms), 8)} ` +
                `${_benchPadN(fmt(r.resize_mean_ms), 9)} ${_benchPadN(fmt(r.total_mean_ms), 9)}`,
            );
        }

        // Library × size aggregate across all picks (decode mean).
        const agg = new Map();
        for (const r of stress.rows) {
            const k = `${r.library}|${r.target_long_edge}`;
            if (!agg.has(k)) agg.set(k, { lib: r.library, size: r.target_long_edge, n: 0, decode: 0, resize: 0 });
            const a = agg.get(k);
            a.n += 1;
            a.decode += r.decode_mean_ms;
            a.resize += r.resize_mean_ms;
        }
        pushStat(`[jxl-stress] ─── aggregate (mean across ${stress.picks.length} images) ───`);
        for (const a of [...agg.values()].sort((x, y) => x.size - y.size || x.lib.localeCompare(y.lib))) {
            const d = a.decode / a.n;
            const rs = a.resize / a.n;
            pushStat(`[jxl-stress] ${_benchPad(a.lib, 11)} size ${_benchPadN(a.size, 5)}  decode ${fmt(d)}  resize ${fmt(rs)}  total ${fmt(d + rs)}`);
        }
        pushStat('[jxl-stress] done');
    }

    async function runJxlThumb() {
        if (!IS_TAURI) {
            pushStat('[jxl-thumb] Tauri-only — run inside the desktop app');
            return;
        }
        const defaultFolder = 'C:\\995\\2026-01-09 Birthday at Cederberg';
        const folder = prompt('JXL thumb bench — folder of ORFs:', defaultFolder) || defaultFolder;
        const quality = 95;
        const defaultOut = `C:\\foo\\raw-converter-tauri\\bench-output\\thumbs_q${quality}`;
        const outputDir = prompt('Output directory for thumb JXLs:', defaultOut) || defaultOut;
        const sizes = [150, 300, 640, 1080, 1920];
        const gallerySizes = [150, 300];
        const galleryCount = 100;
        const repeats = 3;
        const effort = 3;
        pushStat(`[jxl-thumb] starting  folder=${folder}  out=${outputDir}  sizes=${sizes.join('/')}  gallery=${gallerySizes.join('/')} ×${galleryCount}  reps=${repeats}  q=${quality}  e=${effort}`);
        const t0 = performance.now();
        const unlisten = await listen('bench_progress', ({ payload }) => {
            if (payload?.stage === 'thumb') pushStat(`[jxl-thumb] ${payload.msg}`);
        });
        let result;
        try {
            result = await invoke('bench_jxl_thumb', {
                folder,
                outputDir,
                sizes,
                gallerySizes,
                galleryCount,
                repeats,
                quality,
                effort,
            });
        } catch (e) {
            pushStat(`[jxl-thumb] FAILED: ${e?.message || e}`);
            unlisten();
            return;
        }
        unlisten();
        const wallMs = (performance.now() - t0).toFixed(0);
        pushStat(`[jxl-thumb] picks=${result.picks.length} sizes=${result.sizes.length}  wall ${wallMs} ms`);

        // Per-image per-size table.
        pushStat(`[jxl-thumb] ${_benchPad('image', 24)} ${_benchPadN('size', 5)} ${_benchPadN('wxh', 11)} ${_benchPadN('bytes', 8)} ${_benchPadN('enc', 7)} ${_benchPadN('libjxl', 9)} ${_benchPadN('oxide', 9)}`);
        for (const r of result.size_rows) {
            const name = r.source_path.split(/[\\/]/).pop();
            const dim = `${r.width}×${r.height}`;
            const kb = `${(r.encoded_bytes/1024).toFixed(1)}KB`;
            pushStat(
                `[jxl-thumb] ${_benchPad(name, 24)} ${_benchPadN(r.long_edge, 5)} ${_benchPadN(dim, 11)} ${_benchPadN(kb, 8)} ` +
                `${_benchPadN(r.encode_ms + 'ms', 7)} ${_benchPadN(r.libjxl_decode_mean_ms.toFixed(0) + 'ms', 9)} ${_benchPadN(r.oxide_decode_mean_ms.toFixed(0) + 'ms', 9)}`
            );
        }

        // Aggregate per size (mean across images).
        const sizeAgg = new Map();
        for (const r of result.size_rows) {
            const a = sizeAgg.get(r.long_edge) || { n: 0, bytes: 0, enc: 0, libjxl: 0, oxide: 0 };
            a.n += 1;
            a.bytes += r.encoded_bytes;
            a.enc += r.encode_ms;
            a.libjxl += r.libjxl_decode_mean_ms;
            a.oxide += r.oxide_decode_mean_ms;
            sizeAgg.set(r.long_edge, a);
        }
        pushStat(`[jxl-thumb] ─── per-size mean (across ${result.picks.length} images) ───`);
        for (const [size, a] of [...sizeAgg.entries()].sort((x, y) => x[0] - y[0])) {
            const kb = (a.bytes / a.n / 1024).toFixed(1);
            pushStat(`[jxl-thumb] size ${_benchPadN(size, 4)}  ${_benchPadN(kb + 'KB', 9)}  enc ${(a.enc/a.n).toFixed(0)}ms  libjxl ${(a.libjxl/a.n).toFixed(0)}ms  oxide ${(a.oxide/a.n).toFixed(0)}ms`);
        }

        // DC probe.
        pushStat(`[jxl-thumb] ─── DC-only probe (libjxl progressive flush) ───`);
        pushStat(`[jxl-thumb] ${_benchPad('image', 24)} ${_benchPadN('full-dec', 10)} ${_benchPadN('dc-dec', 10)} ${_benchPadN('speedup', 9)} note`);
        for (const r of result.dc_rows) {
            const name = r.source_path.split(/[\\/]/).pop();
            const full = `${r.libjxl_full_decode_ms}ms`;
            if (r.libjxl_dc_decode_ms != null) {
                const dc = `${r.libjxl_dc_decode_ms}ms`;
                const sp = (r.libjxl_full_decode_ms / Math.max(r.libjxl_dc_decode_ms, 1)).toFixed(1) + '×';
                pushStat(`[jxl-thumb] ${_benchPad(name, 24)} ${_benchPadN(full, 10)} ${_benchPadN(dc, 10)} ${_benchPadN(sp, 9)} ok`);
            } else {
                pushStat(`[jxl-thumb] ${_benchPad(name, 24)} ${_benchPadN(full, 10)} ${_benchPadN('—', 10)} ${_benchPadN('—', 9)} ${r.libjxl_dc_error || 'no DC stage'}`);
            }
        }

        // Gallery simulation.
        pushStat(`[jxl-thumb] ─── gallery simulation (${galleryCount} decodes, ${result.gallery_rows[0]?.unique_thumbs || 0} unique cycled) ───`);
        pushStat(`[jxl-thumb] ${_benchPadN('size', 5)} ${_benchPad('library', 11)} ${_benchPadN('total', 9)} ${_benchPadN('mean/dec', 11)}`);
        for (const r of result.gallery_rows) {
            pushStat(`[jxl-thumb] ${_benchPadN(r.long_edge, 5)} ${_benchPad(r.library, 11)} ${_benchPadN(r.total_ms + 'ms', 9)} ${_benchPadN(r.mean_per_decode_ms.toFixed(1) + 'ms', 11)}`);
        }
        pushStat('[jxl-thumb] done');
    }

    async function runJxlDisk() {
        if (!IS_TAURI) {
            pushStat('[jxl-disk] Tauri-only — run inside the desktop app');
            return;
        }
        const folder = prompt('JXL disk arch bench — source ORF folder:', 'C:\\995\\2026-01-09 Birthday at Cederberg') || 'C:\\995\\2026-01-09 Birthday at Cederberg';
        const workDir = prompt('Working directory for sidecar + bundle:', 'C:\\foo\\raw-converter-tauri\\bench-output\\disk') || 'C:\\foo\\raw-converter-tauri\\bench-output\\disk';
        const flushFile = prompt('Flush file path (will be created if absent):', 'C:\\foo\\raw-converter-tauri\\bench-output\\flush.bin') || 'C:\\foo\\raw-converter-tauri\\bench-output\\flush.bin';
        const flushGbStr = prompt('Flush file size in GB (set ≥ system RAM for reliable cold reads):', '20') || '20';
        const flushSizeGb = parseInt(flushGbStr, 10) || 20;
        const nStr = prompt('Number of test files (≤ folder size):', '50') || '50';
        const nFiles = parseInt(nStr, 10) || 50;

        pushStat(`[jxl-disk] starting  folder=${folder}  work=${workDir}  flush=${flushFile} (${flushSizeGb} GB)  n=${nFiles}`);
        const t0 = performance.now();
        const unlisten = await listen('bench_progress', ({ payload }) => {
            if (payload?.stage === 'disk') pushStat(`[jxl-disk] ${payload.msg}`);
        });
        let result;
        try {
            result = await invoke('bench_jxl_disk', {
                folder,
                workDir,
                flushFile,
                flushSizeGb,
                nFiles,
            });
        } catch (e) {
            pushStat(`[jxl-disk] FAILED: ${e?.message || e}`);
            unlisten();
            return;
        }
        unlisten();
        const wallMs = (performance.now() - t0).toFixed(0);
        pushStat(`[jxl-disk] setup ${result.setup_ms} ms  wall ${wallMs} ms`);
        pushStat(`[jxl-disk] ${_benchPad('arch', 18)} ${_benchPad('operation', 14)} ${_benchPadN('n', 4)} ${_benchPadN('read', 9)} ${_benchPadN('decode', 9)} ${_benchPadN('total', 9)} ${_benchPadN('mean/ea', 9)} ${_benchPadN('MB', 8)}`);
        for (const r of result.rows) {
            pushStat(
                `[jxl-disk] ${_benchPad(r.architecture, 18)} ${_benchPad(r.operation, 14)} ${_benchPadN(r.n_files, 4)} ` +
                `${_benchPadN(r.read_total_ms + 'ms', 9)} ${_benchPadN(r.decode_total_ms + 'ms', 9)} ${_benchPadN(r.total_ms + 'ms', 9)} ` +
                `${_benchPadN(r.mean_per_file_ms.toFixed(1) + 'ms', 9)} ${_benchPadN((r.bytes_read / 1024 / 1024).toFixed(1), 8)}`
            );
        }
        pushStat('[jxl-disk] done');
    }

    // ─── Wire buttons ───────────────────────────────────────────────────────────

    const benchBtn = document.getElementById('run-benchmark');
    if (benchBtn) {
        benchBtn.addEventListener('click', () => {
            benchBtn.disabled = true;
            runBenchmark().catch(e => pushStat(`[bench] ${e?.message || e}`))
                          .finally(() => { benchBtn.disabled = false; });
        });
    }

    const sweepBtn = document.getElementById('run-effort-sweep');
    if (sweepBtn) {
        sweepBtn.addEventListener('click', () => {
            sweepBtn.disabled = true;
            runEffortSweep().catch(e => pushStat(`[sweep] ${e?.message || e}`))
                            .finally(() => { sweepBtn.disabled = false; });
        });
    }

    const varBtn = document.getElementById('run-variance-bench');
    if (varBtn) {
        varBtn.addEventListener('click', () => {
            varBtn.disabled = true;
            runVarianceBench().catch(e => pushStat(`[var] ${e?.message || e}`))
                              .finally(() => { varBtn.disabled = false; });
        });
    }

    const qBtn = document.getElementById('run-quality-sweep');
    if (qBtn) {
        qBtn.addEventListener('click', () => {
            qBtn.disabled = true;
            runQualitySweep().catch(e => pushStat(`[q] ${e?.message || e}`))
                             .finally(() => { qBtn.disabled = false; });
        });
    }

    const jxlBenchBtn = document.getElementById('run-jxl-bench');
    if (jxlBenchBtn) {
        jxlBenchBtn.addEventListener('click', () => {
            jxlBenchBtn.disabled = true;
            runJxlDecodeBench().catch(e => pushStat(`[jxl-bench] ${e?.message || e}`))
                               .finally(() => { jxlBenchBtn.disabled = false; });
        });
    }

    const jxlSweepBtn = document.getElementById('run-jxl-sweep');
    if (jxlSweepBtn) {
        jxlSweepBtn.addEventListener('click', () => {
            jxlSweepBtn.disabled = true;
            runJxlSweep().catch(e => pushStat(`[jxl-sweep] ${e?.message || e}`))
                         .finally(() => { jxlSweepBtn.disabled = false; });
        });
    }

    const jxlStressBtn = document.getElementById('run-jxl-stress');
    if (jxlStressBtn) {
        jxlStressBtn.addEventListener('click', () => {
            jxlStressBtn.disabled = true;
            runJxlStress().catch(e => pushStat(`[jxl-stress] ${e?.message || e}`))
                          .finally(() => { jxlStressBtn.disabled = false; });
        });
    }

    const jxlThumbBtn = document.getElementById('run-jxl-thumb');
    if (jxlThumbBtn) {
        jxlThumbBtn.addEventListener('click', () => {
            jxlThumbBtn.disabled = true;
            runJxlThumb().catch(e => pushStat(`[jxl-thumb] ${e?.message || e}`))
                         .finally(() => { jxlThumbBtn.disabled = false; });
        });
    }

    const jxlDiskBtn = document.getElementById('run-jxl-disk');
    if (jxlDiskBtn) {
        jxlDiskBtn.addEventListener('click', () => {
            jxlDiskBtn.disabled = true;
            runJxlDisk().catch(e => pushStat(`[jxl-disk] ${e?.message || e}`))
                        .finally(() => { jxlDiskBtn.disabled = false; });
        });
    }
}
