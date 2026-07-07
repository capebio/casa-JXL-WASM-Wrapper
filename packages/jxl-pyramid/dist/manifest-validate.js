// manifest-validate.ts
// Hand-rolled runtime validation for PyramidManifest and GalleryIndex.
// Types-only import from manifest.ts — no zod dependency.
export const MANIFEST_SCHEMA_VERSION = 2;
export const INDEX_SCHEMA_VERSION = 1;
// Upper bounds for security/sanity checks
const MAX_DIMENSION = 1 << 24; // 16777216 — matches libjxl JXTC header caps
const MAX_BYTES = 1 << 30; // 1073741824 — 1 GiB safety cap
const MAX_TILE_SIZE = 1 << 16; // 65536 — reasonable tile limit
// Opaque-dict sanitization caps
const MAX_OPAQUE_KEYS = 64;
const MAX_OPAQUE_DEPTH = 4;
const MAX_OPAQUE_KEY_LENGTH = 128;
export class ManifestValidationError extends Error {
    path;
    constructor(message, path) {
        super(`${path}: ${message}`);
        this.path = path;
        this.name = "ManifestValidationError";
    }
}
function fail(path, msg) {
    throw new ManifestValidationError(msg, path);
}
function requireString(v, path) {
    if (typeof v !== "string")
        fail(path, `expected string, got ${typeof v}`);
    return v;
}
function requireNumber(v, path) {
    if (typeof v !== "number" || !isFinite(v))
        fail(path, `expected finite number, got ${JSON.stringify(v)}`);
    return v;
}
function requireBoolean(v, path) {
    if (typeof v !== "boolean")
        fail(path, `expected boolean, got ${typeof v}`);
    return v;
}
function requireObject(v, path) {
    if (v == null || typeof v !== "object" || Array.isArray(v))
        fail(path, `expected object, got ${Array.isArray(v) ? "array" : typeof v}`);
    return v;
}
function requireArray(v, path) {
    if (!Array.isArray(v))
        fail(path, `expected array, got ${typeof v}`);
    return v;
}
function sanitizeOpaqueObject(v, path, depth = 0) {
    if (depth > MAX_OPAQUE_DEPTH)
        fail(path, `opaque object exceeds maximum nesting depth ${MAX_OPAQUE_DEPTH}`);
    const keys = Object.keys(v);
    if (keys.length > MAX_OPAQUE_KEYS)
        fail(path, `opaque object exceeds maximum key count ${MAX_OPAQUE_KEYS}, got ${keys.length}`);
    const out = Object.create(null);
    for (const k of keys) {
        if (k.length > MAX_OPAQUE_KEY_LENGTH)
            fail(path, `key "${k.slice(0, 32)}…" exceeds maximum length ${MAX_OPAQUE_KEY_LENGTH}`);
        const child = v[k];
        if (child !== null && typeof child === "object" && !Array.isArray(child)) {
            out[k] = sanitizeOpaqueObject(child, `${path}.${k}`, depth + 1);
        }
        else {
            out[k] = child;
        }
    }
    return out;
}
function validateMasterMetadata(v, path) {
    const o = requireObject(v, path);
    const name = requireString(o["name"], `${path}.name`);
    if (name.length === 0)
        fail(`${path}.name`, "must not be empty");
    if (name.length > 256)
        fail(`${path}.name`, `exceeds maximum length 256`);
    if (/[/\\:]/.test(name))
        fail(`${path}.name`, "must not contain path separators");
    const format = requireString(o["format"], `${path}.format`);
    if (!["orf", "dng", "cr2", "jpg"].includes(format)) {
        fail(`${path}.format`, `unknown format "${format}"`);
    }
    const mtimeMs = requireNumber(o["mtimeMs"], `${path}.mtimeMs`);
    const result = { name, format: format, mtimeMs };
    if (o["sizeBytes"] !== undefined)
        result.sizeBytes = requireNumber(o["sizeBytes"], `${path}.sizeBytes`);
    return result;
}
/** S6 (additive): validate an optional LodCapabilities bag — object of optional booleans. */
function validateCapabilities(v, path) {
    const o = requireObject(v, path);
    const result = {};
    for (const k of ["quality", "resolution", "region"]) {
        if (o[k] !== undefined)
            result[k] = requireBoolean(o[k], `${path}.${k}`);
    }
    return result;
}
function validateProducedBy(v, path) {
    const o = requireObject(v, path);
    const tool = requireString(o["tool"], `${path}.tool`);
    const version = requireString(o["version"], `${path}.version`);
    const result = { tool, version };
    if (o["params"] !== undefined) {
        result.params = sanitizeOpaqueObject(requireObject(o["params"], `${path}.params`), `${path}.params`);
    }
    return result;
}
function validateLevel(v, path) {
    const o = requireObject(v, path);
    const size = o["size"];
    if (size !== "full" && (typeof size !== "number" || !isFinite(size) || size <= 0)) {
        fail(`${path}.size`, `expected positive number or "full", got ${JSON.stringify(size)}`);
    }
    const w = requireNumber(o["w"], `${path}.w`);
    const h = requireNumber(o["h"], `${path}.h`);
    const bytes = requireNumber(o["bytes"], `${path}.bytes`);
    if (w <= 0)
        fail(`${path}.w`, `width must be positive, got ${w}`);
    if (w > MAX_DIMENSION)
        fail(`${path}.w`, `width exceeds maximum ${MAX_DIMENSION}, got ${w}`);
    if (h <= 0)
        fail(`${path}.h`, `height must be positive, got ${h}`);
    if (h > MAX_DIMENSION)
        fail(`${path}.h`, `height exceeds maximum ${MAX_DIMENSION}, got ${h}`);
    if (bytes <= 0)
        fail(`${path}.bytes`, `bytes must be positive, got ${bytes}`);
    if (bytes > MAX_BYTES)
        fail(`${path}.bytes`, `bytes exceeds maximum ${MAX_BYTES}, got ${bytes}`);
    const bitsPerSample = requireNumber(o["bitsPerSample"], `${path}.bitsPerSample`);
    if (bitsPerSample !== 8 && bitsPerSample !== 16) {
        fail(`${path}.bitsPerSample`, `expected 8 or 16, got ${bitsPerSample}`);
    }
    const contenthash = requireString(o["contenthash"], `${path}.contenthash`);
    if (contenthash.length === 0)
        fail(`${path}.contenthash`, "must not be empty");
    const tiled = requireBoolean(o["tiled"], `${path}.tiled`);
    if (!/^[a-fA-F0-9]+$/.test(contenthash))
        fail(`${path}.contenthash`, `must be hexadecimal, got "${contenthash}"`);
    const level = {
        size: size,
        w, h, bytes,
        bitsPerSample: bitsPerSample,
        contenthash,
        tiled,
    };
    if (tiled) {
        if (o["tiling"] == null)
            fail(`${path}.tiling`, "required when tiled=true");
        const t = requireObject(o["tiling"], `${path}.tiling`);
        const tileSize = requireNumber(t["tileSize"], `${path}.tiling.tileSize`);
        const cols = requireNumber(t["cols"], `${path}.tiling.cols`);
        const rows = requireNumber(t["rows"], `${path}.tiling.rows`);
        if (tileSize <= 0)
            fail(`${path}.tiling.tileSize`, `tileSize must be positive, got ${tileSize}`);
        if (tileSize > MAX_TILE_SIZE)
            fail(`${path}.tiling.tileSize`, `tileSize exceeds maximum ${MAX_TILE_SIZE}, got ${tileSize}`);
        if (cols <= 0)
            fail(`${path}.tiling.cols`, `cols must be positive, got ${cols}`);
        if (cols > MAX_DIMENSION)
            fail(`${path}.tiling.cols`, `cols exceeds maximum ${MAX_DIMENSION}, got ${cols}`);
        if (rows <= 0)
            fail(`${path}.tiling.rows`, `rows must be positive, got ${rows}`);
        if (rows > MAX_DIMENSION)
            fail(`${path}.tiling.rows`, `rows exceeds maximum ${MAX_DIMENSION}, got ${rows}`);
        if (cols !== Math.ceil(w / tileSize))
            fail(`${path}.tiling.cols`, `cols ${cols} does not match ceil(${w}/${tileSize}) = ${Math.ceil(w / tileSize)}`);
        if (rows !== Math.ceil(h / tileSize))
            fail(`${path}.tiling.rows`, `rows ${rows} does not match ceil(${h}/${tileSize}) = ${Math.ceil(h / tileSize)}`);
        level.tiling = {
            tileSize,
            cols,
            rows,
        };
    }
    if (o["convergedByteEnd"] !== undefined) {
        const cbe = requireNumber(o["convergedByteEnd"], `${path}.convergedByteEnd`);
        if (cbe >= bytes)
            fail(`${path}.convergedByteEnd`, `${cbe} must be less than bytes ${bytes}`);
        level.convergedByteEnd = cbe;
    }
    if (o["qualityCurve"] !== undefined) {
        const arr = requireArray(o["qualityCurve"], `${path}.qualityCurve`);
        level.qualityCurve = arr.map((pt, i) => {
            const p = requireObject(pt, `${path}.qualityCurve[${i}]`);
            const ptBytes = requireNumber(p["bytes"], `${path}.qualityCurve[${i}].bytes`);
            const point = { bytes: ptBytes };
            if (p["ssim"] !== undefined)
                point.ssim = requireNumber(p["ssim"], `${path}.qualityCurve[${i}].ssim`);
            if (p["butteraugli"] !== undefined)
                point.butteraugli = requireNumber(p["butteraugli"], `${path}.qualityCurve[${i}].butteraugli`);
            return point;
        });
    }
    if (o["capabilities"] !== undefined) {
        level.capabilities = validateCapabilities(o["capabilities"], `${path}.capabilities`);
    }
    return level;
}
/**
 * Accepts schema 1|2 (normalizes 1 → 2 defaults: stub=false, proxy=false).
 * Throws ManifestValidationError on schema > 2 or missing/invalid fields.
 */
export function parsePyramidManifest(json) {
    const o = requireObject(json, "manifest");
    const schema = requireNumber(o["schema"], "manifest.schema");
    if (schema > MANIFEST_SCHEMA_VERSION) {
        fail("manifest.schema", `schema ${schema} is newer than reader (max ${MANIFEST_SCHEMA_VERSION}); upgrade the reader`);
    }
    if (schema < 1) {
        fail("manifest.schema", `unsupported schema version ${schema}`);
    }
    const imageId = requireString(o["imageId"], "manifest.imageId");
    const master = validateMasterMetadata(o["master"], "manifest.master");
    const orientation = requireString(o["orientation"], "manifest.orientation");
    if (orientation !== "baked" && orientation !== "source") {
        fail("manifest.orientation", `expected "baked" or "source", got "${orientation}"`);
    }
    const width = requireNumber(o["width"], "manifest.width");
    const height = requireNumber(o["height"], "manifest.height");
    const aspect = requireNumber(o["aspect"], "manifest.aspect");
    if (height <= 0)
        fail("manifest.height", `height must be positive, got ${height}`);
    if (Math.abs(aspect - width / height) > 1e-3) {
        fail("manifest.aspect", `aspect ${aspect} inconsistent with width/height ratio ${width}/${height} = ${(width / height).toFixed(6)}`);
    }
    const levelsRaw = requireArray(o["levels"], "manifest.levels");
    if (levelsRaw.length === 0)
        fail("manifest.levels", "must not be empty");
    const levels = levelsRaw.map((l, i) => validateLevel(l, `manifest.levels[${i}]`));
    // Sizes must be strictly ascending numerically, with "full" last.
    for (let i = 1; i < levels.length; i++) {
        const prev = levels[i - 1].size;
        const curr = levels[i].size;
        if (prev === "full") {
            // "full" at i-1 means i-1 was not the last — report at the "full" level's path
            fail(`manifest.levels[${i - 1}].size`, `"full" must be the last level`);
        }
        else if (curr !== "full" && curr <= prev) {
            fail(`manifest.levels[${i}].size`, `sizes must be strictly ascending: ${curr} <= ${prev}`);
        }
    }
    const result = {
        schema: 2, // normalize schema 1 → 2
        imageId,
        master,
        orientation: orientation,
        width,
        height,
        aspect,
        levels,
        // schema 1 normalization defaults
        stub: schema === 1 ? false : (typeof o["stub"] === "boolean" ? o["stub"] : undefined),
        proxy: schema === 1 ? false : (typeof o["proxy"] === "boolean" ? o["proxy"] : undefined),
    };
    if (o["producedBy"] !== undefined)
        result.producedBy = validateProducedBy(o["producedBy"], "manifest.producedBy");
    if (o["metadata"] !== undefined) {
        result.metadata = sanitizeOpaqueObject(requireObject(o["metadata"], "manifest.metadata"), "manifest.metadata");
    }
    if (o["convergedByteEnd"] !== undefined)
        result.convergedByteEnd = requireNumber(o["convergedByteEnd"], "manifest.convergedByteEnd");
    if (o["capabilities"] !== undefined)
        result.capabilities = validateCapabilities(o["capabilities"], "manifest.capabilities");
    return result;
}
function validateLevelZeroSeed(v, path) {
    const o = requireObject(v, path);
    const contenthash = requireString(o["contenthash"], `${path}.contenthash`);
    if (contenthash.length === 0)
        fail(`${path}.contenthash`, "must not be empty");
    if (!/^[a-fA-F0-9]+$/.test(contenthash))
        fail(`${path}.contenthash`, `must be hexadecimal, got "${contenthash}"`);
    const w = requireNumber(o["w"], `${path}.w`);
    const h = requireNumber(o["h"], `${path}.h`);
    if (w <= 0)
        fail(`${path}.w`, `width must be positive, got ${w}`);
    if (w > MAX_DIMENSION)
        fail(`${path}.w`, `width exceeds maximum ${MAX_DIMENSION}, got ${w}`);
    if (h <= 0)
        fail(`${path}.h`, `height must be positive, got ${h}`);
    if (h > MAX_DIMENSION)
        fail(`${path}.h`, `height exceeds maximum ${MAX_DIMENSION}, got ${h}`);
    const result = { contenthash, w, h };
    if (o["bytes"] !== undefined) {
        const bytes = requireNumber(o["bytes"], `${path}.bytes`);
        if (bytes <= 0)
            fail(`${path}.bytes`, `bytes must be positive, got ${bytes}`);
        if (bytes > MAX_BYTES)
            fail(`${path}.bytes`, `bytes exceeds maximum ${MAX_BYTES}, got ${bytes}`);
        result.bytes = bytes;
    }
    return result;
}
function validateGalleryIndexEntry(v, path) {
    const o = requireObject(v, path);
    const imageId = requireString(o["imageId"], `${path}.imageId`);
    const aspect = requireNumber(o["aspect"], `${path}.aspect`);
    const l0 = validateLevelZeroSeed(o["l0"], `${path}.l0`);
    const result = { imageId, aspect, l0 };
    if (o["thumbhash"] !== undefined)
        result.thumbhash = requireString(o["thumbhash"], `${path}.thumbhash`);
    if (o["group"] !== undefined)
        result.group = requireString(o["group"], `${path}.group`);
    return result;
}
export function parseGalleryIndex(json) {
    const o = requireObject(json, "index");
    const schema = requireNumber(o["schema"], "index.schema");
    if (schema !== INDEX_SCHEMA_VERSION) {
        fail("index.schema", `expected schema ${INDEX_SCHEMA_VERSION}, got ${schema}`);
    }
    const imagesRaw = requireArray(o["images"], "index.images");
    const images = imagesRaw.map((e, i) => validateGalleryIndexEntry(e, `index.images[${i}]`));
    const result = { schema: 1, images };
    if (o["next"] !== undefined)
        result.next = requireString(o["next"], "index.next");
    return result;
}
//# sourceMappingURL=manifest-validate.js.map