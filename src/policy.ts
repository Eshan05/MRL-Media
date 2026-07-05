import type { Tier } from './jobs/types.js';

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function envFloat(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Every limit, window, and slot count in one place. Server and worker
 * import from here and nowhere else — tuning is a config review, not a
 * code hunt. Env overrides also live here and only here.
 */
export const POLICY = {
  /** layer 1 — coarse per-IP wall, fires before auth */
  ip: { limit: 100, windowMs: 60_000 },
  /** layer 1 variant — account creation is the classic abuse surface */
  signup: { limit: 5, windowMs: 60 * 60_000 },
  /** layer 2 — per-user sliding window, scaled by trust */
  user: { limit: 30, windowMs: 60_000 },
  /** no-account uploads are intentionally smaller and expire automatically */
  anonymous: {
    trust: 0.5,
    uploadBurst: envInt('ANON_UPLOAD_BURST', 2),
    uploadRefillPerSec: envFloat('ANON_UPLOAD_REFILL_PER_SEC', 0.1),
    retentionDays: envInt('ANON_RETENTION_DAYS', 7),
  },
  /** layer 3 — upload token bucket, scaled by trust */
  upload: { burst: 5, refillPerSec: 0.5 },
  /** layer 4a — simultaneous uploads in flight per user */
  inflight: { slots: { anonymous: 1, free: 2, pro: 5 } as Record<Tier, number>, ttlMs: 5 * 60_000 },
  /** layer 4b — transcode slots per user (worker) */
  transcode: {
    slots: {
      anonymous: envInt('TRANSCODE_SLOTS_ANONYMOUS', 1),
      free: envInt('TRANSCODE_SLOTS_FREE', 3),
      pro: envInt('TRANSCODE_SLOTS_PRO', 10),
    } as Record<Tier, number>,
    ttlMs: 10 * 60_000,
    noSlotRetryMs: 2_000,
  },
  /** layer 5 — webhook egress pacing per destination host */
  webhook: {
    intervalMs: 2_000,
    burst: 2,
    attempts: 5,
    backoffMs: 1_000,
    /** local dev/tests deliver to 127.0.0.1 — production must NOT set this */
    allowPrivate: process.env.WEBHOOK_ALLOW_PRIVATE === '1',
  },
  /** layer 6 — trust multiplier tuning (see limiter/adaptive.ts) */
  adaptive: { queueSoftLimit: 100, min: 0.1, max: 2 },
  maxFileBytes: 50 * 1024 * 1024,
} as const;
