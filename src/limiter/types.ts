/** Injectable clock — every limiter takes `now` from the caller so tests can
 *  jump time deterministically instead of sleeping. */
export type Clock = () => number;

export interface LimitResult {
  allowed: boolean;
  /** capacity left after this call */
  remaining: number;
  /** epoch ms when capacity next resets or refills */
  resetAt: number;
}

export interface RateLimiter {
  check(id: string, cost?: number): Promise<LimitResult>;
}
