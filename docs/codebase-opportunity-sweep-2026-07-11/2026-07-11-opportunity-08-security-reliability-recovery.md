# Security, Reliability, And Recovery Implementation Plan

> **For agentic workers:** This packet changes trust, identity, cancellation, and
> lock ownership. Use Opus for the packet and keep it on adjacent tasks after it
> has loaded the context. Each agent uses its own named worktree and branch.

**Goal:** Make untrusted bytes, runtime artifacts, durable identity, deadlines,
locks, privacy, and recovery explicit enough that failure cannot silently publish
or destroy the wrong state.

**Findings owned:** 59, 66-69, 73, 85 privacy contract, 100 migration interface,
109-111.  
**Lead quality:** Opus  
**Effort:** XL, split below  
**Lead worktree:** `C:\Foo\rcw-security-recovery-opus-20260711`  
**Lead branch:** `fix/security-recovery-opus-20260711`

## New Finding Record

| Find | File and lines | Opportunity |
|---:|---|---|
| 109 | `packages/jxl-wasm/src/loader.ts:16-42,55-83` | `wasmSha` is only a cache key. Verify the fetched artifact before accepting or persisting it; prevent a claimed digest from poisoning memory/IDB cache. |
| 110 | `packages/jxl-wasm/src/loader.ts:16-42,55-58,88-103` | Shared promise ownership gives the first caller control of cancellation; later callers cannot detach. IDB read/open failure blocks network fallback. Define shared-load waiter and cache-recovery semantics. |
| 111 | `web/_headers:1-4`; `web/vercel.json:1-12`; `serve.ts:429-485`; dynamic DOM construction in `web/main.js:1376-1390` and `web/lightbox/pyramid-lightbox.js:140-180,279` | Add a production CSP and automated unsafe-DOM policy. No exploit is asserted; this is defense-in-depth before metadata, remote catalogs, and AI results expand the untrusted string surface. |

## Threat And Failure Model

| Boundary | Failure to prevent | Required control |
|---|---|---|
| Source image/header | Tiny compressed input causes overflow or huge allocation | Checked dimensions/output bytes before decode; bounded input and scratch memory. |
| Manifest/index/JXTC | Traversal, redirect escape, oversized body, truncation, collision, malicious offsets | Root-contained URL policy, response byte cap, checked ranges, collision-resistant digest, validate before cache publication. |
| Runtime WASM | Wrong bytes accepted under a trusted build ID/digest | Runtime integrity/trust policy, immutable content addressing, cache verification and eviction. |
| Stable asset identity | Move/relink attaches edits to wrong source or same path hides changed bytes | Separate catalog ID, source aliases, freshness fingerprint, and content identity. |
| Deadline/cancel | Waiter fails while worker later publishes output | Abort propagation, owned join/terminate, generation guard, temporary-state cleanup. |
| Lock/shutdown | Double release deletes successor's lock; process exits before checkpoint | Owner-token compare-and-delete, idempotent release, ordered abort/join/flush/release. |
| Metadata/AI/upload | GPS, identity, or private metadata leaves device unintentionally | Explicit consent, field-level redaction, provenance, audit event, privacy-preserving telemetry. |
| Migration/release | Partial upgrade leaves mixed unreadable catalog | Journal, backup, shadow validation, rollback, mixed-version compatibility gate. |

## Task Order

```text
1 threat model and fixtures
2 runtime artifact loader integrity/lifecycle
3 source identity and remote trust chain
4 deadline propagation
5 lock ownership and shutdown
6 privacy and DOM/deployment defense
7 recovery and rollback drills
```

### Task 1: Pin Adversarial And Fault Fixtures

**Agent:** Opus / M  
**Worktree:** `C:\Foo\rcw-security-fixtures-opus-20260711`  
**Branch:** `test/security-fixtures-opus-20260711`

- [ ] Add serialized hostile TIFF/EXR headers, malformed manifests/JXTC, redirect
  chains, truncated/oversized responses, lock races, and cache corruption fixtures.
- [ ] Record digest and expected reject stage for every fixture.
- [ ] Test that invalid input never reaches pixel allocation, durable cache
  publication, catalog replacement, or successor-lock deletion.

### Task 2: Harden Runtime WASM Loading

**Findings:** 109-110  
**Agent:** Opus / L  
**Worktree:** `C:\Foo\rcw-wasm-loader-trust-opus-20260711`  
**Branch:** `fix/wasm-loader-trust-opus-20260711`

- [ ] Decide and document the runtime trust model: same-origin release verification,
  cryptographic byte verification, signed manifest, or a combination. A field named
  `wasmSha` must not imply verification that does not occur.
- [ ] Validate response status, MIME, length where known, final URL policy, and
  declared digest before persistent cache publication.
- [ ] Key caches by verified digest and artifact role/tier. Reject or evict mismatched
  and un-compilable records.
- [ ] Separate shared load ownership from caller waiters: one caller abort detaches
  that caller; underlying work cancels only under an explicit policy.
- [ ] Treat IDB unavailable/blocked/corrupt as recoverable network fallback; bound
  cache generations and provide deterministic clear/retry.
- [ ] Preserve initial-load performance with
  `flipflopdom.mjs .flipflop/dom-tests/wasm-loader-integrity.mjs`. Compare cold and
  warm compile, transferred bytes, JS heap/WASM pages, and verified module equality.
  Any integrity mechanism that regresses startup needs an explicit accepted budget,
  not a hidden exemption.

### Task 3: Establish Source Identity And Fetch Trust

**Findings:** 66, 73; dependency for 83, 88-89, 92  
**Agent:** Opus / XL  
**Worktree:** `C:\Foo\rcw-source-identity-trust-opus-20260711`  
**Branch:** `feat/source-identity-trust-opus-20260711`

- [ ] Approve versioned `catalogId`, source alias, freshness fingerprint, and
  collision-resistant content identity contracts.
- [ ] Preserve edits/cache links across move and relink while rejecting a changed
  file whose mtime/size were preserved.
- [ ] Use a cryptographic digest at durable and remote trust boundaries. FNV may
  remain an internal hot key only when collision verification prevents wrong-asset
  reuse.
- [ ] Stream remote bodies through size and digest checks before cache publication.
  Test `Content-Length` absent/false, 200/206/416, redirect escape, truncation,
  overrun, and corruption.
- [ ] Measure fingerprint admission with
  `flipflop.mjs .flipflop/tests/source-fingerprint.mjs`; require identity equality,
  move/relink correctness, and a predeclared ingest overhead budget.

### Task 4: Propagate Deadlines Into Owned Work

**Finding:** 67  
**Agent:** Opus / L  
**Worktree:** `C:\Foo\rcw-ingest-deadlines-opus-20260711`  
**Branch:** `fix/ingest-deadlines-opus-20260711`

- [ ] Replace waiter-only `Promise.race` timeouts with an operation scope carrying
  deadline, signal, generation, owned workers, temporary paths, and publication
  authority.
- [ ] A stage-blocking fake backend must prove timeout aborts, joins/terminates,
  removes temporary files, and prevents late manifest/catalog writes.
- [ ] Define what survives cancellation as a resumable checkpoint and what must be
  rolled back.

### Task 5: Make Lock Release Ownership-Safe

**Findings:** 68-69  
**Agent:** Opus / XL  
**Worktree:** `C:\Foo\rcw-lock-shutdown-opus-20260711`  
**Branch:** `fix/lock-shutdown-opus-20260711`

- [ ] Give each lock an unpredictable owner token and make release compare owner
  before delete. Repeated release must be idempotent.
- [ ] Remove caller-optional mutation locks; pass a transaction capability into
  reindex, rm, batch, gc, migrate, and publication operations.
- [ ] Enforce one lock order mechanically. Add a two-process matrix for all mutation
  pairs and stale-lock takeover.
- [ ] Signal order: mark stopping, abort admission, join/terminate workers, flush
  checkpoint/catalog, then release global lock once.
- [ ] Reproduce the current double-release race: successor acquires between signal
  release and `finally`; predecessor must be unable to delete successor's lock.

### Task 6: Define Privacy And Browser Defense

**Findings:** 44, 85, 96, 100 privacy aspect, 111  
**Agent:** Opus / L  
**Worktree:** `C:\Foo\rcw-privacy-browser-defense-opus-20260711`  
**Branch:** `feat/privacy-browser-defense-opus-20260711`

- [ ] Define field-level retain, display, index, export, cache, upload, and telemetry
  policy for GPS, datetime/timezone, camera serials, faces/AI labels, EXIF, and XMP.
- [ ] Require explicit consent before remote AI/upload; persist policy provenance
  without persisting sensitive values in telemetry.
- [ ] Add a production CSP compatible with WASM workers and required blob/module
  behavior. Remove unjustified inline/eval requirements.
- [ ] Add static/runtime checks that untrusted values use `textContent`, attributes,
  or sanitization; test hostile filenames, metadata, manifest labels, and error text.
- [ ] Delegate mechanical DOM sink conversion only after policy approval to Haiku
  in `C:\Foo\rcw-dom-sinks-haiku-20260711` on
  `fix/dom-sinks-haiku-20260711`.

### Task 7: Rehearse Recovery And Rollback

**Findings:** 66-69, 92, 100  
**Agent:** Opus / L  
**Worktree:** `C:\Foo\rcw-recovery-drills-opus-20260711`  
**Branch:** `test/recovery-drills-opus-20260711`

- [ ] Inject failure after every durable write boundary: bytes, manifest, index,
  checkpoint, migration journal, cache record, and lock handoff.
- [ ] Prove restart yields old-valid or new-valid state, never an unexplained hybrid.
- [ ] Validate backup restore, mixed-version read, corrupt-cache eviction, source
  relink, and deployment rollback.
- [ ] Emit a recovery report naming operation ID, stage, action, and outcome without
  source path or private metadata.

## Completion Gate

- [ ] Adversarial inputs reject before dangerous allocation/publication.
- [ ] Runtime artifact trust behavior matches its documented digest semantics.
- [ ] Move/relink and preserved-mtime replacement tests pass.
- [ ] Cancellation produces no detached publication.
- [ ] Double-release cannot remove another process's lock.
- [ ] GPS/AI/upload consent and redaction tests pass.
- [ ] CSP and hostile-string browser tests pass in the supported browser matrix.
- [ ] Crash/restart/rollback drills yield an old-valid or new-valid state.
