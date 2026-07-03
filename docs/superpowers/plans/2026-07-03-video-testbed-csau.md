# Video Testbed + CSAU Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Ogg/Opus audio embedding (CSAU box) in the CASAVA format, a `casv_encode --video` mode that extracts frames and audio from any video file via FFmpeg, update the browser parser and lightbox for A/V sync, and build a sweep testbed (`tools/yt-testbed.mjs`) that encodes YouTube URLs or local video files at 27 quality×effort×dimension combinations and produces an HTML comparison report.

**Architecture:**
- New Rust primitives in `casa_video.rs`: `write_csau_box`, `parse_casv_audio_box`, and `encode_casv_video_with_audio` (footer-format, inserts CSAU after CASR before footer).
- `casv_encode --video` mode: FFmpeg pipe for frame extraction (PNG), separate audio extraction (Ogg/Opus), calls `encode_casv_video_with_audio`.
- `casv-web`: `parseCasvAudioBox` and `CasvReader.audio: CasvAudio | null`.
- Lightbox: WebAudio `decodeAudioData` + `AudioBufferSourceNode` for A/V sync, volume slider.
- `tools/yt-testbed.mjs`: 27-cell sweep (3 distances × 3 efforts × 3 dims), HTML report.

**Tech Stack:**
- Rust (std::process::Command, image crate v0.25), `raw-pipeline` crate, feature `jxl-codec`
- TypeScript (casv-web, bun:test)
- JavaScript (casv-lightbox, Web Audio API)
- Bun (yt-testbed.mjs, Bun.spawn)
- FFmpeg + yt-dlp (PATH dependencies)

---

## File Map

| File | Change |
|---|---|
| `crates/raw-pipeline/src/casa_video.rs` | Add CSAU constants, `write_csau_box`, `parse_casv_audio_box`, private `SliceFrameSource`, `encode_casv_video_with_audio` |
| `crates/raw-pipeline/src/bin/casv_encode.rs` | Add `--video` dispatch, `run_video_mode()` function |
| `packages/casv-web/src/index.ts` | Add `CASV_AUDIO_BOX_MAGIC`, `CasvAudio`, `parseCasvAudioBox`, `CasvReader.audio` field |
| `packages/casv-web/test/csau.test.ts` | New: CSAU parse tests (binary fixture helper) |
| `web/casv-lightbox/casv-lightbox.js` | Add audio state, WebAudio decode/play/pause/seek, volume slider wiring |
| `web/casv-lightbox/casv-lightbox.html` or `TEMPLATE` | Add volume slider element to transport bar |
| `tools/yt-testbed.mjs` | New: sweep harness + HTML report |

---

## Task 1: CSAU Box Primitives (Rust)

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs` (after existing constants ~line 201)

- [ ] **Step 1: Write the failing Rust test**

Add to the bottom of `crates/raw-pipeline/src/casa_video.rs`, inside a new test module:

```rust
#[cfg(test)]
#[cfg(feature = "jxl-codec")]
mod csau_tests {
    use super::*;

    #[test]
    fn csau_write_parse_roundtrip() {
        let fake_ogg = b"OggS\x00fake_audio_bytes";
        // 2 frames of 64×64 solid-grey RGB8
        let frame = vec![128u8; 64 * 64 * 3];
        let frames = vec![frame.clone(), frame];
        let opts = CasaVideoOptions {
            rate: VideoRate::Lossy(1.0),
            gop_len: 2,
            skip: SkipMode::Tile,
            tile: 16,
            effort: 1,
            thresh: Some(4),
            rate_control: None,
        };
        let casv = encode_casv_video_with_audio(&frames, 64, 64, 24, 1, &opts, Some(fake_ogg))
            .unwrap();
        let audio = parse_casv_audio_box(&casv).expect("CSAU box not found in output");
        assert_eq!(audio, fake_ogg.as_slice());
    }

    #[test]
    fn csau_absent_when_no_audio_given() {
        let frame = vec![128u8; 64 * 64 * 3];
        let frames = vec![frame.clone(), frame];
        let opts = CasaVideoOptions {
            rate: VideoRate::Lossy(1.0),
            gop_len: 2,
            skip: SkipMode::Tile,
            tile: 16,
            effort: 1,
            thresh: Some(4),
            rate_control: None,
        };
        let casv = encode_casv_video_with_audio(&frames, 64, 64, 24, 1, &opts, None).unwrap();
        assert!(parse_casv_audio_box(&casv).is_none(), "no CSAU box expected when ogg=None");
    }
}
```

- [ ] **Step 2: Confirm test fails**

Run:
```powershell
.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec -- csau_tests
```
Expected: `error[E0425]: cannot find function 'encode_casv_video_with_audio'` (functions not yet defined).

- [ ] **Step 3: Add CSAU constants and write_csau_box**

In `crates/raw-pipeline/src/casa_video.rs`, after `CASV_FOOTER_BYTES` (around line 201):

```rust
/// Magic for the audio box: 'CSAU' little-endian (bytes C S A U on disk).
pub const CASV_AUDIO_BOX_MAGIC: u32 = 0x5541_5343;
/// Byte count of the CSAU box header (magic + payload length field).
pub const CASV_AUDIO_BOX_HDR: usize = 8;

/// Append a CSAU box (8-byte header + Ogg/Opus payload) to a buffer.
/// Call this after the CASR box and before the CASV footer.
pub fn write_csau_box(out: &mut Vec<u8>, ogg_opus: &[u8]) {
    out.extend_from_slice(&CASV_AUDIO_BOX_MAGIC.to_le_bytes());
    out.extend_from_slice(&(ogg_opus.len() as u32).to_le_bytes());
    out.extend_from_slice(ogg_opus);
}
```

- [ ] **Step 4: Add parse_casv_audio_box**

In `crates/raw-pipeline/src/casa_video.rs`, after `write_csau_box`:

```rust
/// Extract the Ogg/Opus payload from a footer-format `.casv` that contains a CSAU box.
/// Returns `None` if absent, file too short, or magic mismatch.
pub fn parse_casv_audio_box(data: &[u8]) -> Option<&[u8]> {
    let f = parse_casv_footer(data)?;
    let idx_end = f.index_offset as usize
        + f.frame_count as usize * CASV_INDEX_ENTRY_BYTES;
    let footer_start = data.len() - CASV_FOOTER_BYTES;
    let mut pos = idx_end;
    // Skip optional CASR box.
    if pos + 8 <= footer_start {
        let magic = u32::from_le_bytes(data[pos..pos + 4].try_into().ok()?);
        if magic == CASV_RATE_BOX_MAGIC {
            pos += 8;
        }
    }
    // Check for CSAU.
    if pos + CASV_AUDIO_BOX_HDR > footer_start {
        return None;
    }
    let magic = u32::from_le_bytes(data[pos..pos + 4].try_into().ok()?);
    if magic != CASV_AUDIO_BOX_MAGIC {
        return None;
    }
    let len = u32::from_le_bytes(data[pos + 4..pos + 8].try_into().ok()?) as usize;
    let start = pos + CASV_AUDIO_BOX_HDR;
    if start + len > footer_start {
        return None;
    }
    Some(&data[start..start + len])
}
```

- [ ] **Step 5: Add SliceFrameSource (private) and encode_casv_video_with_audio**

In `crates/raw-pipeline/src/casa_video.rs`, after `parse_casv_audio_box`:

```rust
/// Private: pull frames from a `&[Vec<u8>]` slice for use with the streaming encoder.
struct SliceFrameSource<'a> {
    frames: &'a [Vec<u8>],
    i: usize,
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
}

impl<'a> VideoFrameSource for SliceFrameSource<'a> {
    fn dims(&self) -> (u32, u32) {
        (self.width, self.height)
    }
    fn fps(&self) -> (u32, u32) {
        (self.fps_num, self.fps_den)
    }
    fn next_frame(&mut self) -> Option<Vec<u8>> {
        if self.i < self.frames.len() {
            let f = self.frames[self.i].clone();
            self.i += 1;
            Some(f)
        } else {
            None
        }
    }
}

/// Encode frames to footer-format `.casv` with an optional Ogg/Opus audio track
/// embedded as a `CSAU` box between the CASR box and the CASV footer.
///
/// `frames` — interleaved RGB8 pixel data (`len == width * height * 3`) for each frame.
/// `ogg_opus` — full Ogg/Opus stream, or `None` for silent output.
pub fn encode_casv_video_with_audio(
    frames: &[Vec<u8>],
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    opts: &CasaVideoOptions,
    ogg_opus: Option<&[u8]>,
) -> Result<Vec<u8>, VideoError> {
    let mut src = SliceFrameSource {
        frames,
        i: 0,
        width,
        height,
        fps_num,
        fps_den,
    };
    let mut buf = encode_casv_video_streaming(&mut src, opts)?;
    if let Some(audio) = ogg_opus {
        // Insert CSAU between CASR (written by streaming encoder) and the 32-byte footer.
        let footer = buf.split_off(buf.len() - CASV_FOOTER_BYTES);
        write_csau_box(&mut buf, audio);
        buf.extend_from_slice(&footer);
    }
    Ok(buf)
}
```

- [ ] **Step 6: Run tests — expect PASS**

```powershell
.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec -- csau_tests
```
Expected:
```
test csau_tests::csau_write_parse_roundtrip ... ok
test csau_tests::csau_absent_when_no_audio_given ... ok
```

- [ ] **Step 7: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "feat(csau): CSAU box primitives — write/parse/encode_with_audio (Rust)"
```

---

## Task 2: casv_encode `--video` Mode

**Files:**
- Modify: `crates/raw-pipeline/src/bin/casv_encode.rs`

- [ ] **Step 1: Add imports**

At the top of `crates/raw-pipeline/src/bin/casv_encode.rs`, update the `use` statement:

```rust
use raw_pipeline::casa_video::{
    default_thresh_for_distance, encode_casv_video, encode_casv_video_with_audio,
    CasaVideoOptions, SkipMode, VideoRate,
};
```

- [ ] **Step 2: Add --video dispatch at the start of main()**

Replace the beginning of `main()` (lines 28–32, up to the first `fail` call) with:

```rust
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(|s| s.as_str()) == Some("--video") {
        run_video_mode(&args);
        return;
    }
    if args.len() < 11 {
        fail("usage: casv_encode <out.casv> <fps_num> <fps_den> <rate> <distance> <effort> <gop> <skip> <tile> <thresh|auto> <img...>\n       casv_encode --video <in> <out> <fps_num> <fps_den> <rate> <d> <e> <gop> <skip> <tile> <thresh> <dim>");
    }
    // ... (rest of existing main unchanged)
```

- [ ] **Step 3: Add run_video_mode function**

After `fn fail(...)`, before `fn main()`:

```rust
fn run_video_mode(args: &[String]) -> ! {
    // args[0] = "--video"
    // args[1] = input video path
    // args[2] = output .casv path
    // args[3] = fps_num (0 = auto-detect via ffprobe)
    // args[4] = fps_den
    // args[5] = rate ("auto" | "lossy" | "lossless")
    // args[6] = distance (f32)
    // args[7] = effort (u8)
    // args[8] = gop (u32)
    // args[9] = skip ("none" | "bbox" | "tile")
    // args[10] = tile size (u32, ≥8)
    // args[11] = thresh ("auto" | 0-255)
    // args[12] = dim ("exact" | integer long-side pixels)
    if args.len() < 13 {
        fail("usage: casv_encode --video <in> <out> <fps_num> <fps_den> <rate> <d> <e> <gop> <skip> <tile> <thresh> <dim>");
    }
    let in_video = &args[1];
    let out_casv = &args[2];
    let mut fps_num: u32 = args[3].parse().unwrap_or_else(|_| fail("bad fps_num"));
    let fps_den: u32 = args[4].parse().unwrap_or_else(|_| fail("bad fps_den"));
    let distance: f32 = args[6].parse().unwrap_or_else(|_| fail("bad distance"));
    let effort: u8 = args[7].parse().unwrap_or_else(|_| fail("bad effort"));
    let gop: u32 = args[8].parse().unwrap_or_else(|_| fail("bad gop"));
    let skip = match args[9].as_str() {
        "bbox" => SkipMode::Bbox,
        "tile" => SkipMode::Tile,
        "none" | "0" => SkipMode::None,
        other => fail(format!("bad skip '{other}'")),
    };
    let tile: u32 = args[10].parse().unwrap_or(32).max(8);
    let thresh: Option<u8> = if args[11] == "auto" {
        None
    } else {
        Some(args[11].parse().unwrap_or_else(|_| fail("bad thresh")))
    };
    let dim_str = args[12].as_str();

    // Auto-detect FPS if fps_num == 0.
    if fps_num == 0 {
        fps_num = probe_fps(in_video);
    }

    // Extract Ogg/Opus audio into a temp file.
    let audio_tmp = std::env::temp_dir().join("casv_audio_tmp.ogg");
    let audio_status = std::process::Command::new("ffmpeg")
        .args([
            "-i", in_video,
            "-vn", "-acodec", "libopus", "-f", "ogg",
            "-ar", "48000", "-ac", "2",
            "-y", audio_tmp.to_str().unwrap(),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    let ogg_bytes: Option<Vec<u8>> = match audio_status {
        Ok(s) if s.success() => std::fs::read(&audio_tmp).ok(),
        _ => {
            eprintln!("casv_encode: no audio track found, producing silent .casv");
            None
        }
    };
    let _ = std::fs::remove_file(&audio_tmp);

    // Extract frames as PNG stream via FFmpeg pipe.
    let png_data = extract_png_frames(in_video, dim_str);
    let frames_png = split_png_frames(&png_data);
    if frames_png.is_empty() {
        fail("no frames extracted from video");
    }

    // Decode each PNG to RGB8.
    let first_img = image::load_from_memory(frames_png[0])
        .unwrap_or_else(|e| fail(format!("decode first frame: {e}")));
    let (w, h) = first_img.dimensions();
    let frames: Vec<Vec<u8>> = frames_png.iter().map(|png| {
        image::load_from_memory(png)
            .unwrap_or_else(|e| fail(format!("decode png frame: {e}")))
            .to_rgb8()
            .into_raw()
    }).collect();

    let rate = match args[5].as_str() {
        "lossless" => VideoRate::Lossless,
        _ => VideoRate::Lossy(distance), // "auto" or "lossy"
    };
    let opts = CasaVideoOptions {
        rate,
        gop_len: gop.max(1),
        skip,
        tile,
        effort: effort.clamp(1, 10),
        thresh: Some(thresh.unwrap_or_else(|| default_thresh_for_distance(distance))),
        rate_control: None,
    };

    let ogg_ref = ogg_bytes.as_deref();
    let bytes = encode_casv_video_with_audio(
        &frames, w, h,
        fps_num.max(1), fps_den.max(1),
        &opts, ogg_ref,
    ).unwrap_or_else(|e| fail(format!("encode failed: {e:?}")));

    std::fs::write(out_casv, &bytes)
        .unwrap_or_else(|e| fail(format!("write {out_casv}: {e}")));
    println!("OK {} {}", bytes.len(), out_casv);
    std::process::exit(0);
}

fn probe_fps(video: &str) -> u32 {
    let out = std::process::Command::new("ffprobe")
        .args([
            "-v", "quiet",
            "-select_streams", "v:0",
            "-show_entries", "stream=r_frame_rate",
            "-of", "csv=p=0",
            video,
        ])
        .output()
        .unwrap_or_else(|_| return_30());
    let s = String::from_utf8_lossy(&out.stdout);
    let s = s.trim();
    if let Some((n, _d)) = s.split_once('/') {
        n.parse().unwrap_or(30)
    } else {
        s.parse().unwrap_or(30)
    }
}

fn return_30() -> std::process::Output {
    std::process::Output {
        status: std::process::ExitStatus::default(),
        stdout: b"30/1\n".to_vec(),
        stderr: vec![],
    }
}

fn extract_png_frames(video: &str, dim: &str) -> Vec<u8> {
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args(["-i", video]);
    if dim != "exact" {
        let n: u32 = dim.parse().unwrap_or(0);
        if n > 0 {
            cmd.args([
                "-vf",
                &format!(
                    "scale={n}:{n}:force_original_aspect_ratio=decrease,\
                     scale=trunc(iw/2)*2:trunc(ih/2)*2"
                ),
            ]);
        }
    }
    cmd.args(["-f", "image2pipe", "-vcodec", "png", "pipe:1"]);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
    let out = cmd.output().unwrap_or_else(|e| {
        eprintln!("casv_encode: ffmpeg failed: {e}");
        std::process::exit(1);
    });
    out.stdout
}

const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

fn split_png_frames(data: &[u8]) -> Vec<&[u8]> {
    let mut starts: Vec<usize> = Vec::new();
    let mut i = 0;
    while i + PNG_MAGIC.len() <= data.len() {
        if data[i..i + PNG_MAGIC.len()] == *PNG_MAGIC {
            starts.push(i);
            i += PNG_MAGIC.len();
        } else {
            i += 1;
        }
    }
    starts
        .windows(2)
        .map(|w| &data[w[0]..w[1]])
        .chain(starts.last().map(|&s| &data[s..]))
        .collect()
}
```

- [ ] **Step 4: Verify it compiles**

```powershell
.\build-msvc.ps1 build --features jxl-codec --bin casv_encode
```
Expected: `Finished` with no errors.

- [ ] **Step 5: Smoke-test on a real video**

Use one of the known local videos:
```powershell
.\build-msvc.ps1 run --features jxl-codec --bin casv_encode -- `
  --video "C:\995\Videos Ghana\20260602122032_074957AA Explosives front.MP4" `
  "C:\Temp\test_ghana.casv" `
  0 1 auto 1 3 8 tile 32 auto 512
```
Expected output: `OK <N> C:\Temp\test_ghana.casv` where N > 0.

- [ ] **Step 6: Commit**

```bash
git add crates/raw-pipeline/src/bin/casv_encode.rs
git commit -m "feat(casv_encode): --video mode — FFmpeg frame+audio extraction, CSAU embed, dim scaling"
```

---

## Task 3: casv-web CSAU Parser

**Files:**
- Modify: `packages/casv-web/src/index.ts`
- Create: `packages/casv-web/test/csau.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/casv-web/test/csau.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
  CasvReader,
  parseCasvAudioBox,
  CASV_AUDIO_BOX_MAGIC,
  CASV_RATE_BOX_MAGIC,
  CASV_FOOTER_BYTES,
  CASV_INDEX_ENTRY_BYTES,
} from "../src/index";

/**
 * Build a minimal valid footer-format .casv binary with an optional CSAU box.
 *
 * Layout: [1-byte fake payload][8-byte index][8-byte CASR][8+N-byte CSAU?][32-byte footer]
 *
 * Footer format (32 bytes):
 *   [0..8)  index_offset  u64 LE
 *   [8..12) width         u32 LE
 *   [12..16) height       u32 LE
 *   [16..20) frame_count  u32 LE
 *   [20..24) fps_num      u32 LE
 *   [24..28) fps_den      u32 LE
 *   [28..32) CASV_FOOTER_MAGIC u32 LE = 0x4653_4143
 */
function makeTestCasv(audio?: Uint8Array): Uint8Array {
  const CASV_FOOTER_MAGIC = 0x4653_4143;
  const FAKE_PAYLOAD = new Uint8Array([0xff]);

  // Index entry: payload at offset 0, len = 1
  const INDEX = new Uint8Array(CASV_INDEX_ENTRY_BYTES);
  const idv = new DataView(INDEX.buffer);
  idv.setUint32(0, 0, true); // payload offset = 0
  idv.setUint32(4, 1, true); // length = 1

  // CASR box
  const CASR = new Uint8Array(8);
  const cdv = new DataView(CASR.buffer);
  cdv.setUint32(0, CASV_RATE_BOX_MAGIC, true);
  cdv.setUint32(4, 0, true);

  // CSAU box (optional)
  const CSAU = audio
    ? (() => {
        const b = new Uint8Array(8 + audio.length);
        const dv = new DataView(b.buffer);
        dv.setUint32(0, CASV_AUDIO_BOX_MAGIC, true);
        dv.setUint32(4, audio.length, true);
        b.set(audio, 8);
        return b;
      })()
    : new Uint8Array(0);

  // Footer: index_offset = FAKE_PAYLOAD.length = 1
  const FOOTER = new Uint8Array(CASV_FOOTER_BYTES);
  const fdv = new DataView(FOOTER.buffer);
  fdv.setBigUint64(0, BigInt(FAKE_PAYLOAD.length), true); // index_offset = 1
  fdv.setUint32(8, 1, true);   // width
  fdv.setUint32(12, 1, true);  // height
  fdv.setUint32(16, 1, true);  // frame_count
  fdv.setUint32(20, 30, true); // fps_num
  fdv.setUint32(24, 1, true);  // fps_den
  fdv.setUint32(28, CASV_FOOTER_MAGIC, true);

  const parts = [FAKE_PAYLOAD, INDEX, CASR, CSAU, FOOTER];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

describe("parseCasvAudioBox", () => {
  test("returns audio bytes when CSAU present", () => {
    const fakeAudio = new Uint8Array([1, 2, 3, 4, 5]);
    const casv = makeTestCasv(fakeAudio);
    const result = parseCasvAudioBox(casv);
    expect(result).not.toBeNull();
    expect(result).toEqual(fakeAudio);
  });

  test("returns null when no CSAU box", () => {
    const casv = makeTestCasv(); // no audio
    expect(parseCasvAudioBox(casv)).toBeNull();
  });

  test("returns null on empty buffer", () => {
    expect(parseCasvAudioBox(new Uint8Array(0))).toBeNull();
  });
});

describe("CasvReader.audio", () => {
  test("is populated when CSAU box present", () => {
    const fakeAudio = new Uint8Array([0xog, 0x53, 0x00]);
    const casv = makeTestCasv(fakeAudio);
    const reader = CasvReader.parse(casv);
    expect(reader.audio).not.toBeNull();
    expect(reader.audio!.bytes).toEqual(fakeAudio);
  });

  test("is null when no CSAU box", () => {
    const casv = makeTestCasv();
    const reader = CasvReader.parse(casv);
    expect(reader.audio).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

```powershell
cd packages/casv-web && bun test test/csau.test.ts
```
Expected: `ImportError` or `TypeError` because `parseCasvAudioBox`, `CasvAudio`, and `CasvReader.audio` don't exist yet.

- [ ] **Step 3: Add CSAU constants and interface to index.ts**

In `packages/casv-web/src/index.ts`, after `CASV_RATE_BOX_MAGIC` (line 21):

```typescript
export const CASV_AUDIO_BOX_MAGIC = 0x5541_5343;

/** An Ogg/Opus audio stream embedded in a footer-format .casv via the CSAU box. */
export interface CasvAudio {
  /** Raw Ogg/Opus bytes, ready for AudioContext.decodeAudioData(). */
  bytes: Uint8Array;
}
```

- [ ] **Step 4: Add parseCasvAudioBox function**

In `packages/casv-web/src/index.ts`, after `parseCasvRateBox` (after line 140):

```typescript
/**
 * Extract the Ogg/Opus payload from a footer-format .casv that contains a CSAU box.
 * Returns null if absent, file too short, or magic mismatch.
 */
export function parseCasvAudioBox(bytes: Uint8Array): Uint8Array | null {
  const f = parseCasvFooter(bytes);
  if (f === null) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idxEnd = f.indexOffset + f.frameCount * CASV_INDEX_ENTRY_BYTES;
  const footerStart = bytes.byteLength - CASV_FOOTER_BYTES;
  let pos = idxEnd;
  // Skip optional CASR box.
  if (pos + 8 <= footerStart && u32(dv, pos) === CASV_RATE_BOX_MAGIC) {
    pos += 8;
  }
  // Check for CSAU.
  if (pos + 8 > footerStart) return null;
  if (u32(dv, pos) !== CASV_AUDIO_BOX_MAGIC) return null;
  const len = u32(dv, pos + 4);
  const start = pos + 8;
  if (start + len > footerStart) return null;
  return bytes.slice(start, start + len);
}
```

- [ ] **Step 5: Add audio field to CasvReader**

In `packages/casv-web/src/index.ts`:

1. Update `CasvReader` class definition. Change the class body to add `audio` field:

```typescript
export class CasvReader {
  readonly header: CasvHeader;
  readonly rate: CasvRate;
  readonly audio: CasvAudio | null;           // ← new field
  private readonly entries: CasvFrameEntry[];

  private constructor(
    header: CasvHeader,
    rate: CasvRate,
    entries: CasvFrameEntry[],
    audio: CasvAudio | null                   // ← new param
  ) {
    this.header = header;
    this.rate = rate;
    this.entries = entries;
    this.audio = audio;                       // ← assign
  }
```

2. In `static parse()`, update the **header-format** return (line 181):
```typescript
      return new CasvReader(header, rateFromFlags(header.flags), entries, null);
```

3. In `static parse()`, update the **footer-format** return (line 201):
```typescript
      const audioBytes = parseCasvAudioBox(bytes);
      const audio: CasvAudio | null = audioBytes ? { bytes: audioBytes } : null;
      return new CasvReader(h, rateFromFlags(flags), entries, audio);
```

- [ ] **Step 6: Build dist**

```powershell
cd packages/casv-web && bun run build
```
Expected: `dist/index.js` rebuilt, no TypeScript errors.

- [ ] **Step 7: Run all casv-web tests — expect all pass**

```powershell
bun test
```
Expected: existing 8 tests + 5 new CSAU tests all pass (13 total).

- [ ] **Step 8: Commit**

```bash
git add packages/casv-web/src/index.ts packages/casv-web/test/csau.test.ts
git commit -m "feat(casv-web): CSAU audio box parsing — parseCasvAudioBox + CasvReader.audio"
```

---

## Task 4: Lightbox A/V Sync

**Files:**
- Modify: `web/casv-lightbox/casv-lightbox.js`

- [ ] **Step 1: Add audio state to constructor**

In `casv-lightbox.js`, inside the `constructor(root)` body (after `this.el = {}`):

```js
    // Audio state (WebAudio API — populated when .casv contains a CSAU box)
    this.audioCtx  = null;   // AudioContext
    this.audioBuf  = null;   // AudioBuffer (decoded Ogg/Opus)
    this.audioSrc  = null;   // current AudioBufferSourceNode
    this.gainNode  = null;   // GainNode for volume
```

- [ ] **Step 2: Add audio setup in loadBytes()**

In `loadBytes()`, replace the line:
```js
    this.index = 0;
```
with:
```js
    this.index = 0;

    // Decode embedded Ogg/Opus audio (if CSAU box present).
    this._stopAudio();
    this.audioBuf = null;
    if (this.reader.audio) {
      try {
        if (!this.audioCtx) this.audioCtx = new AudioContext();
        this.gainNode = this.audioCtx.createGain();
        this.gainNode.connect(this.audioCtx.destination);
        // decodeAudioData requires a detached ArrayBuffer — .slice() copies it.
        const ab = this.reader.audio.bytes.buffer.slice(
          this.reader.audio.bytes.byteOffset,
          this.reader.audio.bytes.byteOffset + this.reader.audio.bytes.byteLength
        );
        this.audioBuf = await this.audioCtx.decodeAudioData(ab);
      } catch (e) {
        console.warn('casv-lightbox: audio decode failed:', e);
        this.audioBuf = null;
      }
    }
    if (this.el.vol) this.el.vol.style.display = this.audioBuf ? '' : 'none';
```

- [ ] **Step 3: Add _stopAudio() helper and wire _play()/_pause()/_seek()**

After `_seek(i) { ... }` (line 226), add the helper:

```js
  _stopAudio() {
    if (this.audioSrc) {
      try { this.audioSrc.stop(); } catch (_) {}
      this.audioSrc = null;
    }
  }
```

Modify `_play()` — add audio start after the `this.rafId = requestAnimationFrame(step);` line (line 215):

```js
    this.rafId = requestAnimationFrame(step);
    // Start audio at the position corresponding to the current frame.
    if (this.audioBuf && this.audioCtx && this.gainNode) {
      const fps = fpsOf(this.header) || 24;
      const offset = Math.max(0, this.index / fps);
      this.audioSrc = this.audioCtx.createBufferSource();
      this.audioSrc.buffer = this.audioBuf;
      this.audioSrc.connect(this.gainNode);
      this.audioSrc.start(0, offset);
    }
```

Modify `_pause()` — add `this._stopAudio();` as first line:

```js
  _pause() {
    this._stopAudio();
    this.playing = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.el.play) this.el.play.textContent = PLAY;
  }
```

Modify `_seek()` — add `this._stopAudio();` before re-render:

```js
  _seek(i) { this._stopAudio(); this._pause(); this._render(i); }
```

- [ ] **Step 4: Add volume slider to TEMPLATE**

In `TEMPLATE` (the template literal at the bottom of `casv-lightbox.js`), inside `<div class="casv-lb__transport">`, after the Loop label:

```html
  <label class="casv-lb__vol" style="display:none" data-el="vol">Vol
    <input data-el="volRange" type="range" min="0" max="1" step="0.05" value="1">
  </label>
```

- [ ] **Step 5: Wire volume slider in mount() and _wire()**

In `mount()`, add `vol` and `volRange` to the `this.el` object:

```js
      vol: $('vol'), volRange: $('volRange'),
```

In `_wire()`, after the loop listener, add:

```js
    if (this.el.volRange) {
      this.el.volRange.addEventListener('input', () => {
        if (this.gainNode) this.gainNode.gain.value = Number(this.el.volRange.value);
      });
    }
```

In `_renderControls()`, show/hide vol based on `audioBuf`:

```js
    if (this.el.vol) this.el.vol.style.display = this.audioBuf ? '' : 'none';
```

- [ ] **Step 6: Verify build (TypeScript-clean, no console errors)**

```powershell
cd C:/Foo/rcw-casv-lightbox
bun serve.ts &
# Then open: http://localhost:9000/web/casv-lightbox/casv-lightbox.html
# Load test_ghana.casv from Task 2 — verify audio plays (volume slider appears)
```

- [ ] **Step 7: Commit**

```bash
git add web/casv-lightbox/casv-lightbox.js
git commit -m "feat(lightbox): CSAU audio playback — WebAudio A/V sync, volume slider"
```

---

## Task 5: yt-testbed.mjs Sweep Harness

**Files:**
- Create: `tools/yt-testbed.mjs`

- [ ] **Step 1: Create the file with helpers**

Create `tools/yt-testbed.mjs`:

```javascript
#!/usr/bin/env bun
/**
 * yt-testbed.mjs — CASAVA encoding sweep testbed.
 *
 * Accepts YouTube URLs (yt-dlp download) or local video file paths.
 * Encodes each at 3 distances × 3 efforts × 3 dimensions = 27 cells.
 * Writes an HTML comparison report to <out>/<video-id>/report.html.
 *
 * Usage:
 *   bun tools/yt-testbed.mjs <url-or-path> [<url-or-path>...] [--out ./testbed-out] [--gop 8]
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, extname, join } from "path";

// ── Sweep axes ──────────────────────────────────────────────────────────────
const DISTANCES = [2, 1, 0.5];
const EFFORTS   = [1, 3, 4];
const DIMS      = [256, 512, 1080];

// ── CLI parse ───────────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);
const inputs = [];
let outDir = "./testbed-out";
let gop = 8;
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--out")      { outDir = rawArgs[++i]; }
  else if (rawArgs[i] === "--gop") { gop = Number(rawArgs[++i]); }
  else                              { inputs.push(rawArgs[i]); }
}
if (!inputs.length) {
  console.error("Usage: bun tools/yt-testbed.mjs <url-or-path>... [--out ./testbed-out] [--gop 8]");
  process.exit(1);
}

// ── Utilities ────────────────────────────────────────────────────────────────
function isUrl(s)  { return s.startsWith("http://") || s.startsWith("https://"); }

function sanitizeVideoId(input) {
  const raw = basename(input.replace(/\\/g, "/"), extname(input.replace(/\\/g, "/")));
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").slice(0, 60);
}

async function spawnCapture(cmd, args) {
  const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { text: text.trim(), exitCode: proc.exitCode };
}

async function spawnSilent(cmd, args, ignoreError = false) {
  const proc = Bun.spawn([cmd, ...args], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  if (proc.exitCode !== 0 && !ignoreError) {
    throw new Error(`${cmd} exited with ${proc.exitCode}`);
  }
  return proc.exitCode;
}

// ── Video acquisition ────────────────────────────────────────────────────────
async function downloadYtDlp(url, workDir) {
  console.log(`  yt-dlp download: ${url}`);
  await spawnSilent("yt-dlp", [
    url,
    "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    "-o", "source.%(ext)s",
    "-P", workDir,
    "--no-playlist",
  ]);
  const files = readdirSync(workDir).filter(f => f.startsWith("source."));
  if (!files.length) throw new Error("yt-dlp: no source file downloaded");
  return join(workDir, files[0]);
}

// ── FFprobe ──────────────────────────────────────────────────────────────────
async function probeVideo(sourceFile) {
  const { text } = await spawnCapture("ffprobe", [
    "-v", "quiet", "-print_format", "json",
    "-show_streams", "-show_format",
    sourceFile,
  ]);
  const data = JSON.parse(text || "{}");
  const vs = (data.streams || []).find(s => s.codec_type === "video");
  const [fpsN, fpsD] = (vs?.r_frame_rate || "30/1").split("/").map(Number);
  const duration = parseFloat(data.format?.duration ?? "0");
  return {
    fpsN, fpsD,
    fps: fpsD > 0 ? fpsN / fpsD : 30,
    duration,
    width: vs?.width ?? 0,
    height: vs?.height ?? 0,
  };
}

// ── Frame grab extraction ────────────────────────────────────────────────────
async function extractFrameGrab(sourceFile, timestamp, dim, outPng) {
  const vf = dim === "exact"
    ? "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    : `scale=${dim}:${dim}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
  await spawnSilent("ffmpeg", [
    "-ss", String(Math.max(0, timestamp)),
    "-i", sourceFile,
    "-frames:v", "1",
    "-vf", vf,
    "-y", outPng,
  ], true /* ignore error */);
}

// ── Encode one cell ──────────────────────────────────────────────────────────
async function encodeCell(sourceFile, outCasv, fps, d, e, gop, dim) {
  // casv_encode --video <in> <out> <fps_num> <fps_den> <rate> <d> <e> <gop> <skip> <tile> <thresh> <dim>
  const [fpsN, fpsD] = fps;
  await spawnSilent("casv_encode", [
    "--video", sourceFile, outCasv,
    String(fpsN), String(fpsD),
    "auto",          // rate
    String(d),       // distance
    String(e),       // effort
    String(gop),     // gop
    "tile",          // skip
    "32",            // tile size
    "auto",          // thresh
    String(dim),     // long-side dimension
  ]);
}

// ── Sweep ────────────────────────────────────────────────────────────────────
async function runSweep(sourceFile, videoId, workDir, probe, gopSize) {
  const results = [];
  let n = 0;
  const total = DIMS.length * DISTANCES.length * EFFORTS.length;

  for (const dim of DIMS) {
    for (const d of DISTANCES) {
      for (const e of EFFORTS) {
        n++;
        const stem    = `${videoId}_d${d}_e${e}_dim${dim}`;
        const outCasv = join(workDir, `${stem}.casv`);
        const outPng  = join(workDir, `${stem}.png`);
        process.stdout.write(`  [${n}/${total}] dim=${dim} d=${d} e=${e} … `);

        const t0 = Date.now();
        let encOk = true;
        try {
          await encodeCell(sourceFile, outCasv, [probe.fpsN, probe.fpsD], d, e, gopSize, dim);
        } catch (err) {
          encOk = false;
          console.log(`FAILED (${err.message})`);
        }
        const encMs    = Date.now() - t0;
        const fileBytes = encOk && existsSync(outCasv) ? statSync(outCasv).size : 0;
        if (encOk) console.log(`${(fileBytes / 1024).toFixed(0)} KB  ${(encMs / 1000).toFixed(1)}s`);

        // Frame grab from source at 1/3 of video.
        if (probe.duration > 0) {
          await extractFrameGrab(sourceFile, probe.duration / 3, dim, outPng);
        }

        results.push({ dim, d, e, stem, encMs, fileBytes, encOk });
      }
    }
  }
  return results;
}

// ── HTML report ──────────────────────────────────────────────────────────────
function fmtBytes(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB`
                           : `${(n / 1024).toFixed(0)} KB`;
}
function fmtMs(ms) {
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)}s`;
}

function generateReport(videoId, sourceInput, probe, results) {
  const byKey = {};
  for (const r of results) byKey[`${r.dim}_${r.d}_${r.e}`] = r;

  const cols = [];
  for (const d of DISTANCES) for (const e of EFFORTS) cols.push({ d, e });

  const thead = `<tr><th>dim</th>${cols.map(c => `<th>d=${c.d}<br>e=${c.e}</th>`).join("")}</tr>`;
  const tbody = DIMS.map(dim => {
    const cells = cols.map(({ d, e }) => {
      const r = byKey[`${dim}_${d}_${e}`];
      if (!r || !r.encOk) return `<td class="err">ERR</td>`;
      const w = Math.min(dim, 200);
      return `<td>
  <img src="./${r.stem}.png" width="${w}" loading="lazy" onerror="this.style.display='none'">
  <div class="s">${fmtBytes(r.fileBytes)}<br>${fmtMs(r.encMs)} enc</div>
</td>`;
    }).join("\n");
    return `<tr><th>${dim}</th>${cells}</tr>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>CASAVA Testbed — ${videoId}</title>
<style>
  body { background:#111; color:#eee; font:13px/1.4 monospace; margin:1.5em; }
  h1 { color:#7cf; margin:.3em 0; }
  .info { color:#888; margin-bottom:1em; font-size:12px; }
  table { border-collapse:collapse; }
  th,td { border:1px solid #333; padding:5px 7px; vertical-align:top; text-align:center; }
  th { background:#1a1a1a; color:#aaa; font-weight:normal; }
  td { min-width:${Math.min(DIMS[0], 200) + 16}px; }
  td.err { color:#f66; background:#1a0000; }
  td img { display:block; margin:0 auto 4px; }
  .s { color:#aaa; font-size:11px; line-height:1.3; }
</style>
</head>
<body>
<h1>CASAVA Testbed — ${videoId}</h1>
<div class="info">
  Source: ${sourceInput}<br>
  ${probe.width}×${probe.height} &middot; ${probe.fps.toFixed(2)} fps &middot; ${probe.duration.toFixed(1)}s<br>
  Rows = long-side dimension &middot; Columns = distance × effort (quality × speed)
</div>
<table>
  <thead>${thead}</thead>
  <tbody>${tbody}</tbody>
</table>
</body>
</html>`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const indexLinks = [];

for (const input of inputs) {
  console.log(`\n▶ ${input}`);
  const ytMode = isUrl(input);
  const videoId = ytMode
    ? (input.match(/[?&]v=([^&]+)/)?.[1] ?? sanitizeVideoId(input))
    : sanitizeVideoId(input);

  const workDir = join(outDir, videoId);
  mkdirSync(workDir, { recursive: true });

  let sourceFile;
  if (ytMode) {
    sourceFile = await downloadYtDlp(input, workDir);
  } else {
    if (!existsSync(input)) { console.error(`  ERROR: file not found: ${input}`); continue; }
    sourceFile = input;
  }

  console.log(`  probe: ${sourceFile}`);
  const probe = await probeVideo(sourceFile);
  console.log(`  ${probe.width}×${probe.height}  ${probe.fps.toFixed(2)} fps  ${probe.duration.toFixed(1)}s`);

  const results = await runSweep(sourceFile, videoId, workDir, probe, gop);

  const reportPath = join(workDir, "report.html");
  writeFileSync(reportPath, generateReport(videoId, input, probe, results));
  console.log(`  ✓ report: ${reportPath}`);
  indexLinks.push({ videoId, reportPath: `./${videoId}/report.html` });
}

// Write top-level index if multiple inputs.
if (indexLinks.length > 1) {
  const indexHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>CASAVA Testbed Index</title>
<style>body{background:#111;color:#eee;font:14px monospace;margin:2em}a{color:#7cf}</style>
</head><body><h1>CASAVA Testbed</h1><ul>
${indexLinks.map(l => `<li><a href="${l.reportPath}">${l.videoId}</a></li>`).join("\n")}
</ul></body></html>`;
  writeFileSync(join(outDir, "index.html"), indexHtml);
  console.log(`\n✓ index: ${join(outDir, "index.html")}`);
}
```

- [ ] **Step 2: Smoke-test with one local video (short clip)**

```powershell
bun tools/yt-testbed.mjs "C:\995\Videos Ghana\20260602122032_074957AA Explosives front.MP4" --out C:\Temp\testbed-out --gop 8
```
Expected: prints 27 progress lines, writes `C:\Temp\testbed-out\<id>\report.html`.

- [ ] **Step 3: Open report.html in browser**

```powershell
Start-Process "C:\Temp\testbed-out\<id>\report.html"
```
Expected: dark-background HTML table with 3 rows × 9 cells, frame grabs, file sizes, encode times.

- [ ] **Step 4: Test with second local video**

```powershell
bun tools/yt-testbed.mjs `
  "C:\995\Videos Ghana\20260602122032_074957AA Explosives front.MP4" `
  "C:\995\2026-05-15 Timber Nigeria\videos\PXL_20260503_061731369 Timber Nigeria.mp4" `
  --out C:\Temp\testbed-out
```
Expected: two subdirectories + `C:\Temp\testbed-out\index.html` linking both reports.

- [ ] **Step 5: Commit**

```bash
git add tools/yt-testbed.mjs
git commit -m "feat(testbed): yt-testbed.mjs — 27-cell CASAVA sweep, HTML report, local+YouTube inputs"
```

---

## Task 6: Final Integration Check

- [ ] **Step 1: Run all casv-web tests**

```powershell
cd packages/casv-web && bun test
```
Expected: all tests pass (existing 8 + new 5 = 13+).

- [ ] **Step 2: Run Rust CSAU tests**

```powershell
.\build-msvc.ps1 test -p raw-pipeline --features jxl-codec -- csau_tests
```
Expected: 2 tests pass.

- [ ] **Step 3: End-to-end audio check**

1. Encode a local video with audio: `casv_encode --video "C:\995\Videos Ghana\..." test_audio.casv 0 1 auto 1 3 8 tile 32 auto 1080`
2. Load `test_audio.casv` in lightbox (`bun serve.ts`, open browser, drag-drop file)
3. Verify: volume slider appears, audio plays on ▶ button, pauses on ⏸

- [ ] **Step 4: Rebuild dist and commit all**

```powershell
cd packages/casv-web && bun run build
cd ../..
git add packages/casv-web/dist/
git commit -m "build(casv-web): rebuild dist with CSAU audio support"
```

---

## Self-Review Notes

- `encode_casv_video_streaming` (footer-format) always writes CASR before the footer — confirmed from source. CSAU is inserted between CASR and footer by `split_off` + re-append.
- `VideoRate::Lossy(distance)` takes `f32`, not `f64` — confirmed from casv_encode.rs.
- `SkipMode::None` is the right variant for skip="0" (testbed uses "tile").
- `parseCasvAudioBox` in JS uses `bytes.slice()` (copies) not `subarray()` — safe for transfer to AudioContext.decodeAudioData which detaches the buffer.
- `_seek()` calls `_stopAudio()` then `_pause()` — `_pause()` also calls `_stopAudio()` which is a no-op double-stop (harmless, both catch the exception from calling stop() on an already-stopped node).
- Test binary helper `makeTestCasv` uses `BigInt` for `index_offset` (u64 in footer) — required because JS `DataView.setBigUint64` is used.
- `probe_fps` in Rust returns only `fps_num` (fps_den from CLI is used directly) — this is correct since casv_encode --video receives both from the testbed.
