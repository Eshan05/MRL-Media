import { afterAll, describe, expect, it } from 'vitest';
import { createRedis } from '../src/limiter/redis.js';
import { fixedWindow } from '../src/limiter/fixed-window.js';

// Integration tests against real Redis: `pnpm redis:up` first.
const redis = createRedis();

// Controlled clock — jump time instead of sleeping. Every limiter takes
// `now` as an option precisely so these tests are deterministic.
let t = 1_000_000_000;
const clock = () => t;
const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${Math.random()}`;

afterAll(async () => {
  await redis.quit();
});

describe('fixed window', () => {
  it('allows up to the limit, then blocks', async () => {
    const rl = fixedWindow(redis, { name: uniqueName('t1'), limit: 3, windowMs: 60_000, now: clock });

    expect((await rl.check('u1')).allowed).toBe(true);
    expect((await rl.check('u1')).allowed).toBe(true);
    const third = await rl.check('u1');
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);

    const fourth = await rl.check('u1');
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
  });

  it('resets in the next window', async () => {
    const rl = fixedWindow(redis, { name: uniqueName('t2'), limit: 1, windowMs: 60_000, now: clock });

    expect((await rl.check('u1')).allowed).toBe(true);
    expect((await rl.check('u1')).allowed).toBe(false);

    t += 60_000; // one window later
    expect((await rl.check('u1')).allowed).toBe(true);
  });

  it('exhibits the boundary-burst flaw (documented, not fixed — that is what layer 2 is for)', async () => {
    const windowMs = 60_000;
    const rl = fixedWindow(redis, { name: uniqueName('t3'), limit: 5, windowMs, now: clock });

    // land at the very end of a window
    t = Math.floor(t / windowMs) * windowMs + windowMs - 1_000;
    for (let i = 0; i < 5; i++) expect((await rl.check('u1')).allowed).toBe(true);

    // 2 seconds later, fresh window: 5 more sail through — 10 in ~2s
    t += 2_000;
    for (let i = 0; i < 5; i++) expect((await rl.check('u1')).allowed).toBe(true);
  });

  it('isolates ids', async () => {
    const rl = fixedWindow(redis, { name: uniqueName('t4'), limit: 1, windowMs: 60_000, now: clock });
    expect((await rl.check('a')).allowed).toBe(true);
    expect((await rl.check('b')).allowed).toBe(true);
  });

  it('supports cost > 1', async () => {
    const rl = fixedWindow(redis, { name: uniqueName('t5'), limit: 10, windowMs: 60_000, now: clock });
    expect((await rl.check('u1', 7)).remaining).toBe(3);
    expect((await rl.check('u1', 4)).allowed).toBe(false); // 7+4 > 10
    expect((await rl.check('u1', 3)).allowed).toBe(true); // exactly full
  });

  it('optionally counts rejected attempts in the window counter', async () => {
    const windowMs = 60_000;
    t = Math.floor(t / windowMs) * windowMs + 1_000;
    const nameA = uniqueName('t6a');
    const nameB = uniqueName('t6b');
    const normal = fixedWindow(redis, { name: nameA, limit: 2, windowMs, now: clock });
    const punitive = fixedWindow(redis, { name: nameB, limit: 2, windowMs, now: clock, countRejected: true });

    for (let i = 0; i < 5; i++) {
      await normal.check('u1');
      await punitive.check('u1');
    }

    const windowId = Math.floor(t / windowMs);
    expect(await redis.get(`rl:fw:{${nameA}:u1}:${windowId}`)).toBe('2');
    expect(await redis.get(`rl:fw:{${nameB}:u1}:${windowId}`)).toBe('5');
  });
});
