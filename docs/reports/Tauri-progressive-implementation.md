# Tauri Progressive Implementation Summary

## What I found

The current browser-side "progressive preview" path is not true native JPEG XL progressive decoding. It is a workaround:

- source playback mode shows ORF-derived frames while encoding runs
- stream decode mode keeps retrying decode on growing JXL byte prefixes

That explains why the full-size image still appears only at the end in the stream path, and why it is much slower than source playback.

## Native libjxl support exists

The libjxl decoder API does expose the pieces needed for real progressive rendering:

- `JXL_DEC_PREVIEW_IMAGE`
- `JXL_DEC_FRAME_PROGRESSION`
- `JxlDecoderSetProgressiveDetail()`
- `JxlDecoderFlushImage()`

That means a decoder can keep state, receive more bytes, and flush intermediate image states as the codestream advances.

## Why the current wrappers do not solve it

The current browser stack uses high-level wrappers:

- `jpegxl-rs` exposes one-shot decode/encode APIs
- `jxl-oxide` is a separate pure-Rust decoder with its own model

Neither gives the direct native libjxl progressive event loop that is required for true incremental painting.

So the current browser implementation cannot be upgraded into native progressive decode by a small local tweak. It would need a new decoder binding.

## Tauri path

This repo already has a native Rust/Tauri lane, and that is the right place to wire in the real progressive decoder.

Why:

- Tauri commands can call Rust from the frontend
- the Tauri codebase already uses `jpegxl-rs`, `jpegxl-sys`, and `jxl-oxide`
- there is already a low-level libjxl progressive-DC decode example in `src-tauri/src/bench.rs`

So yes, this can be made to work in this repo.

## Best wrapper choice

The wrapper that would do the trick is a small Rust layer directly on top of `jpegxl-sys`.

I would not treat `jpegxl-rs` as the right layer for this, because its public API is currently centered on one-shot decode/encode, not the progressive state machine.

Recommended shape:

- keep the native decoder alive across chunks
- subscribe to `FRAME_PROGRESSION`
- set progressive detail explicitly
- call `JxlDecoderFlushImage()` on each progression event
- emit intermediate RGBA buffers back to the frontend

## Pros and cons

### Pros

- true codec-native progressive decode
- no repeated prefix re-decode loop
- full-size image can visibly develop as bytes arrive
- Tauri is the correct place to do the heavy lifting

### Cons

- more Rust/FFI work
- more state to manage
- more error handling and buffer management
- this is desktop-native first, not a drop-in browser fix

## Recommendation

Use the Tauri/native path for the "go for gold" implementation:

- add a progressive decoder module around `jpegxl-sys`
- expose it as a Tauri command
- stream partial RGBA updates to the UI
- keep the current browser demo as a comparison path

That is the shortest path to real progressive full-size rendering.
