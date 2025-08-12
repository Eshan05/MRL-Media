export type { Clock, LimitResult, RateLimiter } from './types.js';
export { createRedis, parseClusterNodes, type RedisClient } from './redis.js';

// layer 1 — per-IP coarse protection
export { fixedWindow, type FixedWindowOptions } from './fixed-window.js';
// layer 2 — per-user smoothing
export { slidingWindow, type SlidingWindowOptions } from './sliding-window.js';
export { exactSlidingWindow, type ExactSlidingWindowOptions } from './sliding-window-log.js';
// layer 3 — bursty actions (uploads)
export { tokenBucket, type TokenBucketLimiter, type TokenBucketOptions, type TokenBucketSnapshot } from './token-bucket.js';
// layer 4 — slots for long-running work
export {
  concurrency,
  NoSlotAvailableError,
  type AcquireResult,
  type ConcurrencyLimiter,
  type ConcurrencyOptions,
} from './concurrency.js';
// layer 5 — paced egress
export { gcra, type GcraLimiter, type GcraOptions, type GcraResult } from './gcra.js';
// layer 6 — trust/load multiplier over layers 2–4
export {
  trustMultiplier,
  scaledLimit,
  violationTracker,
  DEFAULT_TUNING,
  type AdaptiveTuning,
  type TrustSignals,
  type ViolationTracker,
} from './adaptive.js';
