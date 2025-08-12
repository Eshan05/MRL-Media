import { afterAll, describe, expect, it } from 'vitest';
import { createRedis } from '../src/limiter/redis.js';
import { scaledLimit, trustMultiplier, violationTracker } from '../src/limiter/adaptive.js';
import { uniqueName } from './util.js';

const redis = createRedis();

afterAll(async () => {
  await redis.quit();
});

const clean = { recentViolations: 0, globalQueueDepth: 0 };

describe('trustMultiplier (pure)', () => {
  it('throttles new accounts, rewards veterans', () => {
    expect(trustMultiplier({ accountAgeDays: 1, ...clean })).toBe(0.5);
    expect(trustMultiplier({ accountAgeDays: 30, ...clean })).toBe(1);
    expect(trustMultiplier({ accountAgeDays: 365, ...clean })).toBe(1.5);
  });

  it('violations divide trust down progressively', () => {
    const base = trustMultiplier({ accountAgeDays: 30, ...clean });
    const one = trustMultiplier({ accountAgeDays: 30, recentViolations: 1, globalQueueDepth: 0 });
    const four = trustMultiplier({ accountAgeDays: 30, recentViolations: 4, globalQueueDepth: 0 });
    expect(one).toBeLessThan(base);
    expect(four).toBeLessThan(one);
    expect(four).toBeCloseTo(1 / 3);
  });

  it('global backpressure scales everyone once the queue passes the soft limit', () => {
    const calm = trustMultiplier({ accountAgeDays: 365, ...clean });
    const busy = trustMultiplier({ accountAgeDays: 365, recentViolations: 0, globalQueueDepth: 300 });
    expect(busy).toBeCloseTo(calm * (100 / 300));
  });

  it('clamps to the configured floor and ceiling', () => {
    const worst = trustMultiplier({ accountAgeDays: 0, recentViolations: 50, globalQueueDepth: 10_000 });
    expect(worst).toBe(0.1);
    const best = trustMultiplier({ accountAgeDays: 365, ...clean }, { queueSoftLimit: 100, min: 0.1, max: 1.2 });
    expect(best).toBe(1.2);
  });
});

describe('scaledLimit', () => {
  it('scales and floors, but never below 1', () => {
    expect(scaledLimit(10, 1.5)).toBe(15);
    expect(scaledLimit(10, 0.5)).toBe(5);
    expect(scaledLimit(3, 0.1)).toBe(1);
  });
});

describe('violationTracker', () => {
  it('counts recorded violations', async () => {
    const vt = violationTracker(redis, { name: uniqueName('vt1') });
    expect(await vt.count('u1')).toBe(0);
    await vt.record('u1');
    await vt.record('u1');
    expect(await vt.count('u1')).toBe(2);
    expect(await vt.count('other')).toBe(0);
  });

  it('forgives violations once the window expires (trust recovery)', async () => {
    // the tracker's expiry runs on the redis server clock, so this is the
    // one test in the suite that genuinely has to sleep
    const vt = violationTracker(redis, { name: uniqueName('vt2'), windowMs: 1_200 });
    await vt.record('u1');
    expect(await vt.count('u1')).toBe(1);
    await new Promise((r) => setTimeout(r, 1_600));
    expect(await vt.count('u1')).toBe(0);
  }, 10_000);
});
