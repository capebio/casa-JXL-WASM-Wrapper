import { type Backends } from "./ingest.js";
export interface CollectedInput {
    path: string;
    stat: {
        size: number;
        mtimeMs: number;
    };
    format: string | null;
}
export declare function collectInputs(roots: readonly string[]): Promise<CollectedInput[]>;
export declare function main(argv: string[], backendsOverride?: Backends): Promise<number>;
//# sourceMappingURL=cli.d.ts.map