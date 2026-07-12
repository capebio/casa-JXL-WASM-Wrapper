// load-generation.js
// Packet 2 Task 5 (finding 42): guard the lightbox's shared view state against
// stale-load overwrites.
//
// The lightbox mutates module-level state (levelInfo/levelPixels/offscreen/...)
// after one or more awaits inside loadLevel. Two hazards:
//   1. Cross-image staleness: the user navigates A -> B while A's decode is still
//      in flight; A's late completion must NOT overwrite B's view.
//   2. Intra-image non-monotonic overwrite: a late LOWER-resolution level must
//      not clobber a HIGHER one that was painted meanwhile.
//
// This guard makes both explicit: `newGeneration(itemId)` bumps a generation on
// every open/navigate; `begin({itemId, contenthash, rank})` captures a token
// BEFORE the await; `canCommit(token)` is rechecked BEFORE mutating state and
// permits the commit only when the token's generation is still current AND the
// level is monotonically at-least-as-good as what is already committed.

/**
 * @typedef {{ gen: number, itemId: string, contenthash: string, rank: number }} LoadToken
 */

export function createLoadGuard() {
  let gen = 0;
  let currentItemId = null;
  // Rank of the level currently committed for THIS generation (-Infinity = none yet).
  let committedRank = -Infinity;

  /**
   * Open a fresh generation (a new image, a re-open, or navigation). Resets the
   * committed rank so the next image paints from scratch.
   * @param {string} itemId
   */
  function newGeneration(itemId) {
    gen += 1;
    currentItemId = itemId;
    committedRank = -Infinity;
  }

  /**
   * Capture a load token BEFORE awaiting a decode.
   * @param {{ itemId: string, contenthash: string, rank: number }} desc
   * @returns {LoadToken}
   */
  function begin({ itemId, contenthash, rank }) {
    return { gen, itemId, contenthash, rank };
  }

  /**
   * Recheck BEFORE committing the decoded result to shared state.
   * @param {LoadToken} token
   * @returns {boolean}
   */
  function canCommit(token) {
    if (!token) return false;
    // Stale generation (navigated away / re-opened) — reject.
    if (token.gen !== gen) return false;
    // Defensive: item id must match the generation's item.
    if (token.itemId !== currentItemId) return false;
    // Monotonic: only commit a level at least as good as the one already shown
    // in this generation. Equal rank is allowed (idempotent reload / mode toggle).
    return token.rank >= committedRank;
  }

  /**
   * Record that a load has been committed (advances the monotonic floor).
   * @param {LoadToken} token
   */
  function commit(token) {
    if (!token) return;
    if (token.gen !== gen) return;
    if (token.rank > committedRank) committedRank = token.rank;
  }

  return {
    newGeneration,
    begin,
    canCommit,
    commit,
    get generation() {
      return gen;
    },
    get itemId() {
      return currentItemId;
    },
  };
}
