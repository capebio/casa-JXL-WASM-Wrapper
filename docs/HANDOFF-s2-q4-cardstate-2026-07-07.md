# HANDOFF — S2-Q4: CardState Cleanup (2026-07-07)

**Worktree:** `C:\Foo\raw-converter-wasm\Foorcw-s2-q1-webgl`
**Branch:** `feat/s2-q4-cardstate-refactor-jul07`
**Scope:** `web/main.js` only. Pure JS refactor — no TS, no WASM, no build required.

## Context

`web/main.js` stores per-card state as expando properties directly on `<div>` DOM elements
(prefixed with `_`). There is already a `CardState` JSDoc typedef (lines ~1176–1211) listing
all properties. The refactor moves that state off DOM elements and into a WeakMap so:
- TypeScript/IDE tooling can actually type-check it
- GC naturally removes dead cards
- State lookup is explicit, not implicit via expando

**Existing data structures (found in main.js):**
- `cardByTaskId` (Map): taskId → card `<div>`
- `cardByFilename` (Map): filepath → card `<div>`
- `peepCache` (Map): RGBA LRU (not per-card — leave alone)
- All per-card state: expando `_field` on the `<div>` elements directly
- Lightbox state: module-level globals `lightboxIndex`, `liveInFlight`, `livePendingLook`,
  `galleryDebounceTimer`, `liveDebounceTimer` — LEAVE THESE ALONE, they're already correct

## Working-tree rules

- Work only in `C:\Foo\raw-converter-wasm\Foorcw-s2-q1-webgl`. Never touch primary checkout.
- `web/main.js` only. Do not touch any package source.

---

## Stage 1 — Introduce `cardState` WeakMap

At module scope (near the existing `cardByTaskId` Map), add:
```js
/** @type {WeakMap<Element, CardState>} */
const cardState = new WeakMap();
```

Add two helpers:
```js
function getCardState(card) {
  return cardState.get(card);
}

function initCardState(card, initialFields) {
  const state = Object.assign(Object.create(null), initialFields);
  cardState.set(card, state);
  return state;
}
```

### Stage 2 — Migrate card creation

Find where cards are created (search for `document.createElement` + `_file` or where
`_taskId` is first set). Change from:
```js
card._file = f;
card._taskId = taskId;
// etc.
```
to:
```js
initCardState(card, {
  _file: f,
  _taskId: taskId,
  // etc. — all initial fields
});
```

### Stage 3 — Migrate all read/write sites

Replace `card._field` reads/writes with `getCardState(card)._field`.
This is mechanical — do a search-replace guarded by context (only within functions that
receive a card element, not inside JSDoc typedef blocks).

**Pattern to find:** `card\._[a-z]` — each occurrence should become `getCardState(card)._`
**Exception:** Inside the `@typedef {Object} CardState` block — leave that alone.

### Stage 4 — Cleanup

Remove the `@typedef` JSDoc block (or keep it as the `CardState` type source — your call,
but don't have it duplicate the WeakMap approach).

---

## Success criteria

- `web/main.js` has `cardState` WeakMap instead of expando props.
- No regressions: existing functionality unchanged.
- Run `bun test` from repo root — must be green.
- If there's a headless smoke test for main.js (check `test/` or `scripts/`), run it.
- Commit: `refactor(main): WeakMap-backed CardState replaces DOM expando properties`

## Do NOT

- Do not migrate `peepCache`, `lightboxIndex`, `liveInFlight`, or other module globals —
  those are already correct as-is.
- Do not add TypeScript annotations to main.js (it is plain JS).
- Do not split into a separate module — keep it all in main.js.
- Do not change behavior — pure refactor.
