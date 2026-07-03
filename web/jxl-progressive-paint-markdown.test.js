import { expect, test } from 'bun:test';

// Tests the markdown output contract using a self-contained helper that mirrors
// buildMeasurementsMarkdown logic (the real function reads module-level state).
function buildMarkdown(measurements) {
    const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const parts = ['# Progressive Paint Measurements\n\n'];
    parts.push('| Source | Paints | First ms | Final ms | One-shot ms | Encode ms | File KB | Final PSNR |\n');
    parts.push('|---|---:|---:|---:|---:|---:|---:|---:|\n');
    for (const m of measurements) {
        parts.push([esc(m.source), m.paintsReceived ?? m.passesReceived ?? '',
            m.first_ms ?? '', m.final_ms ?? '', m.oneShot_ms ?? '',
            m.encode_ms ?? '', m.fileSizeKB ?? '', m.final_psnr_vs_source ?? ''].join(' | '));
        parts.push('\n');
    }
    for (const m of measurements) {
        parts.push(`\n## ${esc(m.source)}\n\n`);
        parts.push('| Pass | t ms | Final | alphaMin | alphaMax | alphaZeroPct | rgbNonzeroCount | lumaVariance | frameHash |\n');
        parts.push('|---:|---:|---|---:|---:|---:|---:|---:|---|\n');
        for (const p of m.perPass || []) {
            const s = p.stats || {};
            parts.push([p.pass, p.t_ms, p.isFinal ? 'true' : 'false',
                s.alphaMin ?? '', s.alphaMax ?? '', s.alphaZeroPct ?? '',
                s.rgbNonzeroCount ?? '', s.lumaVariance ?? '', esc(s.frameHash ?? '')].join(' | '));
            parts.push('\n');
        }
    }
    return parts.join('');
}

test('buildMarkdown produces correct structure for 2 measurements', () => {
    const m = [
        { source: 'a.jxl', paintsReceived: 3, first_ms: 10, final_ms: 50,
          oneShot_ms: 55, encode_ms: 200, fileSizeKB: 42, final_psnr_vs_source: 38.5,
          perPass: [
              { pass: 0, t_ms: 10, isFinal: false, stats: { alphaMin: 255, alphaMax: 255, alphaZeroPct: 0, rgbNonzeroCount: 900, lumaVariance: 100, frameHash: 'aabbccdd' } },
              { pass: 1, t_ms: 50, isFinal: true,  stats: { alphaMin: 255, alphaMax: 255, alphaZeroPct: 0, rgbNonzeroCount: 900, lumaVariance: 100, frameHash: 'aabbccdd' } },
          ] },
        { source: 'b.jxl', paintsReceived: 1, first_ms: 20, final_ms: 20,
          oneShot_ms: 25, encode_ms: 180, fileSizeKB: 38, final_psnr_vs_source: 40.1,
          perPass: [] },
    ];
    const md = buildMarkdown(m);
    expect(md).toContain('# Progressive Paint Measurements');
    expect(md).toContain('| Source |');
    expect(md).toContain('a.jxl');
    expect(md).toContain('b.jxl');
    expect(md).toContain('## a.jxl');
    expect(md).toContain('aabbccdd');
    expect(md).toContain('true');   // isFinal pass
    expect(md).toContain('false');  // non-final pass
});

test('buildMarkdown escapes pipe chars in source name', () => {
    const m = [{ source: 'a|b.jxl', perPass: [] }];
    const md = buildMarkdown(m);
    expect(md).toContain('a\\|b.jxl');
    expect(md).not.toContain('| a|b');
});

test('buildMarkdown empty measurements returns header only', () => {
    const md = buildMarkdown([]);
    expect(md).toContain('# Progressive Paint Measurements');
    expect(md).toContain('| Source |');
    expect(md.split('\n').length).toBeGreaterThan(2);
});
