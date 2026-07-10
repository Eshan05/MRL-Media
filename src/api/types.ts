import type { Queue } from 'bullmq';
import type { RedisClient, ViolationTracker } from '../limiter/index.js';
import type { TranscodeJobData, TranscodeResult } from '../jobs/types.js';
import type { UserRow } from '../db.js';

export type UploadActor =
  | {
      kind: 'user';
      key: string;
      userId: string;
      tier: 'free' | 'pro';
      trust: number;
    }
  | {
      kind: 'anonymous';
      key: string;
      userId: null;
      tier: 'anonymous';
      trust: number;
    };

export interface ApiContext {
  redis: RedisClient;
  transcodeQueue: Queue<TranscodeJobData, TranscodeResult>;
  violations: ViolationTracker;
  apiInstance: string;
  queueDepth(): Promise<number>;
}

export interface ApiPluginOptions {
  context: ApiContext;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserRow;
    uploadActor?: UploadActor;
    trust?: number;
  }
}
