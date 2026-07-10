import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

/**
 * The permanent version of "which layer caught what": every limiter gate
 * increments exactly one series per decision.
 */
export const limiterDecisions = new Counter({
  name: 'mrl_limiter_decisions_total',
  help: 'Rate limiter decisions by layer',
  labelNames: ['layer', 'decision'] as const,
  registers: [registry],
});

export const queueDepthGauge = new Gauge({
  name: 'mrl_transcode_queue_depth',
  help: 'Transcode jobs waiting (layer 6 backpressure signal)',
  registers: [registry],
});

export const workerHeartbeatAge = new Gauge({
  name: 'mrl_worker_heartbeat_age_seconds',
  help: 'Seconds since the worker last heartbeat (-1 = no heartbeat found)',
  registers: [registry],
});

export const outboxPendingGauge = new Gauge({
  name: 'mrl_job_outbox_pending',
  help: 'Durable processing events waiting to be dispatched to BullMQ',
  registers: [registry],
});

export function recordDecision(layer: string, allowed: boolean): void {
  limiterDecisions.inc({ layer, decision: allowed ? 'allow' : 'block' });
}
