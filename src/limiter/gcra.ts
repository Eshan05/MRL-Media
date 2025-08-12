import { readFileSync } from 'node:fs';
import type { RedisClient } from './redis.js';
import type { Clock } from './types.js';

const lua = readFileSync(new URL('./scripts/gcra.lua', import.meta.url), 'utf8');

type WithCmd = RedisClient & {
  rlGcra(
    key: string,
    intervalMs: number,
    tauMs: number,
    nowMs: number,
    cost: number,
  ): Promise<[number, number]>;
};

function ensureCommand(redis: RedisClient): WithCmd {
  const r = redis as WithCmd;
  if (typeof r.rlGcra !== 'function') {
    redis.defineCommand('rlGcra', { numberOfKeys: 1, lua });
  }
  return r;
}

/**
 * GCRA has no meaningful "remaining" — it limits SPACING, not a count.
 * The useful answer to a blocked caller is when to come back.
 */
export interface GcraResult {
  allowed: boolean;
  /** earliest epoch ms the call is / would be allowed; equals now when allowed */
  retryAt: number;
}

export interface GcraOptions {
  /** limiter name — namespaces the redis keys */
  name: string;
  /** emission interval in ms — 1 request / 2s pacing = 2000 */
  intervalMs: number;
  /** how many calls may arrive back-to-back before spacing kicks in (default 1: perfectly smooth) */
  burst?: number;
  /** injectable clock; defaults to Date.now */
  now?: Clock;
}

export interface GcraLimiter {
  check(id: string, cost?: number): Promise<GcraResult>;
}

export function gcra(redis: RedisClient, opts: GcraOptions): GcraLimiter {
  const r = ensureCommand(redis);
  const now = opts.now ?? (() => Date.now());
  const tau = (Math.max(1, opts.burst ?? 1) - 1) * opts.intervalMs;
  const key = (id: string) => `rl:gcra:{${opts.name}:${id}}`;
  return {
    async check(id: string, cost = 1): Promise<GcraResult> {
      const [allowed, retryAt] = await r.rlGcra(
        key(id),
        opts.intervalMs,
        tau,
        now(),
        cost,
      );
      return { allowed: allowed === 1, retryAt };
    },
  };
}
