/** Pure, filesystem-free additive migration of a raw manifest object to schema 5. */
export declare function migrateManifestToV5(raw: any): any;
export interface MigrationReport {
    migrated: number;
    skipped: number;
    errors: Array<{
        path: string;
        error: string;
    }>;
}
export declare function migrateSchema(outDir: string, targetVersion: number, opts?: {
    dryRun?: boolean;
}): Promise<MigrationReport>;
export declare function migrateLayout(outDir: string, target: "sharded-2", opts?: {
    dryRun?: boolean;
}): Promise<MigrationReport>;
//# sourceMappingURL=migrate.d.ts.map