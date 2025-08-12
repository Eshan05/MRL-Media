import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { RedisClient } from './redis.js';
import type { Clock, LimitResult, RateLimiter } from './types.js';

const lua = readFileSync(new URL('./scripts/sliding-window-log.lua', import.meta.url), 'utf8');

type WithCmd = RedisClient & {
  rlSlidingWindowLog(
    key: string,
    limit: number,
    windowMs: number,
    nowMs: number,
    cost: number,
    member: string,
  ): Promise<[number, number, number]>;
};

function ensureCommand(redis: RedisClient): WithCmd {
  const r = redis as WithCmd;
  if (typeof r.rlSlidingWindowLog !== 'function') {
    redis.defineCommand('rlSlidingWindowLog', { numberOfKeys: 1, lua });
  }
  return r;
}

export interface ExactSlidingWindowOptions {
  /** limiter name — namespaces the redis keys */
  name: string;
  /** max request units in any rolling window */
  limit: number;
  /** rolling window length in ms */
  windowMs: number;
  /** injectable clock; defaults to Date.now */
  now?: Clock;
}

export function exactSlidingWindow(redis: RedisClient, opts: ExactSlidingWindowOptions): RateLimiter {
  const r = ensureCommand(redis);
  const now = opts.now ?? (() => Date.now());
  const key = (id: string) => `rl:swlog:{${opts.name}:${id}}`;
  return {
    async check(id: string, cost = 1): Promise<LimitResult> {
      if (!Number.isInteger(cost) || cost < 1) {
        throw new Error('exactSlidingWindow cost must be a positive integer');
      }
      const [allowed, remaining, resetAt] = await r.rlSlidingWindowLog(
        key(id),
        opts.limit,
        opts.windowMs,
        now(),
        cost,
        randomUUID(),
      );
      return { allowed: allowed === 1, remaining, resetAt };
    },
  };
}
