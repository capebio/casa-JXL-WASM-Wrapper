import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTiersFromOffsets } from "../src/progressive-manifest.js";
// K2: buildTiersFromOffsets maps encoder-derived progressive pass boundaries (the
// byte-exact `VariantSet.full_offsets` from raw-pipeline) into manifest tiers.
describe("buildTiersFromOffsets", () => {
    it("emits dc + preview + full from a multi-pass stream", () => {
        // dc=100, ac1=300, ac2=900, full=1000; 0.7*1000=700 → preview = ac2? no, 900>700.
        // preview = last offset <=700 strictly between dc and full → 300 (ac1).
        const tiers = buildTiersFromOffsets([100, 300, 900, 1000]);
        assert.deepEqual(tiers.map((t) => [t.name, t.byteEnd, t.progressionIndex]), [
            ["dc", 100, 0],
            ["preview", 300, 1],
            ["full", 1000, "final"],
        ]);
        // Cumulative prefixes: byteStart always 0, byteEnd strictly ascending.
        assert.ok(tiers.every((t) => t.byteStart === 0));
        for (let i = 1; i < tiers.length; i++)
            assert.ok(tiers[i].byteEnd > tiers[i - 1].byteEnd);
        assert.equal(tiers.at(-1).byteEnd, 1000);
    });
    it("omits preview when only dc + full exist", () => {
        const tiers = buildTiersFromOffsets([120, 1000]);
        assert.deepEqual(tiers.map((t) => t.name), ["dc", "full"]);
    });
    it("omits preview when every middle pass is above the 70% threshold", () => {
        // dc=100, ac1=800 (>700), full=1000 → no preview tier.
        const tiers = buildTiersFromOffsets([100, 800, 1000]);
        assert.deepEqual(tiers.map((t) => t.name), ["dc", "full"]);
    });
    it("rejects non-ascending or too-short offsets", () => {
        assert.throws(() => buildTiersFromOffsets([500]), /need >=2/);
        assert.throws(() => buildTiersFromOffsets([100, 100, 200]), /strictly ascending/);
        assert.throws(() => buildTiersFromOffsets([300, 200]), /strictly ascending/);
    });
});
//# sourceMappingURL=offsets-tiers.test.js.map