import type { Queue } from 'bullmq';
import {
  claimOutboxBatch,
  markFileQueued,
  markOutboxDispatched,
  releaseOutbox,
  type JobOutboxRow,
} from '../db.js';
import { POLICY } from '../policy.js';
import type { TranscodeJobData, TranscodeResult } from './types.js';

type DispatcherLogger = Pick<Console, 'error' | 'warn'>;

export interface OutboxDispatcher {
  dispatchOnce(): Promise<number>;
  close(): Promise<void>;
}

export function startOutboxDispatcher(
  queue: Queue<TranscodeJobData, TranscodeResult>,
  logger: DispatcherLogger = console,
): OutboxDispatcher {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<number> | undefined;

  async function dispatchEvent(event: JobOutboxRow): Promise<void> {
    try {
      await queue.add('transcode', event.payload, {
        jobId: event.file_id,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 3_600 },
        removeOnFail: { age: 86_400 },
      });
      await markOutboxDispatched(event.id);
      await markFileQueued(event.file_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const exponent = Math.min(16, Math.max(0, event.attempts - 1));
      const delay = Math.min(POLICY.outbox.retryMaxMs, POLICY.outbox.retryBaseMs * 2 ** exponent);
      try {
        await releaseOutbox(event.id, message, Date.now() + delay);
      } catch (releaseErr) {
        logger.error(`[outbox] failed to release ${event.id}: ${(releaseErr as Error).message}`);
      }
      logger.warn(`[outbox] dispatch ${event.id} failed; retrying in ${delay}ms: ${message}`);
    }
  }

  async function dispatchOnce(): Promise<number> {
    const events = await claimOutboxBatch({
      now: Date.now(),
      leaseMs: POLICY.outbox.leaseMs,
      limit: POLICY.outbox.batchSize,
    });
    await Promise.all(events.map(dispatchEvent));
    return events.length;
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    active = dispatchOnce();
    try {
      await active;
    } catch (err) {
      logger.error(`[outbox] claim failed: ${(err as Error).message}`);
    } finally {
      active = undefined;
      if (!stopped) timer = setTimeout(tick, POLICY.outbox.pollIntervalMs);
    }
  }

  void tick();

  return {
    dispatchOnce,
    async close(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      await active;
    },
  };
}
