import { readFileSync } from 'node:fs';
import type { RedisClient } from './redis.js';
import type { Clock, LimitResult, RateLimiter } from './types.js';

const lua = readFileSync(new URL('./scripts/sliding-window.lua', import.meta.url), 'utf8');

type WithCmd = RedisClient & {
  rlSlidingWindow(
    key: string,
    limit: number,
    windowMs: number,
    nowMs: number,
    cost: number,
  ): Promise<[number, number, number]>;
};

function ensureCommand(redis: RedisClient): WithCmd {
  const r = redis as WithCmd;
  if (typeof r.rlSlidingWindow !== 'function') {
    redis.defineCommand('rlSlidingWindow', { numberOfKeys: 1, lua });
  }
  return r;
}

export interface SlidingWindowOptions {
  /** limiter name — namespaces the redis keys */
  name: string;
  /** max weighted requests per window */
  limit: number;
  /** window length in ms */
  windowMs: number;
  /** injectable clock; defaults to Date.now */
  now?: Clock;
}

export function slidingWindow(redis: RedisClient, opts: SlidingWindowOptions): RateLimiter {
  const r = ensureCommand(redis);
  const now = opts.now ?? (() => Date.now());
  const key = (id: string) => `rl:sw:{${opts.name}:${id}}`;
  return {
    async check(id: string, cost = 1): Promise<LimitResult> {
      const [allowed, remaining, resetAt] = await r.rlSlidingWindow(
        key(id),
        opts.limit,
        opts.windowMs,
        now(),
        cost,
      );
      return { allowed: allowed === 1, remaining, resetAt };
    },
  };
}
