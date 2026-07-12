import { expect, test } from 'bun:test';
import { createLoadGuard } from './load-generation.js';

// The load guard decides whether a decode result that has just returned from an
// await is still allowed to commit to the shared view state (finding 42). It
// captures a token BEFORE the await and rechecks it BEFORE the commit.

test('a load committed against the same generation is accepted', () => {
  const guard = createLoadGuard();
  guard.newGeneration('A');
  const token = guard.begin({ itemId: 'A', contenthash: 'lvl1', rank: 100 });
  expect(guard.canCommit(token)).toBe(true);
});

test('a late OLD-IMAGE load cannot overwrite the current image', () => {
  const guard = createLoadGuard();
  // Start loading image A (captured before its await).
  guard.newGeneration('A');
  const tokenA = guard.begin({ itemId: 'A', contenthash: 'a1', rank: 100 });
  // The user navigates to image B: a new generation opens.
  guard.newGeneration('B');
  const tokenB = guard.begin({ itemId: 'B', contenthash: 'b1', rank: 100 });

  // A's decode finishes late. It must NOT commit — its generation is stale.
  expect(guard.canCommit(tokenA)).toBe(false);
  // B's decode is current and commits.
  expect(guard.canCommit(tokenB)).toBe(true);
});

test('a stale-generation load is rejected even if its item id happens to match', () => {
  const guard = createLoadGuard();
  guard.newGeneration('A');
  const t1 = guard.begin({ itemId: 'A', contenthash: 'a-small', rank: 50 });
  // Re-open the SAME image (fresh generation, e.g. re-click) — old in-flight load is stale.
  guard.newGeneration('A');
  expect(guard.canCommit(t1)).toBe(false);
});

test('within one generation, only a monotonically-better level commits', () => {
  const guard = createLoadGuard();
  guard.newGeneration('A');
  // Commit a mid level first.
  const mid = guard.begin({ itemId: 'A', contenthash: 'mid', rank: 100 });
  expect(guard.canCommit(mid)).toBe(true);
  guard.commit(mid);

  // A LATE lower-rank decode must not clobber the higher level painted meanwhile.
  const low = guard.begin({ itemId: 'A', contenthash: 'low', rank: 50 });
  expect(guard.canCommit(low)).toBe(false);

  // A higher-rank upgrade IS allowed to commit.
  const high = guard.begin({ itemId: 'A', contenthash: 'high', rank: 200 });
  expect(guard.canCommit(high)).toBe(true);
});

test('re-committing the exact same level (same rank) is allowed (idempotent refresh)', () => {
  const guard = createLoadGuard();
  guard.newGeneration('A');
  const t = guard.begin({ itemId: 'A', contenthash: 'x', rank: 100 });
  guard.commit(t);
  // Same contenthash reload (e.g. mode toggle) at equal rank is permitted.
  const again = guard.begin({ itemId: 'A', contenthash: 'x', rank: 100 });
  expect(guard.canCommit(again)).toBe(true);
});

test('two overlapping loads in the same generation: the higher wins regardless of arrival order', () => {
  const guard = createLoadGuard();
  guard.newGeneration('A');
  const low = guard.begin({ itemId: 'A', contenthash: 'low', rank: 50 });
  const high = guard.begin({ itemId: 'A', contenthash: 'high', rank: 200 });

  // High arrives first and commits.
  expect(guard.canCommit(high)).toBe(true);
  guard.commit(high);
  // Low arrives late: rejected (would be a downgrade).
  expect(guard.canCommit(low)).toBe(false);
});

test('newGeneration resets the committed rank so the next image can paint from scratch', () => {
  const guard = createLoadGuard();
  guard.newGeneration('A');
  const a = guard.begin({ itemId: 'A', contenthash: 'a', rank: 300 });
  guard.commit(a);

  // Navigate to a smaller image B: its first (low-rank) level must be allowed
  // even though A committed a higher rank.
  guard.newGeneration('B');
  const b = guard.begin({ itemId: 'B', contenthash: 'b', rank: 40 });
  expect(guard.canCommit(b)).toBe(true);
});

test('open() seed race (M-1): a stale open cannot write its seed after a newer open ran during the manifest await', () => {
  // Reproduces the open()-seed hazard: open() bumps the generation and captures a
  // token (rank -Infinity, the seed floor) BEFORE awaiting getManifest; a rapid
  // second open()/navigate() opens a fresher generation during that await; the
  // first open resumes and must NOT commit its (now stale) LRU-seed / blank-buffer.
  const guard = createLoadGuard();

  // open(A): bump generation, capture the seed token before the manifest await.
  guard.newGeneration('A');
  const openTokenA = guard.begin({ itemId: 'A', contenthash: 'open-seed', rank: -Infinity });

  // During A's await, the user navigates: open(B) bumps to a fresher generation.
  guard.newGeneration('B');
  const openTokenB = guard.begin({ itemId: 'B', contenthash: 'open-seed', rank: -Infinity });

  // A resumes: its seed writes are gated on canCommit(openTokenA) -> must be false
  // (stale generation), so the stale seed is skipped and B's view is preserved.
  expect(guard.canCommit(openTokenA)).toBe(false);
  // B's own seed is current and may commit (first paint of the live generation).
  expect(guard.canCommit(openTokenB)).toBe(true);
});

test('open() seed token (rank -Infinity) commits as the first paint of a current generation but never over a real level', () => {
  const guard = createLoadGuard();
  guard.newGeneration('A');
  // Fresh generation, nothing committed: the -Infinity seed floor is allowed.
  const seed = guard.begin({ itemId: 'A', contenthash: 'open-seed', rank: -Infinity });
  expect(guard.canCommit(seed)).toBe(true);

  // Once a real level commits, a late seed recheck must not clobber it.
  const real = guard.begin({ itemId: 'A', contenthash: 'lvl', rank: 100 });
  guard.commit(real);
  const lateSeed = guard.begin({ itemId: 'A', contenthash: 'open-seed', rank: -Infinity });
  expect(guard.canCommit(lateSeed)).toBe(false);
});
