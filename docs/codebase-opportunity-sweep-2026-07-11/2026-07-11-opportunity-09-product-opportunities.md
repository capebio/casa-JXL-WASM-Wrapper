# Product Opportunity Implementation Plan

> **For agentic workers:** Product work consumes identity, cancellation, manifest,
> memory, and release contracts. Do not invent parallel local contracts. Every agent
> uses its own named worktree and branch.

**Goal:** Convert metadata, cache, scheduler, edit, HDR, motion, and AI foundations
already present in the repository into coherent mixed-format workflows.

**Findings owned:** 83-98. Findings 99-100 are release gates in packet 10.  
**Lead quality:** Opus, sticky across catalog/project/export contract work.  
**Effort:** XL program, split into independently releasable slices.  
**Lead worktree:** `C:\Foo\rcw-product-opportunities-opus-20260711`  
**Lead branch:** `feat/product-opportunities-opus-20260711`

Sonnet may own isolated presentation/accessibility leaves after Opus has fixed the
data and command contracts. Haiku is limited to deterministic labels, fixtures, or
registration under an explicit review boundary.

## Finding Record

| Find | Priority | File and lines | Opportunity | User metric |
|---:|---|---|---|---|
| 83 | P1 | `packages/pyramid-ingest/src/ingest.ts:235-259`; `packages/pyramid-ingest/src/manifest.ts:95-105`; `packages/jxl-pyramid/src/manifest.ts:223-238`; `web/pyramid-gallery/pyramid-gallery.js:69-98` | Build searchable catalog projection for format, camera, ISO, lens, and later rating/taxon without fetching every manifest. | Search-to-open p50; query p95 at 10k/100k; manifest fetch count. |
| 84 | P1 | `packages/pyramid-ingest/src/ingest.ts:250-251,948-969`; `web/pyramid-gallery/pyramid-gallery.js:77-98` | Normalize capture time/timezone once and add deterministic timeline/day/event views. | Time to date/event; stable rebuild order; unknown-time rate. |
| 85 | P0 | `packages/pyramid-ingest/src/ingest.ts:37,252-257,472,596`; `web/ai-id/gps.mjs:17-41`; `web/main.js:1427-1436` | Add map/clustering only behind precision, redaction, and consent policy. | Zero unintended coordinate upload; map p95; redaction rate. |
| 86 | P1 | `packages/jxl-pyramid/src/manifest.ts:223-238`; `packages/jxl-pyramid/src/manifest-validate.ts:376-390`; `web/pyramid-gallery/pyramid-gallery.js:69-122` | Use existing thumbhash, group, and next fields for instant placeholders, bursts, pagination, and connected navigation. | Placeholder paint; CLS; next-page/group completion. |
| 87 | P1 | `web/jxl-source-folder.js:45-123`; `web/main.js:2209-2361` | Productize persisted folder handles into mixed-format watch/reconcile intake. | Detection latency; duplicate jobs; permission recovery. |
| 88 | P0 | `web/main.js:1240-1273,1317-1347,1911-1915`; `web/panels.js:278-306` | Durable project containing identity, locators, edits, selections, and cache links; relink moved sources without losing edits. | Reopen/relink success; lost or misattached edit count. |
| 89 | P1 | `web/main.js:1273,1874-1877`; `packages/pyramid-ingest/src/hash.ts:18,34-39`; `packages/pyramid-ingest/src/manifest.ts:108-112` | Exact/visual duplicate model with multiple source aliases instead of name/stat or path identity. | Avoided decode/storage; false merge rate; alias recovery. |
| 90 | P0 | `web/main.js:393-420`; `web/crop.js:261-317,577-600`; `web/panels.js:259-399` | Versioned non-destructive command history and undo/redo across looks, crop, straighten, subjects, and profile. | Undo latency; recoverable edits; stale paint after undo. |
| 91 | P1 | `web/main.js:589-633`; `web/panels.js:406-447,455-514` | Merge numbered looks and named profiles into one versioned preset schema with import/export and migration. | Exact round trip; migration success; batch apply time. |
| 92 | P0 | `web/pyramid-gallery/pyramid-gallery.js:40-75`; `web/pyramid-gallery/image-store.js:47-121`; `packages/jxl-stream/src/browser.ts:434-539,728-742`; `packages/asset-store/src/index.js:142-194,443-495` | One authenticated remote/offline source abstraction with Range/resume, persisted index/manifests, quota handling, and availability state. | Offline reopen; cache hit; reconnect bytes avoided; first paint. |
| 93 | P0 | `web/index.html:338-340,490,535-536`; `web/lightbox/pyramid-lightbox.js:848-879`; `web/tauri-parity-lightbox.js:318-386`; `web/main.js:2898,3611-3640` | One capability-driven full/ROI/batch export contract across RAW/JPEG/TIFF/EXR/JXL, including color, metadata, and orientation. | Format matrix success; ROI parity; export latency; metadata retention. |
| 94 | P1 | `web/lightbox/pyramid-lightbox.js:406-458,532-566,802-879`; `web/jxl-wrapper-lab.js:510-526,1221-1244,1458-1499` | Product HDR/gain-map negotiation, composition, SDR fallback, and display-nits policy. | HDR golden delta; clipping; round trip; supported-session rate. |
| 95 | P1 | `web/animation-lab.html:243-382`; `packages/jxl-core/src/types.ts:45,298`; `web/casv-lightbox/casv-lightbox.js:185-299`; `web/timelapse.js:290-447` | Mixed motion catalog for animated JXL, CASV, and timelapse with poster, playback, seek, trim, and export. | First frame/seek; dropped frames; timing parity; open success. |
| 96 | P0 | `packages/jxl-pyramid/src/manifest.ts:88-91,164-165`; `web/ai-id/README.md:1-24`; `web/ai-id/proxy.mjs:1-49`; `web/ai-id/sidecar.mjs:15-23`; `web/main.js:432-472` | Consent-first AI-ID asset/subject workflow with cancellation, provenance, corrections, and offline queue. | ID latency; accepted/corrected rate; bytes; zero calls without consent. |
| 97 | P1 | `web/index.html:65,95,311-370,392-400`; `web/main.js:1369,1415,3774-3916`; `web/panels.js:598-631` | Keyboard/focus/accessibility pass for cards, tabs, dialogs, sliders, levels, and shortcut discovery. | Keyboard completion; focus loss; WCAG violations. |
| 98 | P0 | `web/main.js:1882-1883,2158-2172,3128,3564,4329-4352`; `web/pyramid-gallery/pyramid-gallery.js:71-128`; `web/style.css:220-260,928-954,1627-1669` | Unified job/loading/error/retry/cancel UI and responsive touch layout. | Stuck jobs; retry/cancel; mobile completion; overflow/touch failures. |

## Completion Order

```text
Foundation contracts: 66-69, 73, 107, 109-110
Phase A durable work: 88 -> 90 -> 91
Phase B catalog:      83 -> 84 + 86 -> 87 + 89
Phase C delivery:     92 -> 93
Phase D experiences:  85, 94, 95, 96
Cross-cutting UX:      97 -> 98
Release:               99 -> 100
```

Do not block the independent accessibility audit on every backend feature. Its
component contract may start after command/focus ownership in 90 is stable.

## Agent And Worktree Assignment

| Find | Agent / effort | Worktree | Branch | Depends on |
|---:|---|---|---|---|
| 83 | Opus / L | `C:\Foo\rcw-f83-catalog-search-opus-20260711` | `feat/f83-catalog-search-opus-20260711` | 61-65, 72-76 |
| 84 | Sonnet / M | `C:\Foo\rcw-f84-timeline-sonnet-20260711` | `feat/f84-timeline-sonnet-20260711` | 83 |
| 85 | Opus / L | `C:\Foo\rcw-f85-map-privacy-opus-20260711` | `feat/f85-map-privacy-opus-20260711` | 83, privacy policy |
| 86 | Sonnet / M | `C:\Foo\rcw-f86-group-pagination-sonnet-20260711` | `feat/f86-group-pagination-sonnet-20260711` | 74, 76, 83 |
| 87 | Opus / L | `C:\Foo\rcw-f87-watch-folder-opus-20260711` | `feat/f87-watch-folder-opus-20260711` | 14, 39, identity |
| 88 | Opus / XL | `C:\Foo\rcw-f88-project-relink-opus-20260711` | `feat/f88-project-relink-opus-20260711` | 40, 46, 66 |
| 89 | Opus / L | `C:\Foo\rcw-f89-content-dedupe-opus-20260711` | `feat/f89-content-dedupe-opus-20260711` | 66, 88 |
| 90 | Opus / XL | `C:\Foo\rcw-f90-edit-history-opus-20260711` | `feat/f90-edit-history-opus-20260711` | 40, 41, 46, 48 |
| 91 | Sonnet / M | `C:\Foo\rcw-f91-presets-sonnet-20260711` | `feat/f91-presets-sonnet-20260711` | 90 |
| 92 | Opus / XL | `C:\Foo\rcw-f92-remote-offline-opus-20260711` | `feat/f92-remote-offline-opus-20260711` | 29, 38, 42, 73-80, 99a |
| 93 | Opus / XL | `C:\Foo\rcw-f93-export-contract-opus-20260711` | `feat/f93-export-contract-opus-20260711` | 13, 30, 40-46, 75, 77 |
| 94 | Opus / XL | `C:\Foo\rcw-f94-hdr-gainmap-opus-20260711` | `feat/f94-hdr-gainmap-opus-20260711` | 30, 70, 75, 93, 99 |
| 95 | Opus / XL | `C:\Foo\rcw-f95-motion-library-opus-20260711` | `feat/f95-motion-library-opus-20260711` | 15, 38, 47, 99 |
| 96 | Opus / XL | `C:\Foo\rcw-f96-ai-id-workflow-opus-20260711` | `feat/f96-ai-id-workflow-opus-20260711` | 16, 83, 85, 88 |
| 97 | Sonnet / L | `C:\Foo\rcw-f97-accessibility-sonnet-20260711` | `feat/f97-accessibility-sonnet-20260711` | 90 command/focus contract |
| 98 | Sonnet / L | `C:\Foo\rcw-f98-responsive-jobs-sonnet-20260711` | `feat/f98-responsive-jobs-sonnet-20260711` | 3, 11, 12, 43, 47, 48, 97 |

## Acceptance Gates

| Find | Required behavioral gate | Performance gate when claimed |
|---:|---|---|
| 83 | Typed projection; deterministic filters; no full-manifest reads for indexed fields | `flipflop.mjs .flipflop/tests/catalog-query.mjs`, 10k/100k, query p50/p95 and index bytes |
| 84 | DST/timezone/unknown fixtures; deterministic rebuild order | Only needed if claiming faster navigation; use catalog-query vehicle |
| 85 | Coordinate precision/redaction; consent; no raw GPS in redacted/upload artifacts | `flipflopdom` map-pan/cluster test if latency claimed |
| 86 | Thumbhash paint, group order, cursor recovery, connected navigation | `flipflopdom.mjs .flipflop/dom-tests/gallery-placeholder-pagination.mjs`, first paint and CLS |
| 87 | Revoke/regrant; create/change/delete; mixed-format scan; no duplicate dispatch | `flipflop.mjs .flipflop/tests/folder-reconcile.mjs`, scan latency and avoided reads |
| 88 | Save/restart/relink E2E; moved volume; same basename; missing source; edits preserved | `flipflopMem` long project reopen only if memory/performance claimed |
| 89 | Exact/visual duplicate corpus; aliases; zero false merge at approved threshold | `flipflop.mjs .flipflop/tests/content-dedupe.mjs`, throughput plus false-positive gate |
| 90 | Command stack; crop/look/subject undo; async stale suppression; replay parity | `flipflopdom` undo response only if latency claimed |
| 91 | Versioned schema; old-slot/profile migration; exact import/export; malformed reject | No performance claim expected |
| 92 | Auth mock; 200/206/416/resume; offline restart; quota eviction; corrupt recovery | `flipflopdom.mjs .flipflop/dom-tests/remote-offline.mjs`, first paint, bytes, cache hit; `flipflopMem` cache pressure |
| 93 | RAW/JPEG/TIFF/EXR/JXL full/ROI/batch matrix; pixel/color/orientation/metadata goldens | `flipflop.mjs .flipflop/tests/export-contract.mjs`, latency/throughput with equality or declared quality |
| 94 | HDR/gain-map goldens; WebGL/CPU SDR parity; capability fallback | `flipflopdom.mjs .flipflop/dom-tests/hdr-gainmap.mjs`, first paint/frame time/visual parity |
| 95 | Timing/loop tests; CASV Range first frame; poster; catalog playback | `flipflopdom.mjs .flipflop/dom-tests/motion-playback.mjs`, first frame, seek, dropped frames |
| 96 | Consent/cancel/retry; source priority; provenance; correction; browser bundle excludes Node imports | `flipflop` only for claimed decode/proxy savings; retain output/provenance equality |
| 97 | Axe WCAG AA; full keyboard script; focus trap/restore; levels parity | No speed claim expected |
| 98 | Slow/failing network; retry/cancel; zero stuck busy cards; 360x800 and 768x1024 screenshots | `flipflopdom.mjs .flipflop/dom-tests/job-ui-responsive.mjs` for interaction/paint claims |

## Product Slice Rule

Each branch must ship one usable vertical slice with its empty, loading, partial,
error, retry, cancellation, offline/capability, and accessibility states. Do not
merge a data model with only a lab page and call the workflow complete.
