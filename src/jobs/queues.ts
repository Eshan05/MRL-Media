import { Queue } from 'bullmq';
import { Cluster, Redis } from 'ioredis';
import type { TranscodeJobData, TranscodeResult, WebhookJobData } from './types.js';
import { parseClusterNatMap, parseClusterNodes } from '../limiter/redis.js';

export const TRANSCODE_QUEUE = 'transcode';
export const WEBHOOK_QUEUE = 'webhooks';

/**
 * BullMQ requires its own connections with maxRetriesPerRequest: null
 * (blocking commands must never give up). Do not share these with the
 * limiter's redis client, which wants the opposite behavior.
 */
export type QueueRedisConnection = Redis | Cluster;

export function createQueueConnection(url = process.env.REDIS_URL ?? 'redis://localhost:6379'): QueueRedisConnection {
  const clusterNodes = parseClusterNodes(process.env.REDIS_CLUSTER_NODES);
  if (clusterNodes.length > 0) {
    const natMap = parseClusterNatMap(process.env.REDIS_CLUSTER_NAT_MAP);
    return new Cluster(clusterNodes, {
      natMap,
      redisOptions: {
        maxRetriesPerRequest: null,
      },
    });
  }
  return new Redis(url, { maxRetriesPerRequest: null });
}

export function createTranscodeQueue(connection: QueueRedisConnection): Queue<TranscodeJobData, TranscodeResult> {
  return new Queue(TRANSCODE_QUEUE, { connection });
}

export function createWebhookQueue(connection: QueueRedisConnection): Queue<WebhookJobData> {
  return new Queue(WEBHOOK_QUEUE, { connection });
}
