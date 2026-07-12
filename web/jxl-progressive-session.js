export function createProgressiveSession({
    initialBackend = 'libjxl',
    initialEncodeBackend,
    initialDecodeBackend,
    loadSource,
    policy, // optional { encodeBackendForTarget(w, h) } for size-aware choice (see jxl-progressive-policy)
    // Task 6 (finding 2): an OPTIONAL resolved-LOD demand ({ targetLongEdge, dpr, region?, quality? })
    // the progressive-prefix path attaches so it can REUSE this session (its cached source +
    // backend switching) instead of recreating one. It is state carried alongside the session; it
    // does NOT drive loadSource/ensureSource control flow (source loading is unchanged).
    lodRequest = null,
}) {
    if (typeof loadSource !== 'function') {
        throw new TypeError('createProgressiveSession requires a loadSource function');
    }

    let encodeBackend = initialEncodeBackend ?? initialBackend;
    let decodeBackend = initialDecodeBackend ?? initialBackend;
    let currentLodRequest = lodRequest;
    let sourceRecord = null;
    let sourcePromise = null;

    function cacheSource(promise) {
        sourcePromise = promise.then((source) => {
            sourceRecord = source;
            return source;
        });
        return sourcePromise;
    }

    return {
        get backend() {
            return encodeBackend;
        },
        get encodeBackend() {
            return encodeBackend;
        },
        get decodeBackend() {
            return decodeBackend;
        },
        get source() {
            return sourceRecord;
        },
        // The resolved-LOD demand carried by this session (or null). Read by the progressive-prefix
        // path to decide which byte prefix to Range-fetch; does not affect source loading.
        get lodRequest() {
            return currentLodRequest;
        },
        setLodRequest(next) {
            currentLodRequest = next ?? null;
        },
        setBackend(nextBackend) {
            encodeBackend = nextBackend;
            decodeBackend = nextBackend;
        },
        setEncodeBackend(nextBackend) {
            encodeBackend = nextBackend;
        },
        setDecodeBackend(nextBackend) {
            decodeBackend = nextBackend;
        },
        chooseEncodeBackend(width, height) {
            if (policy && typeof policy.encodeBackendForTarget === 'function' &&
                Number.isFinite(width) && Number.isFinite(height)) {
                return policy.encodeBackendForTarget(encodeBackend, width, height);
            }
            return encodeBackend;
        },
        async ensureSource() {
            if (sourceRecord) return sourceRecord;
            if (!sourcePromise) cacheSource(Promise.resolve().then(loadSource));
            return sourcePromise;
        },
        async reloadSource() {
            sourceRecord = null;
            return cacheSource(Promise.resolve().then(loadSource));
        },
        clearSource() {
            sourceRecord = null;
            sourcePromise = null;
        },
    };
}
