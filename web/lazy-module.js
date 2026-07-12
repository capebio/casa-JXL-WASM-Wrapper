/**
 * makeLazyModule — one-time memoised async initialiser factory.
 *
 * Finding 47 (P4 T8): optional modules in main.js are loaded dynamically on
 * first use via this helper rather than statically at parse time. Properties:
 *
 *  - Factory is called at most once (across concurrent callers).
 *  - On failure the resolved promise is discarded so the next call retries.
 *  - The settled module object is returned by reference on every subsequent
 *    call, preserving any mutations the caller makes to it.
 *
 * Usage:
 *   const lazyPerceptual = makeLazyModule(() => import('./perceptual-color.mjs'));
 *   // On first use:
 *   const { applyLens } = await lazyPerceptual();
 *
 * @param {() => Promise<T>} factory  Async factory — typically `() => import('...')`.
 * @returns {() => Promise<T>}
 * @template T
 */
export function makeLazyModule(factory) {
    /** @type {Promise<T> | null} */
    let pending = null;

    return function lazyInit() {
        if (pending !== null) return pending;
        pending = factory().catch((err) => {
            // Clear so the next call retries — transient failures are not memoised.
            pending = null;
            throw err;
        });
        return pending;
    };
}
