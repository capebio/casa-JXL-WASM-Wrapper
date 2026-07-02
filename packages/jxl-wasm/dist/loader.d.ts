export interface JxlWasmManifest {
    buildId: string;
    wasmSha: string;
    wasmUrl?: string;
}
export interface LoaderOptions {
    fetchImpl?: typeof fetch;
    idbFactory?: IDBFactory;
    nodeFs?: {
        readFile(path: string | URL, options?: {
            signal?: AbortSignal;
        }): Promise<Uint8Array>;
    };
    cacheDbName?: string;
    wasmUrl?: string;
    signal?: AbortSignal;
    priority?: 'high' | 'low' | 'auto';
}
export declare function loadJxlModule(manifest: JxlWasmManifest, options?: LoaderOptions): Promise<WebAssembly.Module>;
//# sourceMappingURL=loader.d.ts.map