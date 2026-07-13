export interface JxlWasmManifest {
  buildId: string;
  wasmSha: string;
  wasmUrl?: string;
}

export interface LoaderOptions {
  fetchImpl?: typeof fetch;
  idbFactory?: IDBFactory;
  nodeFs?: { readFile(path: string | URL, options?: { signal?: AbortSignal }): Promise<Uint8Array> };
  cacheDbName?: string;
  wasmUrl?: string;
  signal?: AbortSignal;
  priority?: 'high' | 'low' | 'auto';
}

const nodeCache = new Map<string, Promise<WebAssembly.Module>>();
// P5-1: browser-side module-scope promise memo (per buildId:wasmSha).
// Avoids repeated IDB open+get per call (e.g. worker spawn, multiple handlers).
// IDB remains the persistence/cold-start layer; this is hot-path memo only.
const browserModuleCache = new Map<string, Promise<WebAssembly.Module>>();

export async function loadJxlModule(manifest: JxlWasmManifest, options: LoaderOptions = {}): Promise<WebAssembly.Module> {
  const cacheKey = `${manifest.buildId}:${manifest.wasmSha}`;
  if (!manifest?.buildId || typeof manifest.buildId !== 'string' ||
      !manifest?.wasmSha || typeof manifest.wasmSha !== 'string') {
    throw new Error('[jxl-wasm] manifest requires buildId and wasmSha strings');
  }
  if (isNode()) {
    if (!nodeCache.has(cacheKey)) {
      const p = loadNodeModule(manifest, options).catch((e) => {
        nodeCache.delete(cacheKey);
        throw e;
      });
      nodeCache.set(cacheKey, p);
    }
    return nodeCache.get(cacheKey)!;
  }
  if (!browserModuleCache.has(cacheKey)) {
    const p = loadBrowserModule(manifest, options).catch((e) => {
      browserModuleCache.delete(cacheKey);
      throw e;
    });
    browserModuleCache.set(cacheKey, p);
  }
  return browserModuleCache.get(cacheKey)!;
}

async function loadNodeModule(manifest: JxlWasmManifest, options: LoaderOptions): Promise<WebAssembly.Module> {
  const fs = options.nodeFs ?? (await import("node:fs/promises"));
  const wasmUrl = options.wasmUrl ?? manifest.wasmUrl;
  const bytes = await fs.readFile(await resolveNodeWasmUrl(wasmUrl ?? ""), { ...(options.signal ? { signal: options.signal } : {}) });
  return WebAssembly.compile(bytes as BufferSource);
}

async function loadBrowserModule(manifest: JxlWasmManifest, options: LoaderOptions): Promise<WebAssembly.Module> {
  const key = `${manifest.buildId}:${manifest.wasmSha}`;
  const cached = await readIndexedDbModule(key, options);
  if (cached) {
    return cached;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const wasmUrl = options.wasmUrl ?? manifest.wasmUrl;
  if (!wasmUrl) {
    throw new Error("jxl-wasm loader needs wasmUrl in browser");
  }
  const response = await fetchImpl(wasmUrl, {
    signal: options.signal,
    priority: options.priority,
  } as RequestInit);
  // P5-2: pass a refetcher so compile can re-fetch on rare streaming fallback instead of .clone() (avoids doubling 2.7 MB peak mem).
  const module = await compileFromResponse(response, () => fetchImpl(wasmUrl));
  writeIndexedDbModule(key, module, options).catch(() => {
    /* best-effort; proceed without IDB persistence (quota/incognito) */
  });
  return module;
}

async function compileFromResponse(response: Response, getFreshResponse?: () => Promise<Response>): Promise<WebAssembly.Module> {
  if ("compileStreaming" in WebAssembly && response.body) {
    try {
      // Direct use (no .clone() tee). On failure the body is spent; caller-provided refetcher gets a fresh one.
      return await WebAssembly.compileStreaming(response);
    } catch {
      // Rare fallback (platform rejected streaming shape): re-fetch instead of paying clone memory for the common case.
      if (getFreshResponse) {
        const fresh = await getFreshResponse();
        return WebAssembly.compile(await fresh.arrayBuffer());
      }
      // No refetcher provided and compileStreaming failed; body is spent.
      throw new Error('[jxl-wasm] compileStreaming failed and no refetcher was provided to recover');
    }
  }
  return WebAssembly.compile(await response.arrayBuffer());
}

async function readIndexedDbModule(key: string, options: LoaderOptions): Promise<WebAssembly.Module | undefined> {
  const factory = options.idbFactory ?? globalThis.indexedDB;
  if (!factory) {
    return undefined;
  }
  const db = await openCacheDb(factory, options.cacheDbName ?? "jxl-wasm-module-cache");
  try {
    const tx = db.transaction("modules", "readonly");
    const record = await requestToPromise(tx.objectStore("modules").get(key));
    return record?.module instanceof WebAssembly.Module ? record.module : undefined;
  } finally {
    db.close();
  }
}

async function writeIndexedDbModule(key: string, module: WebAssembly.Module, options: LoaderOptions): Promise<void> {
  const factory = options.idbFactory ?? globalThis.indexedDB;
  if (!factory) {
    return;
  }
  const db = await openCacheDb(factory, options.cacheDbName ?? "jxl-wasm-module-cache");
  try {
    const tx = db.transaction("modules", "readwrite");
    await requestToPromise(tx.objectStore("modules").put({ key, module }));
    await txComplete(tx);
  } finally {
    db.close();
  }
}

async function openCacheDb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const request = factory.open(name, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore("modules", { keyPath: "key" });
  };
  return requestToPromise(request);
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function isNode(): boolean {
  return typeof process !== "undefined" && !!process.versions?.node && typeof window === "undefined";
}

async function resolveNodeWasmUrl(wasmUrl: string): Promise<string> {
  if (!wasmUrl) {
    throw new Error("jxl-wasm loader needs wasmUrl in Node");
  }
  if (!wasmUrl.startsWith("file://")) {
    return wasmUrl;
  }
  const { fileURLToPath } = await import("node:url");
  return fileURLToPath(wasmUrl);
}
