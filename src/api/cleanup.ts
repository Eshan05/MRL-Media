import { expiredFiles, staleStagingFiles } from '../db.js';
import { POLICY } from '../policy.js';
import { purgeFile } from './media.js';

type CleanupLogger = Pick<Console, 'warn'>;

export interface CleanupScheduler {
  close(): Promise<void>;
}

export function startCleanupScheduler(logger: CleanupLogger): CleanupScheduler {
  let running = false;
  let closed = false;
  const timers: NodeJS.Timeout[] = [];

  async function sweep(): Promise<void> {
    if (running || closed) return;
    running = true;
    try {
      const [expired, staged] = await Promise.all([
        expiredFiles(),
        staleStagingFiles(Date.now() - POLICY.stagingTtlMs),
      ]);
      for (const file of [...expired, ...staged]) await purgeFile(file);
    } catch (err) {
      logger.warn(err as Error);
    } finally {
      running = false;
    }
  }

  void sweep();
  timers.push(setInterval(() => void sweep(), 60_000));
  for (const timer of timers) timer.unref();

  return {
    async close(): Promise<void> {
      closed = true;
      for (const timer of timers) clearInterval(timer);
      while (running) await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}
