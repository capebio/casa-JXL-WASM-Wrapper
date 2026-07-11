// manifest-validate.ts
// Hand-rolled runtime validation for PyramidManifest and GalleryIndex.
// Types-only import from manifest.ts — no zod dependency.
// Aligned with the canonical @casabio/pyramid-ingest contract (CURRENT_MANIFEST_SCHEMA = 5,
// READABLE = [1,2,4,5]; 3 was skipped). finding 72: no divergent schema-≤2-only reader.
export const MANIFEST_SCHEMA_VERSION = 5;
export const READABLE_MANIFEST_SCHEMAS = [1, 2, 4, 5];
export const INDEX_SCHEMA_VERSION = 1;
// Upper bounds for security/sanity checks
const MAX_DIMENSION = 1 << 24; // 16777216 — matches libjxl JXTC header caps
const MAX_BYTES = 1 << 30; // 1073741824 — 1 GiB safety cap
const MAX_TILE_SIZE = 1 << 16; // 65536 — reasonable tile limit
// Opaque-dict sanitization caps
const MAX_OPAQUE_KEYS = 64;
const MAX_OPAQUE_DEPTH = 4;
const MAX_OPAQUE_KEY_LENGTH = 128;
// Master `format` values this reader accepts — mirrors the canonical pyramid-ingest masterInfoSchema.
const ACCEPTED_MASTER_FORMATS = new Set([
    "orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown",
]);
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
    // Aligned with the canonical @casabio/pyramid-ingest masterInfoSchema format set (SCH-1). The
    // extended RAW formats (nef/arw/raf/rw2/pef/srw/x3f) are advertised by ingest, so a manifest
    // carrying one must validate here too — otherwise the image is lost to this reader.
    if (!ACCEPTED_MASTER_FORMATS.has(format)) {
        fail(`${path}.format`, `unknown format "${format}"`);
    }
    const mtimeMs = requireNumber(o["mtimeMs"], `${path}.mtimeMs`);
    const result = { name, format: format, mtimeMs };
    // v5 (finding 64): provenance decoupled from decoder capability. Optional; any non-empty string
    // (the detected source format may be a RAW variant the decoder does not support).
    if (o["sourceFormat"] !== undefined) {
        const sf = requireString(o["sourceFormat"], `${path}.sourceFormat`);
        if (sf.length === 0)
            fail(`${path}.sourceFormat`, "must not be empty");
        result.sourceFormat = sf;
    }
    if (o["sizeBytes"] !== undefined)
        result.sizeBytes = requireNumber(o["sizeBytes"], `${path}.sizeBytes`);
    return result;
}
/** Validate an OrientationDescriptor { exif: 1..8, pixels }. */
function validateOrientationDescriptor(v, path) {
    const exif = requireNumber(v["exif"], `${path}.exif`);
    if (!Number.isInteger(exif) || exif < 1 || exif > 8) {
        fail(`${path}.exif`, `EXIF orientation must be an integer in 1..8, got ${exif}`);
    }
    const pixels = requireString(v["pixels"], `${path}.pixels`);
    if (pixels !== "source" && pixels !== "baked-upright") {
        fail(`${path}.pixels`, `expected "source" or "baked-upright", got "${pixels}"`);
    }
    return { exif, pixels };
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
/** Validate a v5 TilingDescriptor { container:"jxtc", version:1|2, tileSize, bitsPerSample, offsetBase:"file" }. */
function validateTilingDescriptor(t, path, w, h) {
    const container = requireString(t["container"], `${path}.container`);
    if (container !== "jxtc")
        fail(`${path}.container`, `expected "jxtc", got "${container}"`);
    const version = requireNumber(t["version"], `${path}.version`);
    if (version !== 1 && version !== 2)
        fail(`${path}.version`, `expected 1 or 2, got ${version}`);
    const tileSize = requireNumber(t["tileSize"], `${path}.tileSize`);
    if (tileSize <= 0)
        fail(`${path}.tileSize`, `tileSize must be positive, got ${tileSize}`);
    if (tileSize > MAX_TILE_SIZE)
        fail(`${path}.tileSize`, `tileSize exceeds maximum ${MAX_TILE_SIZE}, got ${tileSize}`);
    const bitsPerSample = requireNumber(t["bitsPerSample"], `${path}.bitsPerSample`);
    if (bitsPerSample !== 8 && bitsPerSample !== 16)
        fail(`${path}.bitsPerSample`, `expected 8 or 16, got ${bitsPerSample}`);
    const offsetBase = requireString(t["offsetBase"], `${path}.offsetBase`);
    if (offsetBase !== "file")
        fail(`${path}.offsetBase`, `expected "file", got "${offsetBase}"`);
    // sanity: a tile grid at this tileSize must cover the level (guards against absurd tileSize).
    if (Math.ceil(w / tileSize) <= 0 || Math.ceil(h / tileSize) <= 0)
        fail(`${path}.tileSize`, `tileSize ${tileSize} does not tile ${w}x${h}`);
    return { container: "jxtc", version: version, tileSize, bitsPerSample: bitsPerSample, offsetBase: "file" };
}
/** Validate a v4 TilingGrid { tileSize, cols, rows } against the level dimensions. */
function validateTilingGrid(t, path, w, h) {
    const tileSize = requireNumber(t["tileSize"], `${path}.tileSize`);
    const cols = requireNumber(t["cols"], `${path}.cols`);
    const rows = requireNumber(t["rows"], `${path}.rows`);
    if (tileSize <= 0)
        fail(`${path}.tileSize`, `tileSize must be positive, got ${tileSize}`);
    if (tileSize > MAX_TILE_SIZE)
        fail(`${path}.tileSize`, `tileSize exceeds maximum ${MAX_TILE_SIZE}, got ${tileSize}`);
    if (cols <= 0)
        fail(`${path}.cols`, `cols must be positive, got ${cols}`);
    if (cols > MAX_DIMENSION)
        fail(`${path}.cols`, `cols exceeds maximum ${MAX_DIMENSION}, got ${cols}`);
    if (rows <= 0)
        fail(`${path}.rows`, `rows must be positive, got ${rows}`);
    if (rows > MAX_DIMENSION)
        fail(`${path}.rows`, `rows exceeds maximum ${MAX_DIMENSION}, got ${rows}`);
    if (cols !== Math.ceil(w / tileSize))
        fail(`${path}.cols`, `cols ${cols} does not match ceil(${w}/${tileSize}) = ${Math.ceil(w / tileSize)}`);
    if (rows !== Math.ceil(h / tileSize))
        fail(`${path}.rows`, `rows ${rows} does not match ceil(${h}/${tileSize}) = ${Math.ceil(h / tileSize)}`);
    return { tileSize, cols, rows };
}
function validateLevel(v, path, schema) {
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
        // v5 persists a TilingDescriptor (has a `container` tag); v1–v4 persist a TilingGrid.
        if (schema >= 5 || t["container"] !== undefined) {
            level.tiling = validateTilingDescriptor(t, `${path}.tiling`, w, h);
        }
        else {
            level.tiling = validateTilingGrid(t, `${path}.tiling`, w, h);
        }
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
/** Known top-level keys the validator interprets. Everything else is an UNKNOWN extension field and
 *  is carried through verbatim (finding: additive/lossless contract — never drop unknown fields). */
const KNOWN_MANIFEST_KEYS = new Set([
    "schema", "imageId", "master", "orientation", "width", "height", "aspect",
    "levels", "stub", "proxy", "producedBy", "metadata", "convergedByteEnd", "capabilities",
]);
/**
 * Reads schema 1|2|4|5 (3 was skipped). Normalizes schema 1 → 2 (stub=false, proxy=false); keeps
 * 4 and 5. On v5, `orientation` is an OrientationDescriptor; on v1–v4 it is the legacy string.
 * Unknown top-level fields are preserved. Throws ManifestValidationError on schema 3, schema > 5,
 * or any invalid field.
 */
export function parsePyramidManifest(json) {
    const o = requireObject(json, "manifest");
    const schema = requireNumber(o["schema"], "manifest.schema");
    if (schema > MANIFEST_SCHEMA_VERSION) {
        fail("manifest.schema", `schema ${schema} is newer than reader (max ${MANIFEST_SCHEMA_VERSION}); upgrade the reader`);
    }
    if (!READABLE_MANIFEST_SCHEMAS.includes(schema)) {
        fail("manifest.schema", `unsupported schema version ${schema} (readable: ${READABLE_MANIFEST_SCHEMAS.join(", ")})`);
    }
    const imageId = requireString(o["imageId"], "manifest.imageId");
    const master = validateMasterMetadata(o["master"], "manifest.master");
    // Orientation: v5 uses an OrientationDescriptor; v1–v4 use the "baked"|"source" string.
    let orientation;
    if (schema >= 5) {
        orientation = validateOrientationDescriptor(requireObject(o["orientation"], "manifest.orientation"), "manifest.orientation");
    }
    else {
        const os = requireString(o["orientation"], "manifest.orientation");
        if (os !== "baked" && os !== "source") {
            fail("manifest.orientation", `expected "baked" or "source", got "${os}"`);
        }
        orientation = os;
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
    const levels = levelsRaw.map((l, i) => validateLevel(l, `manifest.levels[${i}]`, schema));
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
        schema: (schema === 1 ? 2 : schema), // normalize schema 1 → 2; keep 4/5
        imageId,
        master,
        orientation,
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
    // Preserve UNKNOWN extension fields verbatim so the contract stays additive/lossless.
    const extensible = result;
    for (const k of Object.keys(o)) {
        if (!KNOWN_MANIFEST_KEYS.has(k))
            extensible[k] = o[k];
    }
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