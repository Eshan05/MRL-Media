import { readFileSync } from 'node:fs';
import type { RedisClient } from './redis.js';
import type { Clock, LimitResult, RateLimiter } from './types.js';

const lua = readFileSync(new URL('./scripts/fixed-window.lua', import.meta.url), 'utf8');

type WithCmd = RedisClient & {
  rlFixedWindow(
    key: string,
    limit: number,
    windowMs: number,
    nowMs: number,
    cost: number,
    countRejected: number,
  ): Promise<[number, number, number]>;
};

function ensureCommand(redis: RedisClient): WithCmd {
  const r = redis as WithCmd;
  if (typeof r.rlFixedWindow !== 'function') {
    // defineCommand caches the script server-side (EVALSHA under the hood)
    redis.defineCommand('rlFixedWindow', { numberOfKeys: 1, lua });
  }
  return r;
}

export interface FixedWindowOptions {
  /** limiter name — namespaces the redis keys */
  name: string;
  /** max hits per window */
  limit: number;
  /** window length in ms */
  windowMs: number;
  /** when true, blocked attempts still increment the current window counter */
  countRejected?: boolean;
  /** injectable clock; defaults to Date.now */
  now?: Clock;
}

export function fixedWindow(redis: RedisClient, opts: FixedWindowOptions): RateLimiter {
  const r = ensureCommand(redis);
  const now = opts.now ?? (() => Date.now());
  const key = (id: string) => `rl:fw:{${opts.name}:${id}}`;
  return {
    async check(id: string, cost = 1): Promise<LimitResult> {
      const [allowed, remaining, resetAt] = await r.rlFixedWindow(
        key(id),
        opts.limit,
        opts.windowMs,
        now(),
        cost,
        opts.countRejected === true ? 1 : 0,
      );
      return { allowed: allowed === 1, remaining, resetAt };
    },
  };
}
