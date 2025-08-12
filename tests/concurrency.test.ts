import { afterAll, describe, expect, it } from 'vitest';
import { createRedis } from '../src/limiter/redis.js';
import { concurrency, NoSlotAvailableError } from '../src/limiter/concurrency.js';
import { testClock, uniqueName } from './util.js';

const redis = createRedis();

afterAll(async () => {
  await redis.quit();
});

describe('concurrency semaphore', () => {
  it('hands out at most `slots` concurrent holders', async () => {
    const clock = testClock();
    const cc = concurrency(redis, { name: uniqueName('cc1'), slots: 2, ttlMs: 60_000, now: clock.now });

    const a = await cc.acquire('u1');
    const b = await cc.acquire('u1');
    const c = await cc.acquire('u1');

    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    expect(c.acquired).toBe(false);
    expect(c.inUse).toBe(2);
  });

  it('release frees a slot for the next acquire', async () => {
    const clock = testClock();
    const cc = concurrency(redis, { name: uniqueName('cc2'), slots: 1, ttlMs: 60_000, now: clock.now });

    const a = await cc.acquire('u1');
    expect((await cc.acquire('u1')).acquired).toBe(false);

    expect(await cc.release('u1', a.holderId!)).toBe(true);
    expect((await cc.acquire('u1')).acquired).toBe(true);
  });

  it('reclaims slots from crashed holders after ttl', async () => {
    const clock = testClock();
    const cc = concurrency(redis, { name: uniqueName('cc3'), slots: 1, ttlMs: 5_000, now: clock.now });

    await cc.acquire('u1'); // never released — simulates a crashed worker
    expect((await cc.acquire('u1')).acquired).toBe(false);

    clock.advance(5_001);
    const later = await cc.acquire('u1');
    expect(later.acquired).toBe(true);
    expect(later.inUse).toBe(1); // the dead holder was swept, not stacked
  });

  it('release reports false when the holder was already swept', async () => {
    const clock = testClock();
    const cc = concurrency(redis, { name: uniqueName('cc4'), slots: 1, ttlMs: 5_000, now: clock.now });

    const a = await cc.acquire('u1');
    clock.advance(5_001);
    await cc.acquire('u1'); // sweeps the expired holder
    expect(await cc.release('u1', a.holderId!)).toBe(false);
  });

  it('run() releases on success and on failure', async () => {
    const clock = testClock();
    const cc = concurrency(redis, { name: uniqueName('cc5'), slots: 1, ttlMs: 60_000, now: clock.now });

    const result = await cc.run('u1', async () => 'done');
    expect(result).toBe('done');

    await expect(cc.run('u1', async () => {
      throw new Error('job failed');
    })).rejects.toThrow('job failed');

    // both runs released their slot
    expect((await cc.acquire('u1')).acquired).toBe(true);
  });

  it('run() throws NoSlotAvailableError when full', async () => {
    const clock = testClock();
    const cc = concurrency(redis, { name: uniqueName('cc6'), slots: 1, ttlMs: 60_000, now: clock.now });

    await cc.acquire('u1');
    await expect(cc.run('u1', async () => 'x')).rejects.toBeInstanceOf(NoSlotAvailableError);
  });

  it('isolates ids — tiers can differ per user', async () => {
    const clock = testClock();
    const cc = concurrency(redis, { name: uniqueName('cc7'), slots: 1, ttlMs: 60_000, now: clock.now });
    expect((await cc.acquire('free-user')).acquired).toBe(true);
    expect((await cc.acquire('pro-user')).acquired).toBe(true);
  });

  it('extend heartbeats a slow holder past the original ttl', async () => {
    const clock = testClock();
    const cc = concurrency(redis, { name: uniqueName('cc8'), slots: 1, ttlMs: 5_000, now: clock.now });

    const a = await cc.acquire('u1');
    expect(a.acquired).toBe(true);

    clock.advance(4_000);
    expect(await cc.extend('u1', a.holderId!)).toBe(true);

    clock.advance(2_000);
    expect((await cc.acquire('u1')).acquired).toBe(false);

    clock.advance(3_001);
    expect((await cc.acquire('u1')).acquired).toBe(true);
  });

  it('extend returns false after a holder has expired', async () => {
    const clock = testClock();
    const cc = concurrency(redis, { name: uniqueName('cc9'), slots: 1, ttlMs: 5_000, now: clock.now });

    const a = await cc.acquire('u1');
    clock.advance(5_001);
    expect(await cc.extend('u1', a.holderId!)).toBe(false);
  });
});
