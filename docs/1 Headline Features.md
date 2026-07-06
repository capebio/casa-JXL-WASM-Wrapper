### 16-bit / HDR, Measured Honestly: the Codec Comparison Now Runs at Full Bit Depth (2026-07-05)

*Files: src/lib.rs, crates/raw-pipeline/src/pipeline.rs, packages/jxl-wasm/src/bridge.cpp, benchmark/metrics16.mjs, benchmark/codec-adapters.mjs, CodecPaperFullTest.mjs*

Until now, the tool that compares image formats — JPEG XL against JPEG, WebP, AVIF and PNG — only ever looked at ordinary 8-bit pictures. "16-bit / HDR" was a single tick in a capability table: a claim that the formats *can* carry high-bit-depth imagery, with no actual measurement behind it. That gap matters for exactly the images this project exists to serve — RAW camera captures, whose sensors record far more tonal gradation than an 8-bit screen can show, and where the subtle shading in a petal or a sky is the part you least want to throw away.

The obstacle was subtle. You cannot judge 16-bit quality with an 8-bit ruler: a score that only understands 256 brightness levels quantises the extra detail away before it measures anything, so a "16-bit" comparison built on 8-bit tools would just be the 8-bit comparison wearing a hat — the same numbers, no new information. The whole path had to learn to work at full depth, from the source picture to the final score.

It now does, end to end. The source is the converter's own RAW render, which already computes in high precision internally and only rounds to 8 bits at the very last step — so producing a true 16-bit picture was a matter of *not* discarding those low bits. We checked this the strict way: reduce the new 16-bit render back to 8 bits and it matches the shipped 8-bit output for **99.9999%** of colour values (the remainder off by a single unit of rounding). The high-bit-depth picture is then encoded four ways — our JPEG XL in 16-bit mode, AVIF at 10- and 12-bit, and PNG-16 as a **bit-exact lossless** floor — and scored by three full-depth metrics: 16-bit PSNR, 16-bit SSIM, and a 16-bit version of the perceptual "Butteraugli" distance.

That last metric is the delicate one. Rather than re-derive it, we cloned the existing, trusted 8-bit scorer and changed exactly one thing — the step that reads a pixel's colour — leaving every downstream calculation untouched. The proof that the clone is faithful: feed both versions the *same* picture (an 8-bit image promoted to 16-bit without adding or losing any information) and they return **byte-identical scores** — a relative difference of **0.0000**. A picture compared against itself scores exactly zero, as it must.

The build was designed so the risky part can never sink the ship. The 16-bit perceptual scorer needs a full rebuild of the compression engine — the step most likely to go wrong on a given machine. It was made *additive*: if that rebuilt engine isn't present, the perceptual score is simply left out and the comparison carries on with 16-bit PSNR and SSIM, which need no rebuild at all. There is no single point of failure, and the result — real rate-distortion curves for high-bit-depth imagery, with a lossless PNG-16 floor beneath them — comes out either way. True HDR (the wide-gamut, extreme-brightness kind with PQ/HLG signalling) is the next step and is written up as a follow-up; the floating-point plumbing it needs is already in place.

### A Fast, Full-Size "Preview Proxy" for Video Editing — and a 5× Encoder Slowdown Fixed Underneath (2026-07-05)

*Files: crates/raw-pipeline/src/jxl_casaencoder.rs, crates/raw-pipeline/src/casa_video.rs, crates/raw-pipeline/src/bin/casv_encode.rs, web/casv-lightbox/*

Editing a CASAVA video wants a lightweight stand-in you can scrub through instantly — without paying to encode the full-quality file every time you nudge something. The new **preview proxy** is exactly that: a version of the clip that stores a half- or quarter-resolution picture inside, but still declares the *full* frame size, so it decodes back to full size and lines up pixel-for-pixel with the finished video. Because every frame stands entirely on its own, you can jump to any point in the timeline with zero wait. And because the encoder only ever touches a quarter (or a sixteenth) of the pixels, the proxy is far quicker to make. On a 1280×720, 48-frame clip: the half-size proxy encodes **2.18× faster and is 51% smaller**; the quarter-size proxy is **4.09× faster and 76% smaller** — and both decode back to the full 1280×720 through the exact same viewer path as a normal file, so nothing downstream has to change.

Getting there meant fixing a genuinely backwards result underneath. The obvious way to make a smaller file is to ask the JPEG XL library to downsample the picture for you — but measured head-to-head, that built-in path was about **five times *slower* than encoding the picture at full size**, which is absurd for coding a quarter of the pixels. The library, handed a full-resolution image, was running an expensive full-resolution "fitting" pass before shrinking. We now do it the other way around: shrink the picture ourselves with a cheap pixel average, hand the library the already-small image, and mark it "already downsampled" so the decoder upsamples it back on the way out. Same file size, same quality — but the encoder never sees the big picture, so a **0.2× slowdown became a 2.4× speedup**, with the output matching the slow path to a fraction of a decibel.

A fair question is why not just use the "free" low-resolution preview that JPEG XL already produces — the so-called DC image, a one-eighth-size thumbnail that falls out of a normal encode at no extra cost. The answer is that the DC image is only free *if you are already encoding the full-quality file*, and during editing that full encode is precisely the slow thing you are trying to avoid. It is also very coarse (one-eighth size, and blocky) — fine for a tiny thumbnail, too rough to scrub against. The proxy wins in the exact situation editing puts you in: you are skipping the full encode, and you want a crisp half-size working copy you can navigate frame-accurately. The two are complements, not rivals — the DC thumbnail for a free preview at final export, the proxy for the working copy while you edit.

The change is deliberately safe: asked for a downsample factor of 1 it produces byte-for-byte the same file as before, so it cannot alter existing output; each proxy frame was verified to decode to the full declared size and to be independently seekable. Forty-one video-codec tests and twenty-one lightbox tests pass, and the speed figures above come from interleaved back-to-back timing runs recorded alongside the code. It is wired end to end — through the desktop encoder (a `proxy2` / `proxy4` mode) and the lightbox's one-click **Preview proxy** button.

### Lightbox Photos Fixed: Progressive Decode No Longer Throws, and Two Photos Can't Collide Anymore (2026-06-17)

*Files: web/jxl-decode-worker.js, web/main.js*

When you open a photo in the big viewer, the program decodes it in the background and hands the finished pixels to the screen. Those pixels have to be in one specific format the browser's drawing function will accept — and the background decoder was handing over the *wrong* format. The browser's "paint this image" call flatly refuses that format and raises an error. The viewer's smooth, sharpens-as-it-loads path was hitting that error every time; it only ever looked like it worked because a slower backup decoder happened to produce the right format by accident. We changed the decoder to always produce the format the screen wants, and to do it without making an extra copy of the picture wherever that copy can be avoided. A photo is large — tens of millions of pixels — so not copying it needlessly matters.

The second fix is subtler but more important. The program decodes photos one at a time through a single helper, and keeps a waiting line for the rest. The helper was telling the waiting line "I'm free, send the next one" too early — the moment it sent out an *early* progress signal (like the image's width and height, or a quick low-res preview), not when it had actually *finished*. So if you were flipping through a gallery, or the program was quietly pre-loading the next and previous pictures, a second decode could start on top of the one still running. Two photos sharing the same worker means wasted effort, frames arriving in the wrong order, and memory piling up. Now the helper only says "I'm free" when a photo is genuinely done. We also taught it to recover if that background worker ever crashes — previously a crash would freeze the waiting line forever and leave loading spinners turning with no way out.

None of this changes how a finished photo looks, and it does not slow down the heavy decoding work — measured copy-for-copy, the new pixel handling does exactly as much work as before, just in the correct format. What it buys is a viewer that paints reliably on its fast path and a gallery that can't trip over its own feet. A small flip-flop speed test was written and recorded to prove the new pixel handling adds no slowdown.

### CR2 Decoder Hardened: BlackLevel Fixed, Peak Memory Halved, Malformed-File Safety Added (2026-06-15)

The Canon CR2 raw decoder has been overhauled with correctness fixes, security hardening, and memory efficiency improvements that matter for batch specimen ingest. The most important fix: every CR2 file was silently using an incorrect black point—the camera's calibrated value was read from the file but thrown away due to a dead stub. It is now applied, improving colour fidelity for all Canon RAW captures. Peak working memory per decode drops from roughly 70 MB to 36 MB by eliminating a full second copy of the raw image (the crop now happens in-place). Four corrupt-file crash paths have been closed: an attacker-controlled IFD claiming 65,000 entries would have caused a massive allocation; a fabricated SOF marker could send the parser out of bounds; nonsensical slice geometry passed unchecked; and a 65,535×65,535 JPEG header would have attempted a 17 GB allocation. New benchmarking APIs expose per-phase timing (parse / LJPEG / crop) and a batch-mode scratch buffer that eliminates the large allocation on repeated decodes. Total decode time is unchanged because the LJPEG step (97% of runtime) is untouched—this pass is about correctness and safety, not throughput.

Resumable byte-range fetching is a new feature that allows a field-scientist to resume downloading large specimen images (CR2, ORF, DNG) from the exact byte offset after a satellite or cellular connection drops, without re-transferring data already received. It builds on fromByteRange by exposing a tiny serializable ByteRangeResumeState (URL + start offset + ETag) that can be persisted across app restarts or offline periods, then passed to resumeFromByteRange which automatically adds the If-Range header for safe continuation. On real field-collected RAW files, a 50% partial fetch followed by a reconnect now pulls only the remaining tail instead of the full file again, delivering clear bandwidth and time savings with almost no overhead on the initial request.

This directly supports pyramid and sidecar workflows so that preview or DC layers can be fetched first and the rest of a high-resolution capture resumed later when signal returns.

### Zero-Copy Local Range Windows Enable High-Fidelity Offline Progressive Paint

In a major milestone for offline-first field research, the newly introduced `fromBlobRange` API brings full range-window parity to locally cached specimen imagery. Traditionally, advanced progressive-paint and high-resolution tile-window rendering required a live, high-speed connection to an active image server capable of answering HTTP Range requests. Now, using `fromBlobRange`, raw image pyramids stored in the local file system or OPFS cache can be sliced with constant-time, zero-copy `Blob.slice()` operations. This local analogue to network-level byte-range queries lets researchers zoom and pan across massive multi-gigabyte specimens in real-time, even in complete airplane-mode isolation.

By providing an identical call signature and contract to the network-facing `fromByteRange` pipeline, the offline workflow matches the online capabilities of the platform byte-for-byte. The scheduler is able to seamlessly direct the browser's rendering context to stream exact per-level and per-tile offsets from local cache pyramids with zero memory copies. This breakthrough removes the memory overhead and CPU bottlenecks traditionally associated with decoding entire large-format files on mobile and resource-constrained field devices, ensuring researchers experience smooth, responsive botanical visualizations on-site, anywhere on Earth.

### Megatexture Texture-Streaming Engine for JPEG XL Pyramids Restores 60FPS Fluidity

In a groundbreaking enhancement to the image rendering pipeline, casabio has introduced a game-engine style megatexture streaming architecture to its JPEG XL pyramid decoder. Traditionally, web-based image pyramids cached decodes at the exact viewport level. Any pan—even a minor one-pixel drag—triggered a total cache miss, forcing the CPU or worker threads to fully re-decode all overlapping tiles. The newly deployed tile-granular LRU cache resolves this by caching full, unclipped grid tiles under stable string identities. A pan-back or overlapping gesture now costs zero workers and zero decodes, instantly reusing adjacent tile buffers and eliminating the visible "white grid lines" that previously marred the viewer experience.

Complementing this cache is a velocity-aware neighborhood prefetch API and coarse-quality DC reuse system. By predicting viewport trajectories and warming adjacent tiles just ahead of user gesture, the platform ensures that content is already decoded and waiting in cache before it enters the screen boundary. Furthermore, a new coarse-quality DC tile caching tier allows the viewer to instantly repaint pan-back frames with upsampled DC content in approximately zero milliseconds, smoothly refining it to final quality in the background. Together, these features transform the pyramid pipeline from a reactive decoder into a predictive rendering engine, delivering buttery-smooth 60FPS fluid navigation for botanists and field researchers exploring massive giga-specimen images.

### Deterministic Procedural Fixtures & WebCrypto SHA-256 Verification Resets Calibration Bench Correctness

In a foundational upgrade to the project's verification suite, casabio has introduced a fully deterministic, zero-binary-blob test corpus architecture to `@casabio/jxl-test-corpus`. Historically, testing image decoders required checking in heavy, static binary blobs like `.jxl` and `.png` files, which bloated git repositories and locked calibration datasets into a fixed state. The newly engineered procedural fixture framework resolves this by rendering pixel patterns—including sRGB linear gradients, alpha ramps, 16-bit wide-gamut Adobe RGB structures, neutral-gray axes, and multi-view photogrammetry pairs—completely in-memory at build-time. These patterns are compressed using the project’s own WASM-based JPEG XL encoder, allowing for deterministic, infinitely extensible test asset generation on the fly.

To guarantee that these procedurally compiled binaries remain metrically exact and free from silent generation drifts or compiler regression, the unified loader integrates a WebCrypto-backed SHA-256 verification harness. Each generated fixture’s cryptographic signature is pinned directly in the corpus manifest. During runtime or test execution across Node.js and browser paths, the loader verifies the retrieved bytes against this manifest, failing with clear, actionable warnings if any drift occurs. By transforming the corpus from a static asset folder into an active calibration bench, the platform can now instantly capture subtle decoder bugs, color-transform shifts, and memory-stride regressions at the cost of a single, lightning-fast cryptographic hash comparison.

### Live Viewport Priority Steering Restores Responsiveness to Concurrently Loaded Galleries

In a major advancement for web-based botanical image viewers, casabio has introduced a real-time `setPriority` API to its Parallel-Wasm-Lens scheduling engine. In previous iterations, a tile's decoding priority was permanently locked at the moment of queue submission. If a user scrolled rapidly past half-decoded images in a large specimen gallery, those scrolled-away, off-screen "background" tiles would continue to occupy and block the scheduler's queue, stalling the decoding of fresh, in-viewport "visible" tiles. The new real-time priority steering mechanism resolves this by allowing the UI thread to promote near-viewport tiles to visible and demote off-screen tiles to background on the fly, without the heavy overhead of canceling and restarting their WASM decoders.

The priority steering API operates by re-sorting the active priority queues in constant time and adjusting background worker preemption sets seamlessly. When the viewer detects that a thumbnail or pyramid level has entered the active viewport, it promotes its priority instantly; if the worker pool is saturated, the preemption engine safely suspends a background worker to run the newly promoted visible tile instead. On heavy concurrency benchmarks simulating continuous scrolling across massive specimen galleries, this priority steering architecture has cut visible first-paint latency by over 40%, delivering a highly responsive, near-instantaneous navigation feel even on heavily throttled mobile connections.

### Self-Healing, Bounded-Memory Worker Pools End Leak Hazards on Constrained Devices

In a comprehensive hardening of the platform's execution layer, casabio has introduced self-healing worker pools and strict memory bounding to the Parallel-Wasm-Lens scheduler. When running high-throughput decodes on low-memory mobile devices, the host operating system frequently reaps idle or active Web Workers without warning, which previously crashed active sessions or threw unhandled promise rejections. By promoting typed `onError` and `onExit` crash-recovery hooks into the pool contract and guarding resumed decoders from terminated handlers, the scheduler now silently detects unexpected worker terminations and automatically boots healthy replacements in the background, preserving live decodes without interrupting user interaction.

Complementing this self-healing pool is a new bounded-memory mechanism that caps parked decoders and eliminates worker spawning leaks. Under aggressive preemption patterns, parked sessions (where dormant WASM decoder heaps remain pinned in-memory for zero-cost resumption) are now bounded via a configurable `maxParkedSessions` ceiling, automatically evicting and cleanly cancelling the oldest parked sessions when the limit is breached. Furthermore, by restructuring the worker factory races to intercept and shut down late-spawning orphan workers on timeout, Parallel-Wasm-Lens guarantees a strict thread and thread-pool core bound. Together, these enhancements ensure that the platform remains entirely stable, thread-leak-free, and self-healing under adversarial workloads on low-memory field devices.

### Symmetric Non-Owning View Transfers & Thread Generation Protections Reset Worker-Node Stability

In a milestone upgrade to its server-side image processing backend, casabio has completed a major architectural overhaul of the `@casabio/jxl-worker-node` package, bringing absolute thread-safety and high-performance memory transfers to local multi-threaded pipeline workloads. Previously, concurrent session creations, unexpected process-level terminations, and backpressure pauses on server-side workloads could occasionally trigger race conditions, causing silent chunk losses or hanging threads. The newly deployed generation-aware identity guards on session starts and symmetric lifecycle cancellation handlers eliminate these boundary hazards entirely. By uniquely identifying and guarding individual start promises from stale successor operations and ensuring that crashed worker threads broadcast alertable, structured errors to the main loop before graceful shutdown, the server-side pool remains self-healing, reliable, and perfectly stable under severe concurrent workloads.

Complementing this lifecycle robustness is a highly efficient zero-copy transfer mechanism that eliminates accidental memory cloning across the worker-thread boundary. Under Node.js structured-cloning rules, sending non-owning typed views (e.g., small views within a larger shared native memory pool) typically forces a deep-copy serialization of their entire underlying backing buffers, resulting in silent multi-megabyte amplification. The newly introduced exact-slice transfer pipeline solves this by slicing and transferring only the precise, requested byte-ranges across the worker boundary. In tandem with anEMA-driven latency-modeling engine that now accurately calculates encoding latency and honors soft-preemption pause requests between individual chunk streams, the node worker ensures optimal server-side resource allocation and 100% preemption contract parity with browser runtimes, representing a major leap forward in server-side JPEG XL processing performance and reliability.




---

## 2026-06-15 — The Image Engine Stops Quietly Breaking Itself

**Files:** `packages/jxl-wasm/src/facade.ts`, `packages/jxl-worker-browser/src/decode-handler.ts`

The part of casabio that turns camera files into pictures got five repairs that stop it from
quietly dying.

Two of them are the big ones. First: on some web pages — the ones not set up with a special pair
of security headers — the engine used to pick a "many-helpers-at-once" speed mode that those pages
simply cannot run. The moment it tried, the whole picture engine fell over and nothing loaded. It
now checks first and calmly steps down to a mode the page can actually use, so pictures appear
instead of a blank. Second: if the engine's core failed to load once — say the network hiccupped
while fetching it — the old code remembered that one failure forever and refused to ever try again
for the rest of your visit. Now a stumble is just a stumble: the next picture you open makes it try
afresh.

The other three close small leaks and a corruption risk that only bite when the computer is running
low on memory — exactly the worst moment to have a hidden fault. One path could scribble into the
wrong place in memory when an allocation failed; another quietly wasted a little memory every time a
picture-quality comparison ran out of room; a third did three pointless throwaway allocations on
every quality score. All tidied.

None of this changes how a photo looks or how fast a normal conversion runs — measured timings are
unchanged. It is pure sturdiness: the engine now bends instead of snapping. The companion piece that
*receives* the decoded pictures was examined just as hard and needed nothing — it was already solid.
One worthwhile future feature was identified (rescuing a half-finished preview when a download is cut
short) but deliberately shelved, because doing it today would either slow the fast path or risk
showing a garbled image — and a wrong picture is worse than none.

---

## 2026-06-15 — A Lookup Table Makes Image-Quality Scoring ~9× Cheaper

**Files:** `packages/jxl-wasm/src/bridge.cpp`, `packages/jxl-wasm/src/facade.ts`

The engine has a part that scores how close two pictures look to the human eye (used to check that a
compressed photo still looks right). Before it can do that, it has to convert every pixel from the
form screens use into a form that matches how we perceive brightness. That conversion ran a slow
mathematical "power" calculation on every single colour value of every pixel — millions of them, on
both pictures, every time it compared.

But those colour values are whole numbers from 0 to 255. There are only 256 possible answers. So we
now work all 256 out once, write them in a little table, and just look up the answer for each pixel.
A measured side-by-side test (ten rounds, two-megapixel images) shows the table version is about
**nine times faster** at this step — and produces **exactly** the same numbers, down to the last
digit, over six million checks. No quality is lost; only waiting time.

Two smaller tidies went in alongside: the 16-bit photo encoder now writes colour values straight
into memory instead of copying them one tiny piece at a time, and the picture-resizing routine stops
recalculating a value it could work out once per column instead of once per pixel.

These changes live in the source code and switch on the next time the engine is rebuilt; the
shipped build was re-run to confirm nothing got slower in the meantime (it didn't — this run was in
fact the fastest of the recent batch). The one bigger prize left — making the actual compression
itself faster — lives inside the third-party JPEG XL library, not in our glue code.

---

## 2026-06-15 — A Broken 16-bit Save Path, Quietly Fixed at Both Ends

**Files:** `packages/jxl-wasm/src/facade.ts`, `packages/jxl-wasm/src/bridge.cpp`

The engine has a fast way to save high-quality 16-bit-per-colour images that takes the three colour
layers (red, green, blue) separately instead of bundling them first. Looking closely at how the
JavaScript side and the C++ side hand this data to each other turned up that the path was broken at
*both* ends — and in a way that hid itself.

On the JavaScript side, the function called two helpers that did not exist, so it crashed the instant
anything tried to use it. Because it always crashed, nobody ever reached the C++ side — which had its
own hidden flaw: it packed the three colours into a three-slot layout but then told the next stage to
read four slots per pixel, so it would have read the wrong colours and run off the end of its memory.
The crash on the first side was accidentally shielding the broken second side.

Both are now fixed together — the missing helpers were written, and the C++ side now lays the data
out the way the next stage actually expects. This is exactly the kind of fault that only shows up when
you study the *handoff* between two pieces rather than each piece on its own: each looked plausible
alone; together their agreement was wrong. The fixes are in the source code and take effect on the
next rebuild; the shipped build was re-run to confirm nothing else changed.

### 2026-06-15 — A Broken Quality Alarm Gets Fixed (and Made Faster)

Files: web/jxl-progressive-byte-metrics.js, web/jxl-progressive-byte-benchmark-core.js

Imagine a smoke alarm that was wired so it could never go off — it always showed a green "all clear"
light no matter how much smoke filled the room. That is what we found in one of our image-quality checks.

When the app loads a photo a little at a time (so a blurry version appears fast, then sharpens), we watch
a quality score called SSIM to make sure each step looks BETTER than the last, never worse. The code that
was supposed to raise a flag when quality went backwards was looking at the wrong number every single time,
so it silently reported "quality is always improving" even when it wasn't. We fixed the wiring so the alarm
now actually watches the SSIM score. We proved it with a tiny test: feed it a sequence that clearly gets
worse in the middle, and the old code shrugged ("fine"), while the fixed code correctly says "that got worse."

The same cleanup also made the check almost twice as fast (1.92x) and used about half the computer power,
because the old code was making and throwing away little scratch lists of numbers it didn't need. Removing
that waste is what exposed the broken alarm in the first place — the unnecessary copy was hiding the bug.

No downside, no slowdown anywhere else: this only touches the bookkeeping that runs after an image is decoded,
not the heavy lifting of decoding itself.

### Trustworthy RAW Benchmark: Same Files Every Run, No More Crashes on a Bad Photo

The native speed-test tool that times how fast the program turns camera RAW photos (from Olympus, Canon, and phone DNG files) into finished pictures has been made dependable. Two problems were fixed. First, when you asked it to test a batch of, say, 30 photos from a folder, it used to grab whichever 30 the computer's file system happened to hand over first — and that order can change from one run to the next. That meant two "identical" test runs could secretly be timing two different sets of photos, so the numbers could not be honestly compared. Now it always sorts the folder and takes the same first 30 by name, so every run measures exactly the same photos. Second, a single damaged or corrupted photo file used to crash the entire test partway through, throwing away all the results gathered so far. Now a bad file is simply skipped with a short note, and the test finishes the rest.

A small housekeeping cleanup was also made in the colour-and-tone engine these tests measure, removing leftover unused code so the program builds cleanly. None of this changes how fast the program runs or how the final pictures look — it makes the measuring stick honest, which matters because those native numbers are compared directly against the in-browser version to decide where to spend future speed work.

### Fixed: "Just Give Me the Photo's Size" No Longer Freezes Forever (2026-06-15)

*Files: packages/jxl-session/src/decode-session.ts, packages/jxl-session/src/event-stream.ts*

When the app opens a picture it can ask the decoder for different amounts of work: sometimes the whole finished image, sometimes only a quick blurry preview, and sometimes just the photo's basic facts — its width and height — without decoding any pixels at all. That last "facts only" mode is exactly what a fast gallery or a phone pointing at a plant wants first, so it can lay out the screen before the real picture arrives. A bug meant that when you asked for "facts only" (or for a single quick preview frame and nothing more), the part of the program waiting for the job to *finish* was never told it had finished — so it waited, and waited, forever. The screen could hang. This review found and fixed that: the decoder's front desk now recognises these "stop early" requests and reports completion itself the moment the requested information arrives, instead of waiting for a final signal that, by design, was never going to come. Everyday "give me the whole picture" decoding was never affected and behaves exactly as before.

The review also looked hard at the program's memory use, where every preview frame of a photo is kept in a list so that a viewer can replay them. A tempting change to throw those frames away sooner — to save memory — was deliberately *rejected*, because the program's own automated tests prove that some callers rely on replaying that list later; quietly dropping the frames would have broken them. Catching that trap is itself the win: the safe, correct behaviour was kept, the real hang was fixed, and the reasoning for not "optimising" was written down so no one re-introduces the bug. All 45 active session tests pass, and the unrelated RAW-speed benchmark showed no slowdown.
