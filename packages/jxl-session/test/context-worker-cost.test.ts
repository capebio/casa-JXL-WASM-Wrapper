import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultCoreBudgetCapacity } from '@casabio/jxl-scheduler';
import {
  DECODER_MT_WORKER_COST,
  computeWorkerCostForWasmUrl,
} from '../src/context-base.js';

describe('decoder worker cost', () => {
  it('matches the measured decoder runner width', () => {
    assert.equal(DECODER_MT_WORKER_COST, 4);
    assert.equal(
      computeWorkerCostForWasmUrl('/worker.js?jxlWorkerTier=simd-mt'),
      Math.min(defaultCoreBudgetCapacity(), DECODER_MT_WORKER_COST),
    );
    assert.equal(
      computeWorkerCostForWasmUrl('/worker.js?jxlWorkerTier=relaxed-simd-mt'),
      Math.min(defaultCoreBudgetCapacity(), DECODER_MT_WORKER_COST),
    );
  });

  it('keeps single-threaded and malformed URLs at one token', () => {
    assert.equal(computeWorkerCostForWasmUrl('/worker.js?jxlWorkerTier=simd'), 1);
    assert.equal(computeWorkerCostForWasmUrl('http://['), 1);
    assert.equal(computeWorkerCostForWasmUrl(undefined), 1);
  });
});
