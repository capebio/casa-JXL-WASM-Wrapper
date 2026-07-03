/** Little-endian magics, byte-identical to casa_video.rs. */
export declare const CASV_MAGIC = 1447121731;
export declare const CASV_VERSION = 1;
export declare const CASV_HEADER_BYTES = 32;
export declare const CASV_INDEX_ENTRY_BYTES = 8;
export declare const CASV_FOOTER_MAGIC = 1179861315;
export declare const CASV_FOOTER_BYTES = 32;
export declare const CASV_RATE_BOX_MAGIC = 1381187907;
export declare const CASV_AUDIO_BOX_MAGIC = 1430344515;
/** An Ogg/Opus audio stream embedded in a footer-format .casv via the CSAU box. */
export interface CasvAudio {
    /** Raw Ogg/Opus bytes, ready for AudioContext.decodeAudioData(). */
    bytes: Uint8Array;
}
/** Index-entry flag bits (top nibble of the len field). */
export declare const CASV_PFRAME_FLAG = 2147483648;
export declare const CASV_BBOX_FLAG = 1073741824;
export declare const CASV_TILE_FLAG = 536870912;
export declare const CASV_REPLACE_FLAG = 268435456;
/** Header flags word. */
export declare const CASV_HDRFLAG_LOSSY = 1;
export declare const CASV_HDR_FABLE_FLAG = 2;
/** Tile payload: high bit of the leading tile-size u16 selects the v2 square atlas. */
export declare const CASV_TILE_V2_BIT = 32768;
export interface CasvHeader {
    width: number;
    height: number;
    frameCount: number;
    fpsNum: number;
    fpsDen: number;
    flags: number;
}
export interface CasvRate {
    lossy: boolean;
    fable: boolean;
    /** Butteraugli distance recorded by the encoder (0.1 steps), null if lossless/legacy. */
    distance: number | null;
    /** libjxl effort (1..10), 0 for lossless/legacy. */
    effort: number;
}
export declare function rateFromFlags(flags: number): CasvRate;
export interface CasvFrameEntry {
    /** Byte range of the frame payload within the file buffer. */
    offset: number;
    length: number;
    isPFrame: boolean;
    isBbox: boolean;
    isTile: boolean;
    isReplace: boolean;
}
/** Injected single-frame JXL decoder. Must return tightly-packed RGBA8. */
export type JxlFrameDecoder = (jxl: Uint8Array) => Promise<{
    rgba: Uint8Array;
    width: number;
    height: number;
}>;
/** Parse the 32-byte leading header. Null on bad magic/version/dims. */
export declare function parseCasvHeader(bytes: Uint8Array): CasvHeader | null;
export interface CasvFooter {
    indexOffset: number;
    width: number;
    height: number;
    frameCount: number;
    fpsNum: number;
    fpsDen: number;
}
/** Parse the trailing 32-byte footer of a streamed (footer-indexed) file. */
export declare function parseCasvFooter(bytes: Uint8Array): CasvFooter | null;
/** Rate flags of a streamed file's optional CASR box; null for legacy files. */
export declare function parseCasvRateBox(bytes: Uint8Array): number | null;
/**
 * Extract the Ogg/Opus payload from a footer-format .casv that contains a CSAU box.
 * Returns null if absent, file too short, or magic mismatch.
 */
export declare function parseCasvAudioBox(bytes: Uint8Array): Uint8Array | null;
/**
 * A parsed .casv: header info + frame index, over either container shape.
 * Header-format files use absolute payload offsets; footer-format files use
 * offsets relative to byte 0 of the file (payloads come first) — both resolve
 * to absolute ranges here.
 */
export declare class CasvReader {
    readonly header: CasvHeader;
    readonly rate: CasvRate;
    readonly audio: CasvAudio | null;
    private readonly entries;
    private constructor();
    get frameCount(): number;
    entry(i: number): CasvFrameEntry;
    /** Parse either container shape. Throws on malformed input. */
    static parse(bytes: Uint8Array): CasvReader;
    private static readIndex;
}
export interface CasvDecodedFrame {
    /** Tightly-packed RGBA8, width*height*4 bytes. */
    rgba: Uint8Array;
    width: number;
    height: number;
    index: number;
}
export interface PlayOptions {
    /**
     * Reuse one RGBA buffer across frames (zero-copy playback: paint each frame
     * before pulling the next). Default false: every frame is an independent copy.
     */
    reuseBuffer?: boolean;
}
/**
 * Sequential CASAVA/JOLT playback: yields every frame in order, compositing
 * REPLACE P-frames onto the running reconstruction. Supports bbox and tile
 * (v1 sliver + v2 square atlas) payloads.
 */
export declare function playCasv(bytes: Uint8Array, decodeJxl: JxlFrameDecoder, options?: PlayOptions): AsyncGenerator<CasvDecodedFrame>;
/** Decode every frame up front (tests / small clips). */
export declare function decodeCasvAll(bytes: Uint8Array, decodeJxl: JxlFrameDecoder): Promise<CasvDecodedFrame[]>;
//# sourceMappingURL=index.d.ts.map