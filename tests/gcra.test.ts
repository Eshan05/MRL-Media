import { afterAll, describe, expect, it } from 'vitest';
import { createRedis } from '../src/limiter/redis.js';
import { gcra } from '../src/limiter/gcra.js';
import { testClock, uniqueName } from './util.js';

const redis = createRedis();

afterAll(async () => {
  await redis.quit();
});

describe('gcra', () => {
  it('enforces exact spacing with burst=1', async () => {
    const clock = testClock();
    const rl = gcra(redis, { name: uniqueName('g1'), intervalMs: 500, now: clock.now });

    const first = await rl.check('dest');
    expect(first.allowed).toBe(true);
    expect(first.retryAt).toBe(clock.value);

    clock.advance(499);
    const tooSoon = await rl.check('dest');
    expect(tooSoon.allowed).toBe(false);
    expect(tooSoon.retryAt).toBe(clock.value + 1); // exactly interval after the first

    clock.advance(1);
    expect((await rl.check('dest')).allowed).toBe(true);
  });

  it('permits a configured burst, then enforces spacing again', async () => {
    const clock = testClock();
    const rl = gcra(redis, { name: uniqueName('g2'), intervalMs: 1_000, burst: 3, now: clock.now });

    // 3 back-to-back are fine
    expect((await rl.check('dest')).allowed).toBe(true);
    expect((await rl.check('dest')).allowed).toBe(true);
    expect((await rl.check('dest')).allowed).toBe(true);
    // 4th is over the burst tolerance
    const fourth = await rl.check('dest');
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAt).toBe(clock.value + 1_000);

    // one interval later exactly one slot has drained
    clock.advance(1_000);
    expect((await rl.check('dest')).allowed).toBe(true);
    expect((await rl.check('dest')).allowed).toBe(false);
  });

  it('a long idle period does not build up unlimited credit', async () => {
    const clock = testClock();
    const rl = gcra(redis, { name: uniqueName('g3'), intervalMs: 1_000, burst: 2, now: clock.now });

    await rl.check('dest');
    clock.advance(3_600_000); // an hour idle

    // credit is capped at the burst, exactly like a full token bucket
    expect((await rl.check('dest')).allowed).toBe(true);
    expect((await rl.check('dest')).allowed).toBe(true);
    expect((await rl.check('dest')).allowed).toBe(false);
  });

  it('isolates destinations', async () => {
    const clock = testClock();
    const rl = gcra(redis, { name: uniqueName('g4'), intervalMs: 1_000, now: clock.now });
    expect((await rl.check('a')).allowed).toBe(true);
    expect((await rl.check('b')).allowed).toBe(true);
  });
});
