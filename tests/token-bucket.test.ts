import { afterAll, describe, expect, it } from 'vitest';
import { createRedis } from '../src/limiter/redis.js';
import { tokenBucket } from '../src/limiter/token-bucket.js';
import { testClock, uniqueName } from './util.js';

const redis = createRedis();

afterAll(async () => {
  await redis.quit();
});

describe('token bucket', () => {
  it('allows a full burst, then blocks', async () => {
    const clock = testClock();
    const rl = tokenBucket(redis, { name: uniqueName('tb1'), capacity: 5, refillPerSec: 1, now: clock.now });

    for (let i = 0; i < 5; i++) expect((await rl.check('u1')).allowed).toBe(true);
    const blocked = await rl.check('u1');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    // 0 tokens, need 1, refill 1/s → allowed again in exactly 1s
    expect(blocked.resetAt).toBe(clock.value + 1_000);
  });

  it('refills over time at the sustained rate', async () => {
    const clock = testClock();
    const rl = tokenBucket(redis, { name: uniqueName('tb2'), capacity: 5, refillPerSec: 1, now: clock.now });

    for (let i = 0; i < 5; i++) await rl.check('u1'); // drain

    clock.advance(2_000); // +2 tokens
    expect((await rl.check('u1')).allowed).toBe(true);
    expect((await rl.check('u1')).allowed).toBe(true);
    expect((await rl.check('u1')).allowed).toBe(false);
  });

  it('never accumulates beyond capacity', async () => {
    const clock = testClock();
    const rl = tokenBucket(redis, { name: uniqueName('tb3'), capacity: 3, refillPerSec: 1, now: clock.now });

    await rl.check('u1'); // touch so state exists, 2 left
    clock.advance(3_600_000); // an hour of idling
    // capacity 3, not 3602
    expect((await rl.check('u1', 3)).allowed).toBe(true);
    expect((await rl.check('u1')).allowed).toBe(false);
  });

  it('supports fractional refill rates', async () => {
    const clock = testClock();
    // 1 token per 10s
    const rl = tokenBucket(redis, { name: uniqueName('tb4'), capacity: 1, refillPerSec: 0.1, now: clock.now });

    expect((await rl.check('u1')).allowed).toBe(true);
    const blocked = await rl.check('u1');
    expect(blocked.allowed).toBe(false);
    expect(blocked.resetAt).toBe(clock.value + 10_000);

    clock.advance(10_000);
    expect((await rl.check('u1')).allowed).toBe(true);
  });

  it('cost > 1 spends multiple tokens atomically', async () => {
    const clock = testClock();
    const rl = tokenBucket(redis, { name: uniqueName('tb5'), capacity: 10, refillPerSec: 1, now: clock.now });

    expect((await rl.check('u1', 7)).remaining).toBe(3);
    expect((await rl.check('u1', 4)).allowed).toBe(false);
    expect((await rl.check('u1', 3)).allowed).toBe(true);
  });

  it('peek lazily refills without spending tokens or writing state', async () => {
    const clock = testClock();
    const name = uniqueName('tb6');
    const rl = tokenBucket(redis, { name, capacity: 5, refillPerSec: 1, now: clock.now });

    expect(await rl.peek('new-user')).toEqual({ remaining: 5, resetAt: clock.value });
    expect(await redis.exists(`rl:tb:{${name}:new-user}`)).toBe(0);

    await rl.check('u1', 5);
    clock.advance(2_000);
    expect(await rl.peek('u1')).toEqual({ remaining: 2, resetAt: clock.value });
    expect((await rl.check('u1', 2)).allowed).toBe(true);
    expect((await rl.check('u1')).allowed).toBe(false);
  });
});
