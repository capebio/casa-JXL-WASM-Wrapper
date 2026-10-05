import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const indexHtml = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const progressiveHtml = readFileSync(new URL('./jxl-progressive.html', import.meta.url), 'utf8');
const wrapperHtml = readFileSync(new URL('./jxl-wrapper-lab.html', import.meta.url), 'utf8');
const homeBarCss = readFileSync(new URL('./test-nav.css', import.meta.url), 'utf8');

test('every test page exposes the shared home bar', () => {
    expect(indexHtml).toContain('class="home-bar"');
    expect(progressiveHtml).toContain('class="home-bar"');
    expect(wrapperHtml).toContain('class="home-bar"');
    expect(indexHtml).toContain('href="./jxl-progressive.html"');
    expect(indexHtml).toContain('href="./jxl-wrapper-lab.html"');
    expect(progressiveHtml).toContain('href="./index.html"');
    expect(wrapperHtml).toContain('href="./index.html"');
    expect(homeBarCss).toContain('--home-bar-height: 46px;');
    expect(homeBarCss).toContain('.home-bar-link.is-active');
});

test('page headings say what the pages do', () => {
    // updated: index.html h1 reworded for LibRaw ingest of any camera RAW (65f5042f)
    expect(indexHtml).toContain('RAW camera files to JPEG XL browser test bench');
    expect(indexHtml).toContain('Encode, benchmark, and inspect timing across the browser pipeline.');
    expect(progressiveHtml).toContain('JPEG XL progressive decode test bench');
    expect(wrapperHtml).toContain('JPEG XL wrapper test lab');
    expect(wrapperHtml).toContain('Session worker routes JPEG XL through the browser session stack');
});
