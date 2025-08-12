import { afterAll, describe, expect, it } from 'vitest';
import { trustMultiplier } from '../src/limiter/adaptive.js';
import { createRedis } from '../src/limiter/redis.js';
import { slidingWindow } from '../src/limiter/sliding-window.js';
import { tokenBucket } from '../src/limiter/token-bucket.js';
import { testClock, uniqueName } from './util.js';

const redis = createRedis();

afterAll(async () => {
  await redis.quit();
});

describe('layer triggerability', () => {
  it('layer 2 can block at full trust while layer 3 would still admit paced uploads', async () => {
    const windowMs = 60_000;
    const clock = testClock();
    clock.set(Math.floor(clock.value / windowMs) * windowMs + 100);

    const user = uniqueName('full-trust-l2');
    const sw = slidingWindow(redis, { name: uniqueName('user'), limit: 30, windowMs, now: clock.now });
    const tb = tokenBucket(redis, {
      name: uniqueName('upload'),
      capacity: 5,
      refillPerSec: 0.5,
      now: clock.now,
    });

    expect(trustMultiplier({ accountAgeDays: 30, recentViolations: 0, globalQueueDepth: 0 })).toBe(1);

    let attempts = 0;
    for (; attempts < 5; attempts++) {
      expect((await sw.check(user)).allowed).toBe(true);
      expect((await tb.check(user)).allowed).toBe(true);
    }

    while (attempts < 30) {
      clock.advance(2_050);
      attempts++;
      expect((await sw.check(user)).allowed).toBe(true);
      expect((await tb.check(user)).allowed).toBe(true);
    }

    clock.advance(2_050);
    const slidingBlocked = await sw.check(user);
    const bucketWouldAllow = await tb.check(user);

    expect(slidingBlocked.allowed).toBe(false);
    expect(bucketWouldAllow.allowed).toBe(true);
  });
});
