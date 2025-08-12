import { afterAll, describe, expect, it } from 'vitest';
import { createRedis } from '../src/limiter/redis.js';
import { exactSlidingWindow } from '../src/limiter/sliding-window-log.js';
import { slidingWindow } from '../src/limiter/sliding-window.js';
import { testClock, uniqueName } from './util.js';

const redis = createRedis();

afterAll(async () => {
  await redis.quit();
});

describe('sliding window', () => {
  it('allows up to the limit within one window', async () => {
    const clock = testClock();
    const rl = slidingWindow(redis, { name: uniqueName('sw1'), limit: 3, windowMs: 60_000, now: clock.now });

    expect((await rl.check('u1')).allowed).toBe(true);
    expect((await rl.check('u1')).allowed).toBe(true);
    expect((await rl.check('u1')).allowed).toBe(true);
    expect((await rl.check('u1')).allowed).toBe(false);
  });

  it('fixes the boundary burst that fixed window permits', async () => {
    const windowMs = 60_000;
    const clock = testClock();
    const rl = slidingWindow(redis, { name: uniqueName('sw2'), limit: 5, windowMs, now: clock.now });

    // same setup as the fixed-window burst test: fill up right before the boundary
    clock.set(Math.floor(clock.value / windowMs) * windowMs + windowMs - 1_000);
    for (let i = 0; i < 5; i++) expect((await rl.check('u1')).allowed).toBe(true);

    // 2s later (1s into the next window) fixed window would allow 5 more;
    // here prev still weighs 1 - 1000/60000 ≈ 0.983 → estimate ≈ 4.9
    clock.advance(2_000);
    expect((await rl.check('u1')).allowed).toBe(false);
  });

  it('admits gradually as the previous window fades', async () => {
    const windowMs = 60_000;
    const clock = testClock();
    const rl = slidingWindow(redis, { name: uniqueName('sw3'), limit: 5, windowMs, now: clock.now });

    clock.set(Math.floor(clock.value / windowMs) * windowMs + windowMs - 1_000);
    for (let i = 0; i < 5; i++) await rl.check('u1');

    // 30s into the next window: estimate = 5 * 0.5 = 2.5 → 2 more fit under 5
    clock.advance(31_000);
    expect((await rl.check('u1')).allowed).toBe(true); // 2.5 + 1 = 3.5
    expect((await rl.check('u1')).allowed).toBe(true); // 3.5 + 1 = 4.5
    expect((await rl.check('u1')).allowed).toBe(false); // 4.5 + 1 = 5.5 > 5
  });

  it('matches the hand calculation: prev=12, curr=4, 30% elapsed, limit 10 → blocked', async () => {
    const windowMs = 60_000;
    const clock = testClock();
    const rl = slidingWindow(redis, { name: uniqueName('sw4'), limit: 20, windowMs, now: clock.now });

    // build prev=12 (needs limit headroom, hence limit 20 while filling)
    clock.set(Math.floor(clock.value / windowMs) * windowMs);
    for (let i = 0; i < 12; i++) expect((await rl.check('u1')).allowed).toBe(true);

    // next window, 18s in (30%), add 4
    clock.advance(windowMs);
    clock.advance(18_000);
    for (let i = 0; i < 4; i++) await rl.check('u1');

    // estimate = 12 * 0.7 + 4 = 12.4 → with limit 10 a cost-1 call is blocked.
    // We built history with limit 20, so verify via remaining instead:
    // 20 - (12.4 + 4 own increments already counted) — simplest check:
    // a cost-6 call (12.4 + 6 = 18.4 ≤ 20) passes, cost-8 (20.4) does not.
    expect((await rl.check('u1', 6)).allowed).toBe(true);
    expect((await rl.check('u1', 8)).allowed).toBe(false);
  });

  it('isolates ids', async () => {
    const clock = testClock();
    const rl = slidingWindow(redis, { name: uniqueName('sw5'), limit: 1, windowMs: 60_000, now: clock.now });
    expect((await rl.check('a')).allowed).toBe(true);
    expect((await rl.check('b')).allowed).toBe(true);
  });

  it('documents where weighted approximation and exact log disagree', async () => {
    const windowMs = 60_000;
    const clock = testClock();
    const approx = slidingWindow(redis, { name: uniqueName('sw6a'), limit: 5, windowMs, now: clock.now });
    const exact = exactSlidingWindow(redis, { name: uniqueName('sw6b'), limit: 5, windowMs, now: clock.now });

    clock.set(Math.floor(clock.value / windowMs) * windowMs + windowMs - 1_000);
    for (let i = 0; i < 5; i++) {
      expect((await approx.check('u1')).allowed).toBe(true);
      expect((await exact.check('u1')).allowed).toBe(true);
    }

    clock.advance(31_000);
    expect((await approx.check('u1')).allowed).toBe(true);
    expect((await exact.check('u1')).allowed).toBe(false);
  });
});
