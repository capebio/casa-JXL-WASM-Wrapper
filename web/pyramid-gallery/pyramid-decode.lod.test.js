import { expect, test, describe } from 'bun:test';
import { readFileSync } from 'node:fs';

// Task 6: pyramid-decode gains a resolution-dispatch helper so a consumer can hand it a
// resolveLod() result + the fetched bytes and get pixels back, routing each delivery kind to the
// RIGHT existing decode path (whole-level → session decode, jxtc-ranges → tile-container region
// decode, progressive-prefix → whole/prefix decode). We assert on the dispatch contract via
// source (the concrete decode calls pull in real WASM, exercised elsewhere).

const decodeJs = readFileSync(new URL('./pyramid-decode.js', import.meta.url), 'utf8');

describe('decodeResolvedLod dispatch', () => {
  test('exports a decodeResolvedLod that branches on resolution.kind', () => {
    expect(decodeJs).toContain('export async function decodeResolvedLod');
    // Handles all three kinds by name.
    expect(decodeJs).toContain("'whole-level'");
    expect(decodeJs).toContain("'jxtc-ranges'");
    expect(decodeJs).toContain("'progressive-prefix'");
  });

  test('reuses the existing decode functions, not a new decoder', () => {
    // whole-level and progressive-prefix reuse decodePyramidLevel; jxtc-ranges reuses the
    // tile-container region decode (decodePyramidRegion / tiled path).
    const dispatchStart = decodeJs.indexOf('export async function decodeResolvedLod');
    const dispatch = decodeJs.slice(dispatchStart);
    expect(dispatch).toContain('decodePyramidLevel');
    expect(dispatch).toMatch(/decodePyramidRegion|decodeTileContainerRegion/);
  });
});
