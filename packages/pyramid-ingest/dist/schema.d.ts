import { z } from "zod";
export declare const producedBySchema: z.ZodObject<{
    tool: z.ZodLiteral<"pyramid-ingest">;
    version: z.ZodString;
    encoder: z.ZodObject<{
        libjxl: z.ZodOptional<z.ZodString>;
        effort: z.ZodNumber;
        quality: z.ZodObject<{
            grid: z.ZodNumber;
            big: z.ZodNumber;
            proxy: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            big: number;
            proxy: number;
            grid: number;
        }, {
            big: number;
            proxy: number;
            grid: number;
        }>;
    }, "strip", z.ZodTypeAny, {
        effort: number;
        quality: {
            big: number;
            proxy: number;
            grid: number;
        };
        libjxl?: string | undefined;
    }, {
        effort: number;
        quality: {
            big: number;
            proxy: number;
            grid: number;
        };
        libjxl?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    tool: "pyramid-ingest";
    version: string;
    encoder: {
        effort: number;
        quality: {
            big: number;
            proxy: number;
            grid: number;
        };
        libjxl?: string | undefined;
    };
}, {
    tool: "pyramid-ingest";
    version: string;
    encoder: {
        effort: number;
        quality: {
            big: number;
            proxy: number;
            grid: number;
        };
        libjxl?: string | undefined;
    };
}>;
export declare const levelSizeSchema: z.ZodUnion<[z.ZodNumber, z.ZodLiteral<"full">]>;
/** Encode-time progressive quality curve point (measured once at ingest; read-only for clients). */
export declare const qualityCurvePointSchema: z.ZodObject<{
    bytes: z.ZodNumber;
    ssim: z.ZodOptional<z.ZodNumber>;
    butteraugli: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    bytes: number;
    ssim?: number | undefined;
    butteraugli?: number | undefined;
}, {
    bytes: number;
    ssim?: number | undefined;
    butteraugli?: number | undefined;
}>;
export declare const levelEntrySchema: z.ZodObject<{
    size: z.ZodUnion<[z.ZodNumber, z.ZodLiteral<"full">]>;
    w: z.ZodNumber;
    h: z.ZodNumber;
    bytes: z.ZodNumber;
    bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
    contenthash: z.ZodString;
    tiled: z.ZodBoolean;
    convergedByteEnd: z.ZodOptional<z.ZodNumber>;
    qualityCurve: z.ZodOptional<z.ZodArray<z.ZodObject<{
        bytes: z.ZodNumber;
        ssim: z.ZodOptional<z.ZodNumber>;
        butteraugli: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        bytes: number;
        ssim?: number | undefined;
        butteraugli?: number | undefined;
    }, {
        bytes: number;
        ssim?: number | undefined;
        butteraugli?: number | undefined;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    w: number;
    h: number;
    size: number | "full";
    bytes: number;
    bitsPerSample: 8 | 16;
    contenthash: string;
    tiled: boolean;
    convergedByteEnd?: number | undefined;
    qualityCurve?: {
        bytes: number;
        ssim?: number | undefined;
        butteraugli?: number | undefined;
    }[] | undefined;
}, {
    w: number;
    h: number;
    size: number | "full";
    bytes: number;
    bitsPerSample: 8 | 16;
    contenthash: string;
    tiled: boolean;
    convergedByteEnd?: number | undefined;
    qualityCurve?: {
        bytes: number;
        ssim?: number | undefined;
        butteraugli?: number | undefined;
    }[] | undefined;
}>;
export declare const masterInfoSchema: z.ZodObject<{
    name: z.ZodString;
    format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
    mtimeMs: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    name: string;
    format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
    mtimeMs: number;
}, {
    name: string;
    format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
    mtimeMs: number;
}>;
export declare const masterInfoV5Schema: z.ZodObject<{
    name: z.ZodString;
    format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
    mtimeMs: z.ZodNumber;
} & {
    sourceFormat: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    name: z.ZodString;
    format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
    mtimeMs: z.ZodNumber;
} & {
    sourceFormat: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    name: z.ZodString;
    format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
    mtimeMs: z.ZodNumber;
} & {
    sourceFormat: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** v5 OrientationDescriptor: the exact EXIF value (1..8) plus whether the stored pixels are already
 *  upright. Replaces the v1–v4 "baked"|"source" string; migration maps the old string to
 *  { exif: 1, pixels: <string> } when no EXIF orientation was recorded (MIG-2). */
export declare const orientationDescriptorSchema: z.ZodObject<{
    exif: z.ZodNumber;
    pixels: z.ZodEnum<["source", "baked-upright"]>;
}, "strip", z.ZodTypeAny, {
    pixels: "source" | "baked-upright";
    exif: number;
}, {
    pixels: "source" | "baked-upright";
    exif: number;
}>;
export type OrientationDescriptor = z.infer<typeof orientationDescriptorSchema>;
/** v5 TilingDescriptor persisted on a tiled level. `offsetBase: "file"` records that JXTC index
 *  offsets are ABSOLUTE from byte zero of the file (bridge.cpp:1925-1931 / jxl-pyramid/tiling.ts). */
export declare const tilingDescriptorSchema: z.ZodObject<{
    container: z.ZodLiteral<"jxtc">;
    version: z.ZodUnion<[z.ZodLiteral<1>, z.ZodLiteral<2>]>;
    tileSize: z.ZodNumber;
    bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
    offsetBase: z.ZodLiteral<"file">;
}, "strip", z.ZodTypeAny, {
    tileSize: number;
    bitsPerSample: 8 | 16;
    version: 1 | 2;
    container: "jxtc";
    offsetBase: "file";
}, {
    tileSize: number;
    bitsPerSample: 8 | 16;
    version: 1 | 2;
    container: "jxtc";
    offsetBase: "file";
}>;
export type TilingDescriptor = z.infer<typeof tilingDescriptorSchema>;
export declare const manifestSchemaV1: z.ZodObject<{
    schema: z.ZodLiteral<1>;
    imageId: z.ZodString;
    master: z.ZodObject<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    }, {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    }>;
    orientation: z.ZodOptional<z.ZodEnum<["baked", "source"]>>;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
    aspect: z.ZodOptional<z.ZodNumber>;
    levels: z.ZodOptional<z.ZodArray<z.ZodObject<{
        size: z.ZodUnion<[z.ZodNumber, z.ZodLiteral<"full">]>;
        w: z.ZodNumber;
        h: z.ZodNumber;
        bytes: z.ZodNumber;
        bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
        contenthash: z.ZodString;
        tiled: z.ZodBoolean;
        convergedByteEnd: z.ZodOptional<z.ZodNumber>;
        qualityCurve: z.ZodOptional<z.ZodArray<z.ZodObject<{
            bytes: z.ZodNumber;
            ssim: z.ZodOptional<z.ZodNumber>;
            butteraugli: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }>, "many">>;
    layout: z.ZodOptional<z.ZodString>;
    proxy: z.ZodOptional<z.ZodLiteral<true>>;
    stub: z.ZodOptional<z.ZodLiteral<true>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    producedBy: z.ZodOptional<z.ZodEffects<z.ZodObject<{
        tool: z.ZodLiteral<"pyramid-ingest">;
        version: z.ZodString;
        encoder: z.ZodObject<{
            libjxl: z.ZodOptional<z.ZodString>;
            effort: z.ZodNumber;
            quality: z.ZodObject<{
                grid: z.ZodNumber;
                big: z.ZodNumber;
                proxy: z.ZodNumber;
            }, "strip", z.ZodTypeAny, {
                big: number;
                proxy: number;
                grid: number;
            }, {
                big: number;
                proxy: number;
                grid: number;
            }>;
        }, "strip", z.ZodTypeAny, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>>;
}, "strip", z.ZodTypeAny, {
    schema: 1;
    imageId: string;
    master: {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    };
    width?: number | undefined;
    height?: number | undefined;
    orientation?: "baked" | "source" | undefined;
    levels?: {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }[] | undefined;
    producedBy?: {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    } | undefined;
    proxy?: true | undefined;
    aspect?: number | undefined;
    layout?: string | undefined;
    stub?: true | undefined;
    metadata?: Record<string, unknown> | undefined;
}, {
    schema: 1;
    imageId: string;
    master: {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    };
    width?: number | undefined;
    height?: number | undefined;
    orientation?: "baked" | "source" | undefined;
    levels?: {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }[] | undefined;
    producedBy?: {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    } | undefined;
    proxy?: true | undefined;
    aspect?: number | undefined;
    layout?: string | undefined;
    stub?: true | undefined;
    metadata?: Record<string, unknown> | undefined;
}>;
export declare const manifestSchemaV2Base: z.ZodObject<{
    imageId: z.ZodString;
    master: z.ZodObject<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    }, {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    }>;
    orientation: z.ZodOptional<z.ZodEnum<["baked", "source"]>>;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
    aspect: z.ZodOptional<z.ZodNumber>;
    levels: z.ZodOptional<z.ZodArray<z.ZodObject<{
        size: z.ZodUnion<[z.ZodNumber, z.ZodLiteral<"full">]>;
        w: z.ZodNumber;
        h: z.ZodNumber;
        bytes: z.ZodNumber;
        bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
        contenthash: z.ZodString;
        tiled: z.ZodBoolean;
        convergedByteEnd: z.ZodOptional<z.ZodNumber>;
        qualityCurve: z.ZodOptional<z.ZodArray<z.ZodObject<{
            bytes: z.ZodNumber;
            ssim: z.ZodOptional<z.ZodNumber>;
            butteraugli: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }>, "many">>;
    layout: z.ZodOptional<z.ZodString>;
    proxy: z.ZodOptional<z.ZodLiteral<true>>;
    stub: z.ZodOptional<z.ZodLiteral<true>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    producedBy: z.ZodOptional<z.ZodEffects<z.ZodObject<{
        tool: z.ZodLiteral<"pyramid-ingest">;
        version: z.ZodString;
        encoder: z.ZodObject<{
            libjxl: z.ZodOptional<z.ZodString>;
            effort: z.ZodNumber;
            quality: z.ZodObject<{
                grid: z.ZodNumber;
                big: z.ZodNumber;
                proxy: z.ZodNumber;
            }, "strip", z.ZodTypeAny, {
                big: number;
                proxy: number;
                grid: number;
            }, {
                big: number;
                proxy: number;
                grid: number;
            }>;
        }, "strip", z.ZodTypeAny, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>>;
} & {
    schema: z.ZodLiteral<2>;
}, "strip", z.ZodTypeAny, {
    schema: 2;
    imageId: string;
    master: {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    };
    width?: number | undefined;
    height?: number | undefined;
    orientation?: "baked" | "source" | undefined;
    levels?: {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }[] | undefined;
    producedBy?: {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    } | undefined;
    proxy?: true | undefined;
    aspect?: number | undefined;
    layout?: string | undefined;
    stub?: true | undefined;
    metadata?: Record<string, unknown> | undefined;
}, {
    schema: 2;
    imageId: string;
    master: {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    };
    width?: number | undefined;
    height?: number | undefined;
    orientation?: "baked" | "source" | undefined;
    levels?: {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }[] | undefined;
    producedBy?: {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    } | undefined;
    proxy?: true | undefined;
    aspect?: number | undefined;
    layout?: string | undefined;
    stub?: true | undefined;
    metadata?: Record<string, unknown> | undefined;
}>;
export declare const manifestSchemaV4Base: z.ZodObject<{
    imageId: z.ZodString;
    master: z.ZodObject<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    }, {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    }>;
    orientation: z.ZodOptional<z.ZodEnum<["baked", "source"]>>;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
    aspect: z.ZodOptional<z.ZodNumber>;
    levels: z.ZodOptional<z.ZodArray<z.ZodObject<{
        size: z.ZodUnion<[z.ZodNumber, z.ZodLiteral<"full">]>;
        w: z.ZodNumber;
        h: z.ZodNumber;
        bytes: z.ZodNumber;
        bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
        contenthash: z.ZodString;
        tiled: z.ZodBoolean;
        convergedByteEnd: z.ZodOptional<z.ZodNumber>;
        qualityCurve: z.ZodOptional<z.ZodArray<z.ZodObject<{
            bytes: z.ZodNumber;
            ssim: z.ZodOptional<z.ZodNumber>;
            butteraugli: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }>, "many">>;
    layout: z.ZodOptional<z.ZodString>;
    proxy: z.ZodOptional<z.ZodLiteral<true>>;
    stub: z.ZodOptional<z.ZodLiteral<true>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    producedBy: z.ZodOptional<z.ZodEffects<z.ZodObject<{
        tool: z.ZodLiteral<"pyramid-ingest">;
        version: z.ZodString;
        encoder: z.ZodObject<{
            libjxl: z.ZodOptional<z.ZodString>;
            effort: z.ZodNumber;
            quality: z.ZodObject<{
                grid: z.ZodNumber;
                big: z.ZodNumber;
                proxy: z.ZodNumber;
            }, "strip", z.ZodTypeAny, {
                big: number;
                proxy: number;
                grid: number;
            }, {
                big: number;
                proxy: number;
                grid: number;
            }>;
        }, "strip", z.ZodTypeAny, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>>;
} & {
    schema: z.ZodLiteral<4>;
}, "strip", z.ZodTypeAny, {
    schema: 4;
    imageId: string;
    master: {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    };
    width?: number | undefined;
    height?: number | undefined;
    orientation?: "baked" | "source" | undefined;
    levels?: {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }[] | undefined;
    producedBy?: {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    } | undefined;
    proxy?: true | undefined;
    aspect?: number | undefined;
    layout?: string | undefined;
    stub?: true | undefined;
    metadata?: Record<string, unknown> | undefined;
}, {
    schema: 4;
    imageId: string;
    master: {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    };
    width?: number | undefined;
    height?: number | undefined;
    orientation?: "baked" | "source" | undefined;
    levels?: {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }[] | undefined;
    producedBy?: {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    } | undefined;
    proxy?: true | undefined;
    aspect?: number | undefined;
    layout?: string | undefined;
    stub?: true | undefined;
    metadata?: Record<string, unknown> | undefined;
}>;
export declare const levelEntryV5Schema: z.ZodEffects<z.ZodObject<{
    size: z.ZodUnion<[z.ZodNumber, z.ZodLiteral<"full">]>;
    w: z.ZodNumber;
    h: z.ZodNumber;
    bytes: z.ZodNumber;
    bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
    contenthash: z.ZodString;
    tiled: z.ZodBoolean;
    convergedByteEnd: z.ZodOptional<z.ZodNumber>;
    qualityCurve: z.ZodOptional<z.ZodArray<z.ZodObject<{
        bytes: z.ZodNumber;
        ssim: z.ZodOptional<z.ZodNumber>;
        butteraugli: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        bytes: number;
        ssim?: number | undefined;
        butteraugli?: number | undefined;
    }, {
        bytes: number;
        ssim?: number | undefined;
        butteraugli?: number | undefined;
    }>, "many">>;
} & {
    tiling: z.ZodOptional<z.ZodObject<{
        container: z.ZodLiteral<"jxtc">;
        version: z.ZodUnion<[z.ZodLiteral<1>, z.ZodLiteral<2>]>;
        tileSize: z.ZodNumber;
        bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
        offsetBase: z.ZodLiteral<"file">;
    }, "strip", z.ZodTypeAny, {
        tileSize: number;
        bitsPerSample: 8 | 16;
        version: 1 | 2;
        container: "jxtc";
        offsetBase: "file";
    }, {
        tileSize: number;
        bitsPerSample: 8 | 16;
        version: 1 | 2;
        container: "jxtc";
        offsetBase: "file";
    }>>;
}, "strip", z.ZodTypeAny, {
    w: number;
    h: number;
    size: number | "full";
    bytes: number;
    bitsPerSample: 8 | 16;
    contenthash: string;
    tiled: boolean;
    convergedByteEnd?: number | undefined;
    qualityCurve?: {
        bytes: number;
        ssim?: number | undefined;
        butteraugli?: number | undefined;
    }[] | undefined;
    tiling?: {
        tileSize: number;
        bitsPerSample: 8 | 16;
        version: 1 | 2;
        container: "jxtc";
        offsetBase: "file";
    } | undefined;
}, {
    w: number;
    h: number;
    size: number | "full";
    bytes: number;
    bitsPerSample: 8 | 16;
    contenthash: string;
    tiled: boolean;
    convergedByteEnd?: number | undefined;
    qualityCurve?: {
        bytes: number;
        ssim?: number | undefined;
        butteraugli?: number | undefined;
    }[] | undefined;
    tiling?: {
        tileSize: number;
        bitsPerSample: 8 | 16;
        version: 1 | 2;
        container: "jxtc";
        offsetBase: "file";
    } | undefined;
}>, {
    w: number;
    h: number;
    size: number | "full";
    bytes: number;
    bitsPerSample: 8 | 16;
    contenthash: string;
    tiled: boolean;
    convergedByteEnd?: number | undefined;
    qualityCurve?: {
        bytes: number;
        ssim?: number | undefined;
        butteraugli?: number | undefined;
    }[] | undefined;
    tiling?: {
        tileSize: number;
        bitsPerSample: 8 | 16;
        version: 1 | 2;
        container: "jxtc";
        offsetBase: "file";
    } | undefined;
}, {
    w: number;
    h: number;
    size: number | "full";
    bytes: number;
    bitsPerSample: 8 | 16;
    contenthash: string;
    tiled: boolean;
    convergedByteEnd?: number | undefined;
    qualityCurve?: {
        bytes: number;
        ssim?: number | undefined;
        butteraugli?: number | undefined;
    }[] | undefined;
    tiling?: {
        tileSize: number;
        bitsPerSample: 8 | 16;
        version: 1 | 2;
        container: "jxtc";
        offsetBase: "file";
    } | undefined;
}>;
export declare const manifestSchemaV5: z.ZodObject<{
    schema: z.ZodLiteral<5>;
    imageId: z.ZodString;
    master: z.ZodObject<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    } & {
        sourceFormat: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    } & {
        sourceFormat: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    } & {
        sourceFormat: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>;
    orientation: z.ZodObject<{
        exif: z.ZodNumber;
        pixels: z.ZodEnum<["source", "baked-upright"]>;
    }, "strip", z.ZodTypeAny, {
        pixels: "source" | "baked-upright";
        exif: number;
    }, {
        pixels: "source" | "baked-upright";
        exif: number;
    }>;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
    aspect: z.ZodOptional<z.ZodNumber>;
    levels: z.ZodOptional<z.ZodArray<z.ZodEffects<z.ZodObject<{
        size: z.ZodUnion<[z.ZodNumber, z.ZodLiteral<"full">]>;
        w: z.ZodNumber;
        h: z.ZodNumber;
        bytes: z.ZodNumber;
        bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
        contenthash: z.ZodString;
        tiled: z.ZodBoolean;
        convergedByteEnd: z.ZodOptional<z.ZodNumber>;
        qualityCurve: z.ZodOptional<z.ZodArray<z.ZodObject<{
            bytes: z.ZodNumber;
            ssim: z.ZodOptional<z.ZodNumber>;
            butteraugli: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }>, "many">>;
    } & {
        tiling: z.ZodOptional<z.ZodObject<{
            container: z.ZodLiteral<"jxtc">;
            version: z.ZodUnion<[z.ZodLiteral<1>, z.ZodLiteral<2>]>;
            tileSize: z.ZodNumber;
            bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
            offsetBase: z.ZodLiteral<"file">;
        }, "strip", z.ZodTypeAny, {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        }, {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        }>>;
    }, "strip", z.ZodTypeAny, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }>, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }>, "many">>;
    layout: z.ZodOptional<z.ZodString>;
    proxy: z.ZodOptional<z.ZodLiteral<true>>;
    stub: z.ZodOptional<z.ZodLiteral<true>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    producedBy: z.ZodOptional<z.ZodEffects<z.ZodObject<{
        tool: z.ZodLiteral<"pyramid-ingest">;
        version: z.ZodString;
        encoder: z.ZodObject<{
            libjxl: z.ZodOptional<z.ZodString>;
            effort: z.ZodNumber;
            quality: z.ZodObject<{
                grid: z.ZodNumber;
                big: z.ZodNumber;
                proxy: z.ZodNumber;
            }, "strip", z.ZodTypeAny, {
                big: number;
                proxy: number;
                grid: number;
            }, {
                big: number;
                proxy: number;
                grid: number;
            }>;
        }, "strip", z.ZodTypeAny, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    schema: z.ZodLiteral<5>;
    imageId: z.ZodString;
    master: z.ZodObject<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    } & {
        sourceFormat: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    } & {
        sourceFormat: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    } & {
        sourceFormat: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>;
    orientation: z.ZodObject<{
        exif: z.ZodNumber;
        pixels: z.ZodEnum<["source", "baked-upright"]>;
    }, "strip", z.ZodTypeAny, {
        pixels: "source" | "baked-upright";
        exif: number;
    }, {
        pixels: "source" | "baked-upright";
        exif: number;
    }>;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
    aspect: z.ZodOptional<z.ZodNumber>;
    levels: z.ZodOptional<z.ZodArray<z.ZodEffects<z.ZodObject<{
        size: z.ZodUnion<[z.ZodNumber, z.ZodLiteral<"full">]>;
        w: z.ZodNumber;
        h: z.ZodNumber;
        bytes: z.ZodNumber;
        bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
        contenthash: z.ZodString;
        tiled: z.ZodBoolean;
        convergedByteEnd: z.ZodOptional<z.ZodNumber>;
        qualityCurve: z.ZodOptional<z.ZodArray<z.ZodObject<{
            bytes: z.ZodNumber;
            ssim: z.ZodOptional<z.ZodNumber>;
            butteraugli: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }>, "many">>;
    } & {
        tiling: z.ZodOptional<z.ZodObject<{
            container: z.ZodLiteral<"jxtc">;
            version: z.ZodUnion<[z.ZodLiteral<1>, z.ZodLiteral<2>]>;
            tileSize: z.ZodNumber;
            bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
            offsetBase: z.ZodLiteral<"file">;
        }, "strip", z.ZodTypeAny, {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        }, {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        }>>;
    }, "strip", z.ZodTypeAny, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }>, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }>, "many">>;
    layout: z.ZodOptional<z.ZodString>;
    proxy: z.ZodOptional<z.ZodLiteral<true>>;
    stub: z.ZodOptional<z.ZodLiteral<true>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    producedBy: z.ZodOptional<z.ZodEffects<z.ZodObject<{
        tool: z.ZodLiteral<"pyramid-ingest">;
        version: z.ZodString;
        encoder: z.ZodObject<{
            libjxl: z.ZodOptional<z.ZodString>;
            effort: z.ZodNumber;
            quality: z.ZodObject<{
                grid: z.ZodNumber;
                big: z.ZodNumber;
                proxy: z.ZodNumber;
            }, "strip", z.ZodTypeAny, {
                big: number;
                proxy: number;
                grid: number;
            }, {
                big: number;
                proxy: number;
                grid: number;
            }>;
        }, "strip", z.ZodTypeAny, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    schema: z.ZodLiteral<5>;
    imageId: z.ZodString;
    master: z.ZodObject<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    } & {
        sourceFormat: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    } & {
        sourceFormat: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    } & {
        sourceFormat: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>;
    orientation: z.ZodObject<{
        exif: z.ZodNumber;
        pixels: z.ZodEnum<["source", "baked-upright"]>;
    }, "strip", z.ZodTypeAny, {
        pixels: "source" | "baked-upright";
        exif: number;
    }, {
        pixels: "source" | "baked-upright";
        exif: number;
    }>;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
    aspect: z.ZodOptional<z.ZodNumber>;
    levels: z.ZodOptional<z.ZodArray<z.ZodEffects<z.ZodObject<{
        size: z.ZodUnion<[z.ZodNumber, z.ZodLiteral<"full">]>;
        w: z.ZodNumber;
        h: z.ZodNumber;
        bytes: z.ZodNumber;
        bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
        contenthash: z.ZodString;
        tiled: z.ZodBoolean;
        convergedByteEnd: z.ZodOptional<z.ZodNumber>;
        qualityCurve: z.ZodOptional<z.ZodArray<z.ZodObject<{
            bytes: z.ZodNumber;
            ssim: z.ZodOptional<z.ZodNumber>;
            butteraugli: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }>, "many">>;
    } & {
        tiling: z.ZodOptional<z.ZodObject<{
            container: z.ZodLiteral<"jxtc">;
            version: z.ZodUnion<[z.ZodLiteral<1>, z.ZodLiteral<2>]>;
            tileSize: z.ZodNumber;
            bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
            offsetBase: z.ZodLiteral<"file">;
        }, "strip", z.ZodTypeAny, {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        }, {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        }>>;
    }, "strip", z.ZodTypeAny, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }>, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }>, "many">>;
    layout: z.ZodOptional<z.ZodString>;
    proxy: z.ZodOptional<z.ZodLiteral<true>>;
    stub: z.ZodOptional<z.ZodLiteral<true>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    producedBy: z.ZodOptional<z.ZodEffects<z.ZodObject<{
        tool: z.ZodLiteral<"pyramid-ingest">;
        version: z.ZodString;
        encoder: z.ZodObject<{
            libjxl: z.ZodOptional<z.ZodString>;
            effort: z.ZodNumber;
            quality: z.ZodObject<{
                grid: z.ZodNumber;
                big: z.ZodNumber;
                proxy: z.ZodNumber;
            }, "strip", z.ZodTypeAny, {
                big: number;
                proxy: number;
                grid: number;
            }, {
                big: number;
                proxy: number;
                grid: number;
            }>;
        }, "strip", z.ZodTypeAny, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>>;
}, z.ZodTypeAny, "passthrough">>;
export declare const manifestSchema: z.ZodDiscriminatedUnion<"schema", [z.ZodObject<{
    schema: z.ZodLiteral<1>;
    imageId: z.ZodString;
    master: z.ZodObject<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    }, {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    }>;
    orientation: z.ZodOptional<z.ZodEnum<["baked", "source"]>>;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
    aspect: z.ZodOptional<z.ZodNumber>;
    levels: z.ZodOptional<z.ZodArray<z.ZodObject<{
        size: z.ZodUnion<[z.ZodNumber, z.ZodLiteral<"full">]>;
        w: z.ZodNumber;
        h: z.ZodNumber;
        bytes: z.ZodNumber;
        bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
        contenthash: z.ZodString;
        tiled: z.ZodBoolean;
        convergedByteEnd: z.ZodOptional<z.ZodNumber>;
        qualityCurve: z.ZodOptional<z.ZodArray<z.ZodObject<{
            bytes: z.ZodNumber;
            ssim: z.ZodOptional<z.ZodNumber>;
            butteraugli: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }>, "many">>;
    layout: z.ZodOptional<z.ZodString>;
    proxy: z.ZodOptional<z.ZodLiteral<true>>;
    stub: z.ZodOptional<z.ZodLiteral<true>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    producedBy: z.ZodOptional<z.ZodEffects<z.ZodObject<{
        tool: z.ZodLiteral<"pyramid-ingest">;
        version: z.ZodString;
        encoder: z.ZodObject<{
            libjxl: z.ZodOptional<z.ZodString>;
            effort: z.ZodNumber;
            quality: z.ZodObject<{
                grid: z.ZodNumber;
                big: z.ZodNumber;
                proxy: z.ZodNumber;
            }, "strip", z.ZodTypeAny, {
                big: number;
                proxy: number;
                grid: number;
            }, {
                big: number;
                proxy: number;
                grid: number;
            }>;
        }, "strip", z.ZodTypeAny, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>>;
}, "strip", z.ZodTypeAny, {
    schema: 1;
    imageId: string;
    master: {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    };
    width?: number | undefined;
    height?: number | undefined;
    orientation?: "baked" | "source" | undefined;
    levels?: {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }[] | undefined;
    producedBy?: {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    } | undefined;
    proxy?: true | undefined;
    aspect?: number | undefined;
    layout?: string | undefined;
    stub?: true | undefined;
    metadata?: Record<string, unknown> | undefined;
}, {
    schema: 1;
    imageId: string;
    master: {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    };
    width?: number | undefined;
    height?: number | undefined;
    orientation?: "baked" | "source" | undefined;
    levels?: {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }[] | undefined;
    producedBy?: {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    } | undefined;
    proxy?: true | undefined;
    aspect?: number | undefined;
    layout?: string | undefined;
    stub?: true | undefined;
    metadata?: Record<string, unknown> | undefined;
}>, z.ZodObject<{
    imageId: z.ZodString;
    master: z.ZodObject<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    }, {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    }>;
    orientation: z.ZodOptional<z.ZodEnum<["baked", "source"]>>;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
    aspect: z.ZodOptional<z.ZodNumber>;
    levels: z.ZodOptional<z.ZodArray<z.ZodObject<{
        size: z.ZodUnion<[z.ZodNumber, z.ZodLiteral<"full">]>;
        w: z.ZodNumber;
        h: z.ZodNumber;
        bytes: z.ZodNumber;
        bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
        contenthash: z.ZodString;
        tiled: z.ZodBoolean;
        convergedByteEnd: z.ZodOptional<z.ZodNumber>;
        qualityCurve: z.ZodOptional<z.ZodArray<z.ZodObject<{
            bytes: z.ZodNumber;
            ssim: z.ZodOptional<z.ZodNumber>;
            butteraugli: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }>, "many">>;
    layout: z.ZodOptional<z.ZodString>;
    proxy: z.ZodOptional<z.ZodLiteral<true>>;
    stub: z.ZodOptional<z.ZodLiteral<true>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    producedBy: z.ZodOptional<z.ZodEffects<z.ZodObject<{
        tool: z.ZodLiteral<"pyramid-ingest">;
        version: z.ZodString;
        encoder: z.ZodObject<{
            libjxl: z.ZodOptional<z.ZodString>;
            effort: z.ZodNumber;
            quality: z.ZodObject<{
                grid: z.ZodNumber;
                big: z.ZodNumber;
                proxy: z.ZodNumber;
            }, "strip", z.ZodTypeAny, {
                big: number;
                proxy: number;
                grid: number;
            }, {
                big: number;
                proxy: number;
                grid: number;
            }>;
        }, "strip", z.ZodTypeAny, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>>;
} & {
    schema: z.ZodLiteral<2>;
}, "strip", z.ZodTypeAny, {
    schema: 2;
    imageId: string;
    master: {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    };
    width?: number | undefined;
    height?: number | undefined;
    orientation?: "baked" | "source" | undefined;
    levels?: {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }[] | undefined;
    producedBy?: {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    } | undefined;
    proxy?: true | undefined;
    aspect?: number | undefined;
    layout?: string | undefined;
    stub?: true | undefined;
    metadata?: Record<string, unknown> | undefined;
}, {
    schema: 2;
    imageId: string;
    master: {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    };
    width?: number | undefined;
    height?: number | undefined;
    orientation?: "baked" | "source" | undefined;
    levels?: {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }[] | undefined;
    producedBy?: {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    } | undefined;
    proxy?: true | undefined;
    aspect?: number | undefined;
    layout?: string | undefined;
    stub?: true | undefined;
    metadata?: Record<string, unknown> | undefined;
}>, z.ZodObject<{
    imageId: z.ZodString;
    master: z.ZodObject<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    }, {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    }>;
    orientation: z.ZodOptional<z.ZodEnum<["baked", "source"]>>;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
    aspect: z.ZodOptional<z.ZodNumber>;
    levels: z.ZodOptional<z.ZodArray<z.ZodObject<{
        size: z.ZodUnion<[z.ZodNumber, z.ZodLiteral<"full">]>;
        w: z.ZodNumber;
        h: z.ZodNumber;
        bytes: z.ZodNumber;
        bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
        contenthash: z.ZodString;
        tiled: z.ZodBoolean;
        convergedByteEnd: z.ZodOptional<z.ZodNumber>;
        qualityCurve: z.ZodOptional<z.ZodArray<z.ZodObject<{
            bytes: z.ZodNumber;
            ssim: z.ZodOptional<z.ZodNumber>;
            butteraugli: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }>, "many">>;
    layout: z.ZodOptional<z.ZodString>;
    proxy: z.ZodOptional<z.ZodLiteral<true>>;
    stub: z.ZodOptional<z.ZodLiteral<true>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    producedBy: z.ZodOptional<z.ZodEffects<z.ZodObject<{
        tool: z.ZodLiteral<"pyramid-ingest">;
        version: z.ZodString;
        encoder: z.ZodObject<{
            libjxl: z.ZodOptional<z.ZodString>;
            effort: z.ZodNumber;
            quality: z.ZodObject<{
                grid: z.ZodNumber;
                big: z.ZodNumber;
                proxy: z.ZodNumber;
            }, "strip", z.ZodTypeAny, {
                big: number;
                proxy: number;
                grid: number;
            }, {
                big: number;
                proxy: number;
                grid: number;
            }>;
        }, "strip", z.ZodTypeAny, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>>;
} & {
    schema: z.ZodLiteral<4>;
}, "strip", z.ZodTypeAny, {
    schema: 4;
    imageId: string;
    master: {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    };
    width?: number | undefined;
    height?: number | undefined;
    orientation?: "baked" | "source" | undefined;
    levels?: {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }[] | undefined;
    producedBy?: {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    } | undefined;
    proxy?: true | undefined;
    aspect?: number | undefined;
    layout?: string | undefined;
    stub?: true | undefined;
    metadata?: Record<string, unknown> | undefined;
}, {
    schema: 4;
    imageId: string;
    master: {
        name: string;
        format: "orf" | "dng" | "cr2" | "jpg" | "unknown" | "nef" | "arw" | "raf" | "rw2" | "pef" | "srw" | "x3f";
        mtimeMs: number;
    };
    width?: number | undefined;
    height?: number | undefined;
    orientation?: "baked" | "source" | undefined;
    levels?: {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
    }[] | undefined;
    producedBy?: {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    } | undefined;
    proxy?: true | undefined;
    aspect?: number | undefined;
    layout?: string | undefined;
    stub?: true | undefined;
    metadata?: Record<string, unknown> | undefined;
}>, z.ZodObject<{
    schema: z.ZodLiteral<5>;
    imageId: z.ZodString;
    master: z.ZodObject<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    } & {
        sourceFormat: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    } & {
        sourceFormat: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    } & {
        sourceFormat: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>;
    orientation: z.ZodObject<{
        exif: z.ZodNumber;
        pixels: z.ZodEnum<["source", "baked-upright"]>;
    }, "strip", z.ZodTypeAny, {
        pixels: "source" | "baked-upright";
        exif: number;
    }, {
        pixels: "source" | "baked-upright";
        exif: number;
    }>;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
    aspect: z.ZodOptional<z.ZodNumber>;
    levels: z.ZodOptional<z.ZodArray<z.ZodEffects<z.ZodObject<{
        size: z.ZodUnion<[z.ZodNumber, z.ZodLiteral<"full">]>;
        w: z.ZodNumber;
        h: z.ZodNumber;
        bytes: z.ZodNumber;
        bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
        contenthash: z.ZodString;
        tiled: z.ZodBoolean;
        convergedByteEnd: z.ZodOptional<z.ZodNumber>;
        qualityCurve: z.ZodOptional<z.ZodArray<z.ZodObject<{
            bytes: z.ZodNumber;
            ssim: z.ZodOptional<z.ZodNumber>;
            butteraugli: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }>, "many">>;
    } & {
        tiling: z.ZodOptional<z.ZodObject<{
            container: z.ZodLiteral<"jxtc">;
            version: z.ZodUnion<[z.ZodLiteral<1>, z.ZodLiteral<2>]>;
            tileSize: z.ZodNumber;
            bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
            offsetBase: z.ZodLiteral<"file">;
        }, "strip", z.ZodTypeAny, {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        }, {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        }>>;
    }, "strip", z.ZodTypeAny, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }>, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }>, "many">>;
    layout: z.ZodOptional<z.ZodString>;
    proxy: z.ZodOptional<z.ZodLiteral<true>>;
    stub: z.ZodOptional<z.ZodLiteral<true>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    producedBy: z.ZodOptional<z.ZodEffects<z.ZodObject<{
        tool: z.ZodLiteral<"pyramid-ingest">;
        version: z.ZodString;
        encoder: z.ZodObject<{
            libjxl: z.ZodOptional<z.ZodString>;
            effort: z.ZodNumber;
            quality: z.ZodObject<{
                grid: z.ZodNumber;
                big: z.ZodNumber;
                proxy: z.ZodNumber;
            }, "strip", z.ZodTypeAny, {
                big: number;
                proxy: number;
                grid: number;
            }, {
                big: number;
                proxy: number;
                grid: number;
            }>;
        }, "strip", z.ZodTypeAny, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    schema: z.ZodLiteral<5>;
    imageId: z.ZodString;
    master: z.ZodObject<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    } & {
        sourceFormat: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    } & {
        sourceFormat: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    } & {
        sourceFormat: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>;
    orientation: z.ZodObject<{
        exif: z.ZodNumber;
        pixels: z.ZodEnum<["source", "baked-upright"]>;
    }, "strip", z.ZodTypeAny, {
        pixels: "source" | "baked-upright";
        exif: number;
    }, {
        pixels: "source" | "baked-upright";
        exif: number;
    }>;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
    aspect: z.ZodOptional<z.ZodNumber>;
    levels: z.ZodOptional<z.ZodArray<z.ZodEffects<z.ZodObject<{
        size: z.ZodUnion<[z.ZodNumber, z.ZodLiteral<"full">]>;
        w: z.ZodNumber;
        h: z.ZodNumber;
        bytes: z.ZodNumber;
        bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
        contenthash: z.ZodString;
        tiled: z.ZodBoolean;
        convergedByteEnd: z.ZodOptional<z.ZodNumber>;
        qualityCurve: z.ZodOptional<z.ZodArray<z.ZodObject<{
            bytes: z.ZodNumber;
            ssim: z.ZodOptional<z.ZodNumber>;
            butteraugli: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }>, "many">>;
    } & {
        tiling: z.ZodOptional<z.ZodObject<{
            container: z.ZodLiteral<"jxtc">;
            version: z.ZodUnion<[z.ZodLiteral<1>, z.ZodLiteral<2>]>;
            tileSize: z.ZodNumber;
            bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
            offsetBase: z.ZodLiteral<"file">;
        }, "strip", z.ZodTypeAny, {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        }, {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        }>>;
    }, "strip", z.ZodTypeAny, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }>, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }>, "many">>;
    layout: z.ZodOptional<z.ZodString>;
    proxy: z.ZodOptional<z.ZodLiteral<true>>;
    stub: z.ZodOptional<z.ZodLiteral<true>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    producedBy: z.ZodOptional<z.ZodEffects<z.ZodObject<{
        tool: z.ZodLiteral<"pyramid-ingest">;
        version: z.ZodString;
        encoder: z.ZodObject<{
            libjxl: z.ZodOptional<z.ZodString>;
            effort: z.ZodNumber;
            quality: z.ZodObject<{
                grid: z.ZodNumber;
                big: z.ZodNumber;
                proxy: z.ZodNumber;
            }, "strip", z.ZodTypeAny, {
                big: number;
                proxy: number;
                grid: number;
            }, {
                big: number;
                proxy: number;
                grid: number;
            }>;
        }, "strip", z.ZodTypeAny, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    schema: z.ZodLiteral<5>;
    imageId: z.ZodString;
    master: z.ZodObject<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    } & {
        sourceFormat: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    } & {
        sourceFormat: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        name: z.ZodString;
        format: z.ZodEnum<["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "pef", "srw", "x3f", "unknown"]>;
        mtimeMs: z.ZodNumber;
    } & {
        sourceFormat: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>;
    orientation: z.ZodObject<{
        exif: z.ZodNumber;
        pixels: z.ZodEnum<["source", "baked-upright"]>;
    }, "strip", z.ZodTypeAny, {
        pixels: "source" | "baked-upright";
        exif: number;
    }, {
        pixels: "source" | "baked-upright";
        exif: number;
    }>;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
    aspect: z.ZodOptional<z.ZodNumber>;
    levels: z.ZodOptional<z.ZodArray<z.ZodEffects<z.ZodObject<{
        size: z.ZodUnion<[z.ZodNumber, z.ZodLiteral<"full">]>;
        w: z.ZodNumber;
        h: z.ZodNumber;
        bytes: z.ZodNumber;
        bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
        contenthash: z.ZodString;
        tiled: z.ZodBoolean;
        convergedByteEnd: z.ZodOptional<z.ZodNumber>;
        qualityCurve: z.ZodOptional<z.ZodArray<z.ZodObject<{
            bytes: z.ZodNumber;
            ssim: z.ZodOptional<z.ZodNumber>;
            butteraugli: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }, {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }>, "many">>;
    } & {
        tiling: z.ZodOptional<z.ZodObject<{
            container: z.ZodLiteral<"jxtc">;
            version: z.ZodUnion<[z.ZodLiteral<1>, z.ZodLiteral<2>]>;
            tileSize: z.ZodNumber;
            bitsPerSample: z.ZodUnion<[z.ZodLiteral<8>, z.ZodLiteral<16>]>;
            offsetBase: z.ZodLiteral<"file">;
        }, "strip", z.ZodTypeAny, {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        }, {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        }>>;
    }, "strip", z.ZodTypeAny, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }>, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }, {
        w: number;
        h: number;
        size: number | "full";
        bytes: number;
        bitsPerSample: 8 | 16;
        contenthash: string;
        tiled: boolean;
        convergedByteEnd?: number | undefined;
        qualityCurve?: {
            bytes: number;
            ssim?: number | undefined;
            butteraugli?: number | undefined;
        }[] | undefined;
        tiling?: {
            tileSize: number;
            bitsPerSample: 8 | 16;
            version: 1 | 2;
            container: "jxtc";
            offsetBase: "file";
        } | undefined;
    }>, "many">>;
    layout: z.ZodOptional<z.ZodString>;
    proxy: z.ZodOptional<z.ZodLiteral<true>>;
    stub: z.ZodOptional<z.ZodLiteral<true>>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    producedBy: z.ZodOptional<z.ZodEffects<z.ZodObject<{
        tool: z.ZodLiteral<"pyramid-ingest">;
        version: z.ZodString;
        encoder: z.ZodObject<{
            libjxl: z.ZodOptional<z.ZodString>;
            effort: z.ZodNumber;
            quality: z.ZodObject<{
                grid: z.ZodNumber;
                big: z.ZodNumber;
                proxy: z.ZodNumber;
            }, "strip", z.ZodTypeAny, {
                big: number;
                proxy: number;
                grid: number;
            }, {
                big: number;
                proxy: number;
                grid: number;
            }>;
        }, "strip", z.ZodTypeAny, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>>;
}, z.ZodTypeAny, "passthrough">>]>;
export type ManifestV2 = z.infer<typeof manifestSchemaV2Base>;
export type ManifestV4 = z.infer<typeof manifestSchemaV4Base>;
export type ManifestV5 = z.infer<typeof manifestSchemaV5>;
/** The schema version this tool writes today. */
export declare const CURRENT_MANIFEST_SCHEMA: 5;
/** Every schema version this tool can READ (and additively migrate forward). */
export declare const READABLE_MANIFEST_SCHEMAS: readonly [1, 2, 4, 5];
export declare const indexEntrySchema: z.ZodObject<{
    imageId: z.ZodString;
    aspect: z.ZodNumber;
    l0: z.ZodObject<{
        contenthash: z.ZodString;
        w: z.ZodNumber;
        h: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        w: number;
        h: number;
        contenthash: string;
    }, {
        w: number;
        h: number;
        contenthash: string;
    }>;
    schema: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    imageId: string;
    aspect: number;
    l0: {
        w: number;
        h: number;
        contenthash: string;
    };
    schema?: number | undefined;
}, {
    imageId: string;
    aspect: number;
    l0: {
        w: number;
        h: number;
        contenthash: string;
    };
    schema?: number | undefined;
}>;
export declare const galleryIndexSchema: z.ZodObject<{
    schema: z.ZodLiteral<1>;
    images: z.ZodArray<z.ZodObject<{
        imageId: z.ZodString;
        aspect: z.ZodNumber;
        l0: z.ZodObject<{
            contenthash: z.ZodString;
            w: z.ZodNumber;
            h: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            w: number;
            h: number;
            contenthash: string;
        }, {
            w: number;
            h: number;
            contenthash: string;
        }>;
        schema: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        imageId: string;
        aspect: number;
        l0: {
            w: number;
            h: number;
            contenthash: string;
        };
        schema?: number | undefined;
    }, {
        imageId: string;
        aspect: number;
        l0: {
            w: number;
            h: number;
            contenthash: string;
        };
        schema?: number | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    images: {
        imageId: string;
        aspect: number;
        l0: {
            w: number;
            h: number;
            contenthash: string;
        };
        schema?: number | undefined;
    }[];
    schema: 1;
}, {
    images: {
        imageId: string;
        aspect: number;
        l0: {
            w: number;
            h: number;
            contenthash: string;
        };
        schema?: number | undefined;
    }[];
    schema: 1;
}>;
export type Manifest = z.infer<typeof manifestSchemaV1> | ManifestV2 | ManifestV4 | ManifestV5;
export type IndexEntry = z.infer<typeof indexEntrySchema>;
export type GalleryIndex = z.infer<typeof galleryIndexSchema>;
export type LevelEntry = z.infer<typeof levelEntrySchema>;
/** v5 level entry (base + optional TilingDescriptor). What toEntry emits. */
export type LevelEntryV5 = z.infer<typeof levelEntryV5Schema>;
/** v5 TilingDescriptor as it appears on a persisted level. */
export type LevelTilingDescriptor = z.infer<typeof tilingDescriptorSchema>;
export type LevelSize = z.infer<typeof levelSizeSchema>;
export type MasterInfo = z.infer<typeof masterInfoSchema>;
export type ProducedBy = z.infer<typeof producedBySchema>;
export declare const imageRecordSchema: z.ZodObject<{
    path: z.ZodString;
    imageId: z.ZodOptional<z.ZodString>;
    outcome: z.ZodEnum<["written", "skipped", "failed"]>;
    error: z.ZodOptional<z.ZodString>;
    durationMs: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    path: string;
    outcome: "written" | "skipped" | "failed";
    error?: string | undefined;
    imageId?: string | undefined;
    durationMs?: number | undefined;
}, {
    path: string;
    outcome: "written" | "skipped" | "failed";
    error?: string | undefined;
    imageId?: string | undefined;
    durationMs?: number | undefined;
}>;
export type ImageRecord = z.infer<typeof imageRecordSchema>;
export declare const runRecordSchema: z.ZodObject<{
    runId: z.ZodString;
    startedAt: z.ZodNumber;
    endedAt: z.ZodNumber;
    producedBy: z.ZodObject<{
        tool: z.ZodLiteral<"pyramid-ingest">;
        version: z.ZodString;
        encoder: z.ZodObject<{
            libjxl: z.ZodOptional<z.ZodString>;
            effort: z.ZodNumber;
            quality: z.ZodObject<{
                grid: z.ZodNumber;
                big: z.ZodNumber;
                proxy: z.ZodNumber;
            }, "strip", z.ZodTypeAny, {
                big: number;
                proxy: number;
                grid: number;
            }, {
                big: number;
                proxy: number;
                grid: number;
            }>;
        }, "strip", z.ZodTypeAny, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }, {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }, {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    }>;
    args: z.ZodArray<z.ZodString, "many">;
    summary: z.ZodObject<{
        written: z.ZodNumber;
        skipped: z.ZodNumber;
        failed: z.ZodNumber;
        stagedBytes: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        written: number;
        skipped: number;
        failed: number;
        stagedBytes?: number | undefined;
    }, {
        written: number;
        skipped: number;
        failed: number;
        stagedBytes?: number | undefined;
    }>;
    images: z.ZodOptional<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        imageId: z.ZodOptional<z.ZodString>;
        outcome: z.ZodEnum<["written", "skipped", "failed"]>;
        error: z.ZodOptional<z.ZodString>;
        durationMs: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        path: string;
        outcome: "written" | "skipped" | "failed";
        error?: string | undefined;
        imageId?: string | undefined;
        durationMs?: number | undefined;
    }, {
        path: string;
        outcome: "written" | "skipped" | "failed";
        error?: string | undefined;
        imageId?: string | undefined;
        durationMs?: number | undefined;
    }>, "many">>;
    failures: z.ZodOptional<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        error: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        error: string;
        path: string;
    }, {
        error: string;
        path: string;
    }>, "many">>;
    stages: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        ts: z.ZodNumber;
        fields: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        ts: number;
        fields?: Record<string, unknown> | undefined;
    }, {
        name: string;
        ts: number;
        fields?: Record<string, unknown> | undefined;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    producedBy: {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    };
    runId: string;
    startedAt: number;
    endedAt: number;
    args: string[];
    summary: {
        written: number;
        skipped: number;
        failed: number;
        stagedBytes?: number | undefined;
    };
    images?: {
        path: string;
        outcome: "written" | "skipped" | "failed";
        error?: string | undefined;
        imageId?: string | undefined;
        durationMs?: number | undefined;
    }[] | undefined;
    failures?: {
        error: string;
        path: string;
    }[] | undefined;
    stages?: {
        name: string;
        ts: number;
        fields?: Record<string, unknown> | undefined;
    }[] | undefined;
}, {
    producedBy: {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                big: number;
                proxy: number;
                grid: number;
            };
            libjxl?: string | undefined;
        };
    };
    runId: string;
    startedAt: number;
    endedAt: number;
    args: string[];
    summary: {
        written: number;
        skipped: number;
        failed: number;
        stagedBytes?: number | undefined;
    };
    images?: {
        path: string;
        outcome: "written" | "skipped" | "failed";
        error?: string | undefined;
        imageId?: string | undefined;
        durationMs?: number | undefined;
    }[] | undefined;
    failures?: {
        error: string;
        path: string;
    }[] | undefined;
    stages?: {
        name: string;
        ts: number;
        fields?: Record<string, unknown> | undefined;
    }[] | undefined;
}>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type CliEvent = {
    type: "batch-start";
    runId: string;
    totalFiles: number;
    concurrency: number;
} | {
    type: "image-start";
    runId: string;
    path: string;
    imageId: string;
} | {
    type: "image-done";
    runId: string;
    path: string;
    outcome: "written" | "skipped";
    durationMs: number;
} | {
    type: "image-failed";
    runId: string;
    path: string;
    error: {
        message: string;
        stack?: string;
        code?: string;
    };
} | {
    type: "batch-end";
    runId: string;
    written: number;
    skipped: number;
    failed: number;
    durationMs: number;
} | {
    type: "stage";
    runId: string;
    name: string;
    ts: number;
    fields?: Record<string, unknown>;
} | {
    type: "gc-result" | "validate-result" | "rm-result" | "migrate-result";
    [k: string]: unknown;
};
export declare function parseManifest(text: string | Uint8Array): Manifest;
/** Canonical VALUE-LOSSLESS serialization of a manifest to JSON text. Every field zod passed
 *  through — including unknown extension fields kept via `.passthrough()` — is preserved by VALUE:
 *  writing with manifestToJson and re-reading with parseManifest is a faithful round trip for the
 *  complete schema. Note: only the VALUES are guaranteed; the emit order of unknown keys normalizes
 *  on re-emit (JSON.stringify follows the object's own key order, not the original text's). This is
 *  the canonical persisted representation on `.json` paths. */
export declare function manifestToJson(manifest: Manifest, pretty?: boolean): string;
export declare function parseGalleryIndex(text: string | Uint8Array): GalleryIndex;
export declare function makeProducedBy(): ProducedBy;
export declare const cliArgsSchema: z.ZodObject<{
    out: z.ZodString;
    proxy: z.ZodEffects<z.ZodOptional<z.ZodString>, number | undefined, string | undefined>;
    force: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    concurrency: z.ZodEffects<z.ZodOptional<z.ZodString>, number | undefined, string | undefined>;
    "mem-budget-mb": z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
    shard: z.ZodEffects<z.ZodOptional<z.ZodString>, string | undefined, string | undefined>;
    tier: z.ZodDefault<z.ZodOptional<z.ZodEnum<["simd", "scalar", "auto"]>>>;
    tiling: z.ZodDefault<z.ZodOptional<z.ZodEnum<["adaptive", "tile-all"]>>>;
    "reindex-only": z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    "encoder-threads": z.ZodEffects<z.ZodOptional<z.ZodString>, number | undefined, string | undefined>;
    verbose: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    "verify-hash": z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    "dry-run": z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    explain: z.ZodOptional<z.ZodString>;
    "timeout-ms": z.ZodEffects<z.ZodOptional<z.ZodString>, number | undefined, string | undefined>;
    "accept-unsupported": z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    "profile-convergence": z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    gc: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    validate: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    rm: z.ZodOptional<z.ZodString>;
    resume: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    migrate: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    "migrate-layout": z.ZodOptional<z.ZodString>;
    "migrate-schema": z.ZodOptional<z.ZodString>;
    "suggest-migrations": z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    "chaos-test": z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    "retry-failed": z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    config: z.ZodOptional<z.ZodString>;
    json: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    "runlog-keep": z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined>;
}, "strip", z.ZodTypeAny, {
    "profile-convergence": boolean;
    tiling: "adaptive" | "tile-all";
    out: string;
    force: boolean;
    "mem-budget-mb": number;
    tier: "simd" | "scalar" | "auto";
    "reindex-only": boolean;
    verbose: boolean;
    "verify-hash": boolean;
    "dry-run": boolean;
    "accept-unsupported": boolean;
    gc: boolean;
    validate: boolean;
    resume: boolean;
    migrate: boolean;
    "suggest-migrations": boolean;
    "chaos-test": boolean;
    "retry-failed": boolean;
    json: boolean;
    "runlog-keep": number;
    proxy?: number | undefined;
    concurrency?: number | undefined;
    shard?: string | undefined;
    "encoder-threads"?: number | undefined;
    explain?: string | undefined;
    "timeout-ms"?: number | undefined;
    rm?: string | undefined;
    "migrate-layout"?: string | undefined;
    "migrate-schema"?: string | undefined;
    config?: string | undefined;
}, {
    out: string;
    "profile-convergence"?: boolean | undefined;
    proxy?: string | undefined;
    tiling?: "adaptive" | "tile-all" | undefined;
    force?: boolean | undefined;
    concurrency?: string | undefined;
    "mem-budget-mb"?: string | undefined;
    shard?: string | undefined;
    tier?: "simd" | "scalar" | "auto" | undefined;
    "reindex-only"?: boolean | undefined;
    "encoder-threads"?: string | undefined;
    verbose?: boolean | undefined;
    "verify-hash"?: boolean | undefined;
    "dry-run"?: boolean | undefined;
    explain?: string | undefined;
    "timeout-ms"?: string | undefined;
    "accept-unsupported"?: boolean | undefined;
    gc?: boolean | undefined;
    validate?: boolean | undefined;
    rm?: string | undefined;
    resume?: boolean | undefined;
    migrate?: boolean | undefined;
    "migrate-layout"?: string | undefined;
    "migrate-schema"?: string | undefined;
    "suggest-migrations"?: boolean | undefined;
    "chaos-test"?: boolean | undefined;
    "retry-failed"?: boolean | undefined;
    config?: string | undefined;
    json?: boolean | undefined;
    "runlog-keep"?: string | undefined;
}>;
export type CliArgs = z.infer<typeof cliArgsSchema>;
/** Magic-byte signatures for adversarial unknown-RAW detection (colocated with Zod per Q6). // WU-5-8 handoff safe-concurrency

 *  Used only for Tier-3/5 fallback when native Tier-1 decode fails or ext unknown.
 *  Prefix matches (order: more specific first if needed).
 */
export declare const RAW_MAGIC_SIGNATURES: Array<{
    format: string;
    bytes: number[];
    offset: number;
}>;
export declare function detectFormatByMagic(bytes: Uint8Array): string | null;
//# sourceMappingURL=schema.d.ts.map