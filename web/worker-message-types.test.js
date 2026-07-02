import { expect, test } from 'bun:test';
import { WorkerMsg } from './worker-message-types.js';

// The shared module is correct-by-construction only if its VALUES exactly match
// the on-the-wire strings worker.js and main.js previously hard-coded. These
// assertions pin every value so a future rename can't silently desync one side.
test('WorkerMsg carries the exact RAW-worker protocol strings', () => {
    expect(WorkerMsg.RELEASE_STATE).toBe('release_state');
    expect(WorkerMsg.REPROCESS_LIVE).toBe('reprocess_live');
    expect(WorkerMsg.REPROCESS_THUMB_LIVE).toBe('reprocess_thumb_live');
    expect(WorkerMsg.CANCEL).toBe('cancel');
    expect(WorkerMsg.PRELOAD).toBe('preload');
    expect(WorkerMsg.THUMB).toBe('thumb');
    expect(WorkerMsg.LIGHTBOX).toBe('lightbox');
    expect(WorkerMsg.LIGHTBOX_LIVE).toBe('lightbox_live');
    expect(WorkerMsg.THUMB_LIVE).toBe('thumb_live');
    expect(WorkerMsg.ERROR_LIVE).toBe('error_live');
    expect(WorkerMsg.ENCODE_REQUEST).toBe('encode_request');
    expect(WorkerMsg.DONE).toBe('done');
    expect(WorkerMsg.ERROR).toBe('error');
});

test('WorkerMsg is frozen so identifiers cannot drift at runtime', () => {
    expect(Object.isFrozen(WorkerMsg)).toBe(true);
});

test('all WorkerMsg values are unique', () => {
    const values = Object.values(WorkerMsg);
    expect(new Set(values).size).toBe(values.length);
});
