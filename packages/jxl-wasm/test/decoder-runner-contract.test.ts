import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const bridge = readFileSync(new URL('../src/bridge.cpp', import.meta.url), 'utf8');
const build = readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8');

test('decoder runner width is an explicit build contract', () => {
  expect(build).toContain('JXL_WASM_DEC_RUNNER_WORKERS');
  expect(build).toContain('-DJXL_WASM_DEC_RUNNER_WORKERS=');
  expect(bridge).toContain('DecoderRunnerWorkerCount');
  expect(bridge).toContain('JXL_WASM_DEC_RUNNER_WORKERS');
});

test('decoder runner experiment accepts only measured worker counts', () => {
  expect(build).toContain('new Set([\'0\', \'1\', \'2\', \'4\'])');
  expect(build).toContain('JXL_WASM_DEC_RUNNER_WORKERS must be 0, 1, 2, or 4');
});
