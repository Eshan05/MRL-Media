import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { RedisClient } from './redis.js';
import type { Clock } from './types.js';

const acquireLua = readFileSync(new URL('./scripts/concurrency-acquire.lua', import.meta.url), 'utf8');
const releaseLua = readFileSync(new URL('./scripts/concurrency-release.lua', import.meta.url), 'utf8');
const extendLua = readFileSync(new URL('./scripts/concurrency-extend.lua', import.meta.url), 'utf8');

type WithCmd = RedisClient & {
  rlConcAcquire(
    key: string,
    maxSlots: number,
    nowMs: number,
    ttlMs: number,
    holderId: string,
  ): Promise<[number, number]>;
  rlConcRelease(key: string, holderId: string): Promise<[number, number]>;
  rlConcExtend(key: string, nowMs: number, ttlMs: number, holderId: string): Promise<[number, number]>;
};

function ensureCommands(redis: RedisClient): WithCmd {
  const r = redis as WithCmd;
  if (typeof r.rlConcAcquire !== 'function') {
    redis.defineCommand('rlConcAcquire', { numberOfKeys: 1, lua: acquireLua });
  }
  if (typeof r.rlConcRelease !== 'function') {
    redis.defineCommand('rlConcRelease', { numberOfKeys: 1, lua: releaseLua });
  }
  if (typeof r.rlConcExtend !== 'function') {
    redis.defineCommand('rlConcExtend', { numberOfKeys: 1, lua: extendLua });
  }
  return r;
}

export class NoSlotAvailableError extends Error {
  constructor(
    public readonly limiterName: string,
    public readonly id: string,
    public readonly inUse: number,
  ) {
    super(`no free slot on '${limiterName}' for '${id}' (${inUse} in use)`);
    this.name = 'NoSlotAvailableError';
  }
}

export interface AcquireResult {
  acquired: boolean;
  /** pass back to release(); undefined when not acquired */
  holderId?: string;
  inUse: number;
}

export interface ConcurrencyOptions {
  /** limiter name — namespaces the redis keys */
  name: string;
  /** max simultaneous holders per id */
  slots: number;
  /** safety valve: a slot held longer than this is considered leaked by a
   *  crashed worker and reclaimed. Set generously above the longest job. */
  ttlMs: number;
  /** injectable clock; defaults to Date.now */
  now?: Clock;
}

export interface ConcurrencyLimiter {
  acquire(id: string): Promise<AcquireResult>;
  /** returns false if the holder had already been swept (job outlived ttlMs) */
  release(id: string, holderId: string): Promise<boolean>;
  /** heartbeat a long-running holder; false means it expired or never existed */
  extend(id: string, holderId: string, ttlMs?: number): Promise<boolean>;
  /** acquire, run, always release; throws NoSlotAvailableError when full */
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export function concurrency(redis: RedisClient, opts: ConcurrencyOptions): ConcurrencyLimiter {
  const r = ensureCommands(redis);
  const now = opts.now ?? (() => Date.now());
  const key = (id: string) => `rl:cc:{${opts.name}:${id}}`;

  return {
    async acquire(id: string): Promise<AcquireResult> {
      const holderId = randomUUID();
      const [acquired, inUse] = await r.rlConcAcquire(key(id), opts.slots, now(), opts.ttlMs, holderId);
      return acquired === 1 ? { acquired: true, holderId, inUse } : { acquired: false, inUse };
    },

    async release(id: string, holderId: string): Promise<boolean> {
      const [released] = await r.rlConcRelease(key(id), holderId);
      return released === 1;
    },

    async extend(id: string, holderId: string, ttlMs = opts.ttlMs): Promise<boolean> {
      const [extended] = await r.rlConcExtend(key(id), now(), ttlMs, holderId);
      return extended === 1;
    },

    async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
      const res = await this.acquire(id);
      if (!res.acquired || res.holderId === undefined) {
        throw new NoSlotAvailableError(opts.name, id, res.inUse);
      }
      try {
        return await fn();
      } finally {
        await this.release(id, res.holderId);
      }
    },
  };
}
