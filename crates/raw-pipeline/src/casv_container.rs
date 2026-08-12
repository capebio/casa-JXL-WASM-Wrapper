//! S6 rider P3 — CASAVA (.casv) container **v2** scaffold: u64 offsets + I-frame seek
//! table, with a version-negotiating reader that also parses v1 bit-identically.
//!
//! This module is **pure byte manipulation** — it has NO `jxl-codec`/libjxl dependency, so
//! it compiles + tests under `--no-default-features`. It defines the *container* format only;
//! the encoder/decoder that produces the frame payloads lives in `casa_video.rs` (gated
//! behind `jxl-codec`). Wiring v2 into that encoder/decoder is the deferred follow-up (see
//! `docs/HANDOFF-S6-lod-roi-2026-07-06.md` and `docs/WAVE2-QUESTIONS-DEFERRED.md` §S6).
//!
//! ## Why v2
//!
//! The v1 index entry packs `[u32 offset][u32 len|flags]` (8 B) — the top nibble of `len`
//! carries the P-frame flags, so a file is capped at **4 GiB** and a frame at **256 MiB**.
//! v2 lifts both caps and adds a keyframe seek table.
//!
//! ## Byte layouts (all little-endian)
//!
//! ```text
//! v1 (compat, unchanged — produced by casa_video::assemble_header_casv):
//!   [32B header: magic|ver=1|w|h|frame_count|fps_num|fps_den|flags]
//!   [index: frame_count × 8B  → [u32 abs_offset][u32 len|flags(top nibble)] ]
//!   [data payloads in frame order]
//!
//! v2 (this module):
//!   [32B header: magic|ver=2|w|h|frame_count|fps_num|fps_den|flags]
//!   [index: frame_count × 16B → [u64 abs_offset][u32 len][u32 flags] ]
//!   [seek table: [u32 seek_count][seek_count × ([u32 frame_index][u64 byte_offset]) ] ]
//!   [data payloads in frame order]
//! ```
//!
//! The reader returns a unified [`CasvContainer`] for both versions; for v1 the keyframe
//! seek table is *synthesized* by scanning the P-frame flag, so downstream seeking is
//! version-agnostic.

// ── v1 constants (mirror casa_video.rs; pinned to casv-format.json by a test below) ──────
/// 'CASV' little-endian — shared magic for v1 and v2.
pub const CASV_MAGIC: u32 = 0x5641_5343;
/// The fixed 32-byte header size (shared v1/v2).
pub const CASV_HEADER_BYTES: usize = 32;
/// v1 container version.
pub const CASV_V1_VERSION: u32 = 1;
/// v1 index entry width.
pub const CASV_V1_INDEX_ENTRY_BYTES: usize = 8;
/// Top bit of a `len` field / a `flags` word: a P-frame (delta vs previous). Clear = I-frame.
pub const CASV_PFRAME_FLAG: u32 = 0x8000_0000;
/// v1 flag nibble stolen from the top of the `len` field (PFRAME|BBOX|TILE|REPLACE).
pub const CASV_V1_FLAG_BITS: u32 = 0xF000_0000;
/// Header-flags bit marking the whole file as the **FableBraid** (lossless, libjxl-free)
/// tier. Mirrors `casa_video::CASV_HDR_FABLE_FLAG`; pinned to `casv-format.json` below.
/// Shared so the wasm (browser, no-sidecar) FableBraid video encoder can set it without
/// pulling the native `jxl-codec` module.
pub const CASV_HDR_FABLE_FLAG: u32 = 0x0000_0002;

// ── v2 additions (promote into casv-format.json when P3 is fully wired — see handoff) ────
/// v2 container version.
pub const CASV2_VERSION: u32 = 2;
/// v2 index entry width: `[u64 offset][u32 len][u32 flags]`.
pub const CASV2_INDEX_ENTRY_BYTES: usize = 16;
/// v2 seek-table entry width: `[u32 frame_index][u64 byte_offset]`.
pub const CASV2_SEEK_ENTRY_BYTES: usize = 12;

// ── Parsed model ────────────────────────────────────────────────────────────────────────

/// One frame's location + type, normalized across container versions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameEntry {
    /// Absolute byte offset of the payload in the file.
    pub offset: u64,
    /// Payload length in bytes.
    pub len: u32,
    /// Frame flags (`CASV_PFRAME_FLAG` etc.). For v1 this is the `len` field's top nibble.
    pub flags: u32,
    /// True when this is an intra (I) frame — i.e. the P-frame flag is clear.
    pub keyframe: bool,
}

/// One keyframe seek-table entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SeekEntry {
    pub frame_index: u32,
    pub byte_offset: u64,
}

/// A fully parsed CASAVA container (v1 or v2), unified.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CasvContainer {
    pub version: u32,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub flags: u32,
    pub frames: Vec<FrameEntry>,
    /// Keyframe seek table — stored for v2, synthesized (by scanning I-frames) for v1.
    pub seek_table: Vec<SeekEntry>,
}

impl CasvContainer {
    /// The payload bytes for frame `index`, bounds-checked against `data`.
    pub fn frame_payload<'a>(&self, data: &'a [u8], index: usize) -> Option<&'a [u8]> {
        let f = self.frames.get(index)?;
        let start = usize::try_from(f.offset).ok()?;
        let end = start.checked_add(f.len as usize)?;
        data.get(start..end)
    }

    /// The frame index of the latest keyframe at or before `frame_index` — the entry a
    /// seeker must decode from. Uses the seek table (binary search); `None` if there is no
    /// keyframe at or before `frame_index`.
    pub fn latest_keyframe_at_or_before(&self, frame_index: u32) -> Option<usize> {
        // seek_table is ascending by frame_index.
        let mut lo = 0usize;
        let mut hi = self.seek_table.len();
        let mut found: Option<u32> = None;
        while lo < hi {
            let mid = (lo + hi) / 2;
            let fi = self.seek_table[mid].frame_index;
            if fi <= frame_index {
                found = Some(fi);
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        found.map(|fi| fi as usize)
    }
}

// ── Reads ───────────────────────────────────────────────────────────────────────────────

#[inline]
fn rd_u32(data: &[u8], o: usize) -> Option<u32> {
    data.get(o..o + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap()))
}
#[inline]
fn rd_u64(data: &[u8], o: usize) -> Option<u64> {
    data.get(o..o + 8).map(|b| u64::from_le_bytes(b.try_into().unwrap()))
}

/// Peek the container version from the 32-byte header. `None` on bad magic / short buffer.
pub fn container_version(data: &[u8]) -> Option<u32> {
    if data.len() < CASV_HEADER_BYTES || rd_u32(data, 0)? != CASV_MAGIC {
        return None;
    }
    rd_u32(data, 4)
}

/// Version-negotiating parse: dispatches on the header version to the v1 or v2 reader.
/// Returns a unified [`CasvContainer`]. `None` on any malformed / out-of-bounds input.
pub fn parse_container(data: &[u8]) -> Option<CasvContainer> {
    match container_version(data)? {
        CASV_V1_VERSION => parse_v1(data),
        CASV2_VERSION => parse_v2(data),
        _ => None,
    }
}

fn parse_header_common(data: &[u8]) -> Option<(u32, u32, u32, u32, u32, u32)> {
    // (width, height, frame_count, fps_num, fps_den, flags)
    let width = rd_u32(data, 8)?;
    let height = rd_u32(data, 12)?;
    let frame_count = rd_u32(data, 16)?;
    let fps_num = rd_u32(data, 20)?;
    let fps_den = rd_u32(data, 24)?;
    let flags = rd_u32(data, 28)?;
    if width == 0 || height == 0 || frame_count == 0 || fps_den == 0 {
        return None;
    }
    Some((width, height, frame_count, fps_num, fps_den, flags))
}

fn parse_v1(data: &[u8]) -> Option<CasvContainer> {
    let (width, height, frame_count, fps_num, fps_den, flags) = parse_header_common(data)?;
    let fc = frame_count as usize;
    let index_bytes = fc.checked_mul(CASV_V1_INDEX_ENTRY_BYTES)?;
    if data.len() < CASV_HEADER_BYTES.checked_add(index_bytes)? {
        return None;
    }
    let mut frames = Vec::with_capacity(fc);
    let mut seek_table = Vec::new();
    for i in 0..fc {
        let e = CASV_HEADER_BYTES + i * CASV_V1_INDEX_ENTRY_BYTES;
        let offset = rd_u32(data, e)? as u64;
        let len_field = rd_u32(data, e + 4)?;
        let frame_flags = len_field & CASV_V1_FLAG_BITS;
        let len = len_field & !CASV_V1_FLAG_BITS;
        let keyframe = frame_flags & CASV_PFRAME_FLAG == 0;
        // Validate the payload lies inside the file.
        let end = (offset as usize).checked_add(len as usize)?;
        if end > data.len() {
            return None;
        }
        if keyframe {
            seek_table.push(SeekEntry { frame_index: i as u32, byte_offset: offset });
        }
        frames.push(FrameEntry { offset, len, flags: frame_flags, keyframe });
    }
    Some(CasvContainer {
        version: CASV_V1_VERSION,
        width,
        height,
        fps_num,
        fps_den,
        flags,
        frames,
        seek_table,
    })
}

fn parse_v2(data: &[u8]) -> Option<CasvContainer> {
    let (width, height, frame_count, fps_num, fps_den, flags) = parse_header_common(data)?;
    let fc = frame_count as usize;
    let index_bytes = fc.checked_mul(CASV2_INDEX_ENTRY_BYTES)?;
    let index_end = CASV_HEADER_BYTES.checked_add(index_bytes)?;
    // Need the index + the seek_count word.
    if data.len() < index_end.checked_add(4)? {
        return None;
    }
    let mut frames = Vec::with_capacity(fc);
    for i in 0..fc {
        let e = CASV_HEADER_BYTES + i * CASV2_INDEX_ENTRY_BYTES;
        let offset = rd_u64(data, e)?;
        let len = rd_u32(data, e + 8)?;
        let frame_flags = rd_u32(data, e + 12)?;
        let keyframe = frame_flags & CASV_PFRAME_FLAG == 0;
        let end = usize::try_from(offset).ok()?.checked_add(len as usize)?;
        if end > data.len() {
            return None;
        }
        frames.push(FrameEntry { offset, len, flags: frame_flags, keyframe });
    }
    // Seek table.
    let seek_count = rd_u32(data, index_end)? as usize;
    let seek_bytes = seek_count.checked_mul(CASV2_SEEK_ENTRY_BYTES)?;
    let seek_end = index_end.checked_add(4)?.checked_add(seek_bytes)?;
    if data.len() < seek_end {
        return None;
    }
    let mut seek_table = Vec::with_capacity(seek_count);
    let mut prev: Option<u32> = None;
    for i in 0..seek_count {
        let e = index_end + 4 + i * CASV2_SEEK_ENTRY_BYTES;
        let frame_index = rd_u32(data, e)?;
        let byte_offset = rd_u64(data, e + 4)?;
        // Seek table must be ascending by frame_index and reference real frames.
        if frame_index >= frame_count {
            return None;
        }
        if let Some(p) = prev {
            if frame_index <= p {
                return None;
            }
        }
        prev = Some(frame_index);
        seek_table.push(SeekEntry { frame_index, byte_offset });
    }
    Some(CasvContainer {
        version: CASV2_VERSION,
        width,
        height,
        fps_num,
        fps_den,
        flags,
        frames,
        seek_table,
    })
}

// ── Write (v2) ──────────────────────────────────────────────────────────────────────────

/// A frame to write into a v2 container.
pub struct FrameSpec<'a> {
    pub payload: &'a [u8],
    /// Frame flags (`CASV_PFRAME_FLAG` etc.); `0` = intra keyframe.
    pub flags: u32,
}

/// Serialize a v2 container: header + 16-byte index + keyframe seek table + payloads.
/// The seek table is derived from the frames whose P-frame flag is clear.
pub fn write_container_v2(
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    header_flags: u32,
    frames: &[FrameSpec],
) -> Vec<u8> {
    let fc = frames.len();
    let index_bytes = fc * CASV2_INDEX_ENTRY_BYTES;
    let keyframes: Vec<usize> = frames
        .iter()
        .enumerate()
        .filter(|(_, f)| f.flags & CASV_PFRAME_FLAG == 0)
        .map(|(i, _)| i)
        .collect();
    let seek_bytes = 4 + keyframes.len() * CASV2_SEEK_ENTRY_BYTES;
    let data_start = CASV_HEADER_BYTES + index_bytes + seek_bytes;
    let total_payload: usize = frames.iter().map(|f| f.payload.len()).sum();

    let mut out = Vec::with_capacity(data_start + total_payload);
    // Header.
    out.extend_from_slice(&CASV_MAGIC.to_le_bytes());
    out.extend_from_slice(&CASV2_VERSION.to_le_bytes());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&(fc as u32).to_le_bytes());
    out.extend_from_slice(&fps_num.to_le_bytes());
    out.extend_from_slice(&fps_den.to_le_bytes());
    out.extend_from_slice(&header_flags.to_le_bytes());

    // Index: precompute absolute offsets.
    let mut offset = data_start as u64;
    let mut offsets = Vec::with_capacity(fc);
    for f in frames {
        offsets.push(offset);
        out.extend_from_slice(&offset.to_le_bytes());
        out.extend_from_slice(&(f.payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&f.flags.to_le_bytes());
        offset += f.payload.len() as u64;
    }

    // Seek table.
    out.extend_from_slice(&(keyframes.len() as u32).to_le_bytes());
    for &k in &keyframes {
        out.extend_from_slice(&(k as u32).to_le_bytes());
        out.extend_from_slice(&offsets[k].to_le_bytes());
    }

    // Payloads.
    for f in frames {
        out.extend_from_slice(f.payload);
    }
    debug_assert_eq!(out.len(), data_start + total_payload);
    out
}

// ── Write (v1) ──────────────────────────────────────────────────────────────────────────

/// Serialize a **v1** container: 32-B header + packed 8-B index
/// `[u32 abs_offset][u32 len|flags(top nibble)]` + payloads in frame order. This is the
/// single wasm-portable v1 writer — byte-identical to `casa_video::assemble_header_casv`
/// (proven by `write_container_v1_matches_native_layout`), so the browser (no-sidecar)
/// FableBraid encoder produces exactly what the native encoder does and the shipping
/// decoder plays it unchanged.
///
/// `entries` is `(flags, len)` per frame (`flags` = `CASV_PFRAME_FLAG` etc.); `header_flags`
/// carries e.g. `CASV_HDR_FABLE_FLAG`; `write_data` appends the concatenated payloads in one
/// pass (`total_data_len` sizes the single allocation).
///
/// **Panics** when a frame exceeds the v1 256 MiB len cap or the container the 4 GiB
/// offset cap: past either, the packed `len | flags` / `u32 offset` index silently
/// corrupts (flag nibble mislabeled, offsets wrapped) and the loss surfaces only at
/// playback. Callers with frames that big must use [`write_container_v2`].
pub fn write_container_v1(
    width: u32,
    height: u32,
    frame_count: u32,
    fps_num: u32,
    fps_den: u32,
    header_flags: u32,
    entries: &[(u32, u32)],
    total_data_len: usize,
    write_data: impl FnOnce(&mut Vec<u8>),
) -> Vec<u8> {
    let data_start = CASV_HEADER_BYTES + entries.len() * CASV_V1_INDEX_ENTRY_BYTES;
    let mut out = Vec::with_capacity(data_start + total_data_len);
    // 32-byte header (magic | ver=1 | w | h | frame_count | fps_num | fps_den | flags).
    out.extend_from_slice(&CASV_MAGIC.to_le_bytes());
    out.extend_from_slice(&CASV_V1_VERSION.to_le_bytes());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&frame_count.to_le_bytes());
    out.extend_from_slice(&fps_num.to_le_bytes());
    out.extend_from_slice(&fps_den.to_le_bytes());
    out.extend_from_slice(&header_flags.to_le_bytes());
    // Packed 8-byte index: absolute offset + (len with the flag nibble OR'd into the top).
    // Offset accumulates in u64 so the 4 GiB check below cannot itself wrap on 32-bit.
    let mut offset = data_start as u64;
    for &(flags, len) in entries {
        assert!(
            len & CASV_V1_FLAG_BITS == 0,
            "v1 frame len {len} exceeds the 256 MiB cap — use write_container_v2"
        );
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        out.extend_from_slice(&(len | flags).to_le_bytes());
        offset += len as u64;
    }
    assert!(
        offset <= u32::MAX as u64,
        "v1 container exceeds the 4 GiB offset cap — use write_container_v2"
    );
    write_data(&mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shared v1 constants this pure module re-declares must match casv-format.json
    /// (the K6#3 single source of truth) — same guard casa_video.rs applies, but this one
    /// runs in the light `--no-default-features` build (no libjxl).
    #[test]
    fn v1_constants_match_casv_format_json() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../casv-format.json");
        let json = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let pairs: [(&str, u64); 6] = [
            ("CASV_MAGIC", CASV_MAGIC as u64),
            ("CASV_VERSION", CASV_V1_VERSION as u64),
            ("CASV_HEADER_BYTES", CASV_HEADER_BYTES as u64),
            ("CASV_INDEX_ENTRY_BYTES", CASV_V1_INDEX_ENTRY_BYTES as u64),
            ("CASV_PFRAME_FLAG", CASV_PFRAME_FLAG as u64),
            ("CASV_HDR_FABLE_FLAG", CASV_HDR_FABLE_FLAG as u64),
        ];
        for (name, val) in pairs {
            let needle = format!("\"{name}\": {val}");
            assert!(json.contains(&needle), "casv-format.json missing `{needle}`");
        }
    }

    // Build v1 bytes exactly as casa_video::assemble_header_casv would, to prove the
    // version-negotiating reader parses v1 bit-identically (back-compat).
    fn build_v1(frames: &[(u32 /*flags*/, &[u8])], w: u32, h: u32) -> Vec<u8> {
        let fc = frames.len();
        let data_start = CASV_HEADER_BYTES + fc * CASV_V1_INDEX_ENTRY_BYTES;
        let mut out = Vec::new();
        out.extend_from_slice(&CASV_MAGIC.to_le_bytes());
        out.extend_from_slice(&CASV_V1_VERSION.to_le_bytes());
        out.extend_from_slice(&w.to_le_bytes());
        out.extend_from_slice(&h.to_le_bytes());
        out.extend_from_slice(&(fc as u32).to_le_bytes());
        out.extend_from_slice(&30u32.to_le_bytes()); // fps_num
        out.extend_from_slice(&1u32.to_le_bytes()); // fps_den
        out.extend_from_slice(&0u32.to_le_bytes()); // flags
        let mut offset = data_start as u32;
        for (flags, p) in frames {
            out.extend_from_slice(&offset.to_le_bytes());
            out.extend_from_slice(&((p.len() as u32) | flags).to_le_bytes());
            offset += p.len() as u32;
        }
        for (_, p) in frames {
            out.extend_from_slice(p);
        }
        out
    }

    #[test]
    fn write_container_v1_matches_native_layout() {
        // `write_container_v1` must be byte-identical to the hand-rolled v1 layout
        // (`build_v1`, which mirrors casa_video::assemble_header_casv). Same frames,
        // same fps (30/1) and header flags (0) build_v1 hardcodes.
        let f0: &[u8] = b"keyframe-0";
        let f1: &[u8] = b"pframe-1";
        let f2: &[u8] = b"keyframe-2-longer";
        let want = build_v1(&[(0, f0), (CASV_PFRAME_FLAG, f1), (0, f2)], 640, 480);

        let entries = [(0u32, f0.len() as u32), (CASV_PFRAME_FLAG, f1.len() as u32), (0u32, f2.len() as u32)];
        let data_len = f0.len() + f1.len() + f2.len();
        let got = write_container_v1(640, 480, 3, 30, 1, 0, &entries, data_len, |out| {
            out.extend_from_slice(f0);
            out.extend_from_slice(f1);
            out.extend_from_slice(f2);
        });
        assert_eq!(got, want, "write_container_v1 != native v1 layout");

        // And it round-trips through the reader with the fable header flag set.
        let fable = write_container_v1(
            640, 480, 3, 30, 1, CASV_HDR_FABLE_FLAG, &entries, data_len, |out| {
                out.extend_from_slice(f0);
                out.extend_from_slice(f1);
                out.extend_from_slice(f2);
            });
        let c = parse_container(&fable).expect("v1 parse");
        assert_eq!(c.version, CASV_V1_VERSION);
        assert_eq!(c.flags & CASV_HDR_FABLE_FLAG, CASV_HDR_FABLE_FLAG);
        assert_eq!(c.frame_payload(&fable, 0), Some(f0));
        assert_eq!(c.frame_payload(&fable, 1), Some(f1));
        assert_eq!(c.frame_payload(&fable, 2), Some(f2));
        assert!(c.frames[0].keyframe && !c.frames[1].keyframe && c.frames[2].keyframe);
    }

    #[test]
    fn parses_v1_back_compat() {
        let f0: &[u8] = b"keyframe-0";
        let f1: &[u8] = b"pframe-1";
        let f2: &[u8] = b"keyframe-2-longer";
        let bytes = build_v1(&[(0, f0), (CASV_PFRAME_FLAG, f1), (0, f2)], 640, 480);

        let c = parse_container(&bytes).expect("v1 parse");
        assert_eq!(c.version, CASV_V1_VERSION);
        assert_eq!((c.width, c.height), (640, 480));
        assert_eq!(c.frames.len(), 3);
        assert!(c.frames[0].keyframe && !c.frames[1].keyframe && c.frames[2].keyframe);
        assert_eq!(c.frame_payload(&bytes, 0), Some(f0));
        assert_eq!(c.frame_payload(&bytes, 1), Some(f1));
        assert_eq!(c.frame_payload(&bytes, 2), Some(f2));
        // Synthesized seek table: keyframes 0 and 2.
        assert_eq!(c.seek_table.len(), 2);
        assert_eq!(c.seek_table[0].frame_index, 0);
        assert_eq!(c.seek_table[1].frame_index, 2);
        assert_eq!(c.latest_keyframe_at_or_before(1), Some(0));
        assert_eq!(c.latest_keyframe_at_or_before(2), Some(2));
    }

    #[test]
    fn writes_and_reads_v2_round_trip() {
        let f0: &[u8] = b"I-frame-zero";
        let f1: &[u8] = b"P-frame-one";
        let f2: &[u8] = b"P-frame-two";
        let f3: &[u8] = b"I-frame-three";
        let frames = [
            FrameSpec { payload: f0, flags: 0 },
            FrameSpec { payload: f1, flags: CASV_PFRAME_FLAG },
            FrameSpec { payload: f2, flags: CASV_PFRAME_FLAG },
            FrameSpec { payload: f3, flags: 0 },
        ];
        let bytes = write_container_v2(1920, 1080, 24, 1, 0, &frames);

        let c = parse_container(&bytes).expect("v2 parse");
        assert_eq!(c.version, CASV2_VERSION);
        assert_eq!((c.width, c.height, c.fps_num, c.fps_den), (1920, 1080, 24, 1));
        assert_eq!(c.frames.len(), 4);
        assert_eq!(c.frame_payload(&bytes, 0), Some(f0));
        assert_eq!(c.frame_payload(&bytes, 1), Some(f1));
        assert_eq!(c.frame_payload(&bytes, 2), Some(f2));
        assert_eq!(c.frame_payload(&bytes, 3), Some(f3));
        // Keyframe seek table: frames 0 and 3.
        assert_eq!(c.seek_table.len(), 2);
        assert_eq!(c.seek_table[0].frame_index, 0);
        assert_eq!(c.seek_table[1].frame_index, 3);
        assert_eq!(c.latest_keyframe_at_or_before(2), Some(0));
        assert_eq!(c.latest_keyframe_at_or_before(3), Some(3));
        assert_eq!(c.latest_keyframe_at_or_before(9), Some(3));
    }

    #[test]
    fn v2_lifts_the_v1_offset_cap() {
        // A payload placed past the v1 4-GiB / 256-MiB caps is representable in v2.
        // (We don't allocate 4 GiB — we assert the field math, not a real file.)
        let big_offset: u64 = 5_000_000_000; // > u32::MAX
        let mut e = [0u8; CASV2_INDEX_ENTRY_BYTES];
        e[0..8].copy_from_slice(&big_offset.to_le_bytes());
        e[8..12].copy_from_slice(&300_000_000u32.to_le_bytes()); // > 256 MiB (v1 payload cap)
        e[12..16].copy_from_slice(&0u32.to_le_bytes());
        let off = u64::from_le_bytes(e[0..8].try_into().unwrap());
        let len = u32::from_le_bytes(e[8..12].try_into().unwrap());
        assert!(off > u32::MAX as u64);
        assert!(len > (1 << 28)); // exceeds the v1 28-bit len field
    }

    /// A len with the flag nibble set (≥ 2^28) would mislabel the frame type and
    /// corrupt the stored length — must die loudly at write time, not at playback.
    #[test]
    #[should_panic(expected = "256 MiB")]
    fn v1_len_over_cap_panics() {
        let entries = [(0u32, CASV_V1_FLAG_BITS)];
        write_container_v1(1, 1, 1, 30, 1, 0, &entries, 0, |_| {});
    }

    /// 17 × (256 MiB − 1) frames push the cumulative offset past u32::MAX without
    /// allocating any payload (write_data is a no-op — only the index math runs).
    #[test]
    #[should_panic(expected = "4 GiB")]
    fn v1_offset_over_cap_panics() {
        let len = (1u32 << 28) - 1;
        let entries = [(0u32, len); 17];
        write_container_v1(1, 1, 17, 30, 1, 0, &entries, 0, |_| {});
    }

    #[test]
    fn rejects_malformed() {
        assert!(parse_container(&[0u8; 8]).is_none()); // too short / bad magic
        // Good magic, unknown version.
        let mut b = [0u8; CASV_HEADER_BYTES + 4];
        b[0..4].copy_from_slice(&CASV_MAGIC.to_le_bytes());
        b[4..8].copy_from_slice(&99u32.to_le_bytes());
        assert!(parse_container(&b).is_none());
        // v2 header claiming a frame whose payload runs off the end.
        let frames = [FrameSpec { payload: b"x", flags: 0 }];
        let mut good = write_container_v2(2, 2, 1, 1, 0, &frames);
        good.truncate(good.len() - 1); // drop the last payload byte
        assert!(parse_container(&good).is_none());
    }
}
