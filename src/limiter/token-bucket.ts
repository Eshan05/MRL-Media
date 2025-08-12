import { readFileSync } from 'node:fs';
import type { RedisClient } from './redis.js';
import type { Clock, LimitResult, RateLimiter } from './types.js';

const lua = readFileSync(new URL('./scripts/token-bucket.lua', import.meta.url), 'utf8');
const peekLua = readFileSync(new URL('./scripts/token-bucket-peek.lua', import.meta.url), 'utf8');

type WithCmd = RedisClient & {
  rlTokenBucket(
    key: string,
    capacity: number,
    refillPerSec: number,
    nowMs: number,
    cost: number,
  ): Promise<[number, number, number]>;
  rlTokenBucketPeek(
    key: string,
    capacity: number,
    refillPerSec: number,
    nowMs: number,
    cost: number,
  ): Promise<[number, number]>;
};

function ensureCommand(redis: RedisClient): WithCmd {
  const r = redis as WithCmd;
  if (typeof r.rlTokenBucket !== 'function') {
    redis.defineCommand('rlTokenBucket', { numberOfKeys: 1, lua });
  }
  if (typeof r.rlTokenBucketPeek !== 'function') {
    redis.defineCommand('rlTokenBucketPeek', { numberOfKeys: 1, lua: peekLua });
  }
  return r;
}

export interface TokenBucketOptions {
  /** limiter name — namespaces the redis keys */
  name: string;
  /** bucket size — the burst a client may spend at once */
  capacity: number;
  /** sustained refill rate in tokens per second (fractional is fine) */
  refillPerSec: number;
  /** injectable clock; defaults to Date.now */
  now?: Clock;
}

export interface TokenBucketSnapshot {
  /** floored tokens available at this instant */
  remaining: number;
  /** now when at least cost tokens are available; otherwise the refill time */
  resetAt: number;
}

export interface TokenBucketLimiter extends RateLimiter {
  peek(id: string, cost?: number): Promise<TokenBucketSnapshot>;
}

export function tokenBucket(redis: RedisClient, opts: TokenBucketOptions): TokenBucketLimiter {
  const r = ensureCommand(redis);
  const now = opts.now ?? (() => Date.now());
  const key = (id: string) => `rl:tb:{${opts.name}:${id}}`;
  return {
    async check(id: string, cost = 1): Promise<LimitResult> {
      const [allowed, remaining, resetAt] = await r.rlTokenBucket(
        key(id),
        opts.capacity,
        opts.refillPerSec,
        now(),
        cost,
      );
      return { allowed: allowed === 1, remaining, resetAt };
    },

    async peek(id: string, cost = 1): Promise<TokenBucketSnapshot> {
      const [remaining, resetAt] = await r.rlTokenBucketPeek(
        key(id),
        opts.capacity,
        opts.refillPerSec,
        now(),
        cost,
      );
      return { remaining, resetAt };
    },
  };
}
