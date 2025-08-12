import type { RedisClient } from './redis.js';

/**
 * Layer 6: adaptive limiting.
 *
 * Deliberately NOT another Lua script — it is a multiplier over the
 * parameters of layers 2–4, computed from trust and load signals.
 * Keeping it out of the individual limiters keeps them composable:
 * every limiter stays a pure mechanism, policy lives here.
 */

export interface TrustSignals {
  accountAgeDays: number;
  /** limiter violations in the recent window (see violationTracker) */
  recentViolations: number;
  /** transcode jobs waiting globally — backpressure signal */
  globalQueueDepth: number;
}

export interface AdaptiveTuning {
  /** queue depth beyond which everyone gets scaled down */
  queueSoftLimit: number;
  /** floor/ceiling for the multiplier */
  min: number;
  max: number;
}

export const DEFAULT_TUNING: AdaptiveTuning = {
  queueSoftLimit: 100,
  min: 0.1,
  max: 2,
};

/**
 * Pure and deterministic — unit-testable without redis.
 *
 * Shape: trust sets the base (new accounts start throttled, veterans get
 * headroom), violations divide it down, global backpressure scales
 * everyone once the queue passes the soft limit.
 */
export function trustMultiplier(s: TrustSignals, tuning: AdaptiveTuning = DEFAULT_TUNING): number {
  let m: number;
  if (s.accountAgeDays < 7) {
    m = 0.5;
  } else if (s.accountAgeDays >= 90) {
    m = 1.5;
  } else {
    m = 1;
  }

  // each recent violation halves the headroom on top of the last
  m /= 1 + 0.5 * s.recentViolations;

  if (s.globalQueueDepth > tuning.queueSoftLimit) {
    m *= tuning.queueSoftLimit / s.globalQueueDepth;
  }

  return Math.min(tuning.max, Math.max(tuning.min, m));
}

/** Apply a multiplier to a limit, never dropping below 1. */
export function scaledLimit(baseLimit: number, multiplier: number): number {
  return Math.max(1, Math.floor(baseLimit * multiplier));
}

export interface ViolationTracker {
  /** call when any limiter blocks this id */
  record(id: string): Promise<void>;
  count(id: string): Promise<number>;
}

/**
 * Violation memory backing TrustSignals.recentViolations.
 * Plain INCR with a rolling expiry: each new violation keeps the count
 * alive another windowMs, so persistent offenders stay remembered.
 */
export function violationTracker(
  redis: RedisClient,
  opts: { name: string; windowMs?: number },
): ViolationTracker {
  const windowMs = opts.windowMs ?? 60 * 60 * 1000;
  const key = (id: string) => `rl:viol:{${opts.name}:${id}}`;
  return {
    async record(id: string): Promise<void> {
      await redis.multi().incr(key(id)).pexpire(key(id), windowMs).exec();
    },
    async count(id: string): Promise<number> {
      const v = await redis.get(key(id));
      return v === null ? 0 : Number(v);
    },
  };
}
