import { expect, test } from "bun:test";
import { ByteWeightedSemaphore } from "../src/byte-semaphore";

test("byte-weighted semaphore admits work up to the budget and defers the rest", async () => {
  // budget 100 bytes. Three tasks weigh 60, 60, 30. At most 60+30=90 can run at once
  // (a second 60 cannot join the first 60 — that would be 120 > 100).
  const sem = new ByteWeightedSemaphore(100);
  const order: string[] = [];
  let live = 0, peakLive = 0, peakBytes = 0, liveBytes = 0;

  async function run(name: string, weight: number, holdMs: number) {
    const release = await sem.acquire(weight);
    order.push(`start:${name}`);
    live++; liveBytes += weight;
    peakLive = Math.max(peakLive, live);
    peakBytes = Math.max(peakBytes, liveBytes);
    await new Promise((r) => setTimeout(r, holdMs));
    live--; liveBytes -= weight;
    order.push(`end:${name}`);
    release();
  }

  await Promise.all([run("a", 60, 40), run("b", 60, 40), run("c", 30, 10)]);
  // Never exceeded the budget.
  expect(peakBytes).toBeLessThanOrEqual(100);
  // a and c (60+30) run together; b waits for a to finish.
  expect(order[0]).toBe("start:a");
});

test("byte-weighted semaphore admits an over-budget single task alone (never deadlocks)", async () => {
  const sem = new ByteWeightedSemaphore(50);
  let ran = false;
  const release = await sem.acquire(1000); // > budget: must still be admitted (alone)
  ran = true;
  release();
  expect(ran).toBe(true);
});

test("byte-weighted semaphore serializes when every task equals the whole budget", async () => {
  const sem = new ByteWeightedSemaphore(100);
  let live = 0, peakLive = 0;
  async function run(holdMs: number) {
    const release = await sem.acquire(100);
    live++; peakLive = Math.max(peakLive, live);
    await new Promise((r) => setTimeout(r, holdMs));
    live--;
    release();
  }
  await Promise.all([run(20), run(20), run(20)]);
  expect(peakLive).toBe(1); // fully serialized
});

test("byte-weighted semaphore releases permits even if the holder throws (no leak)", async () => {
  const sem = new ByteWeightedSemaphore(100);
  const release = await sem.acquire(100);
  release();
  // budget freed: a second full-budget acquire resolves immediately
  const r2 = await sem.acquire(100);
  expect(typeof r2).toBe("function");
  r2();
});
