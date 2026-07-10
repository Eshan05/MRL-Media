import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyReply, FastifyRequest } from 'fastify';

export function retryAfterSeconds(resetAt: number): number {
  return Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
}

export function setRateLimitHeaders(
  reply: FastifyReply,
  limit: { limit: number; remaining: number; resetAt: number; policy: string },
): void {
  reply.header('ratelimit-limit', limit.limit);
  reply.header('ratelimit-remaining', Math.max(0, limit.remaining));
  reply.header('ratelimit-reset', retryAfterSeconds(limit.resetAt));
  reply.header('ratelimit-policy', limit.policy);
}

export function requestBody(req: FastifyRequest): BodyInit | undefined {
  if (req.method === 'GET' || req.method === 'HEAD' || req.body === undefined) return undefined;
  if (typeof req.body === 'string') return req.body;
  if (req.body instanceof Uint8Array) return Buffer.from(req.body).toString('utf8');
  return JSON.stringify(req.body);
}

export function authHeaders(req: FastifyRequest): Headers {
  const headers = fromNodeHeaders(req.headers);
  const bearer = bearerToken(req.headers.authorization);
  if (bearer && !headers.has('x-api-key')) headers.set('x-api-key', bearer);
  return headers;
}

export function hasAuthAttempt(req: FastifyRequest): boolean {
  return Boolean(req.headers.authorization || req.headers['x-api-key'] || req.headers.cookie);
}

export function clientAuthErrorStatus(err: unknown): number | null {
  const e = err as {
    status?: unknown;
    statusCode?: unknown;
    body?: { status?: unknown; statusCode?: unknown; message?: unknown };
    message?: unknown;
  };
  for (const value of [e.status, e.statusCode, e.body?.status, e.body?.statusCode]) {
    const status = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (Number.isFinite(status) && status >= 400 && status < 500) return status;
  }
  const message = String(e.body?.message ?? e.message ?? '');
  return /invalid api key|unauthorized|forbidden/i.test(message) ? 401 : null;
}

export function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function multipartField(fields: Record<string, unknown>, name: string): string | undefined {
  const raw = fields[name];
  const field = Array.isArray(raw) ? raw[0] : raw;
  const value = (field as { value?: unknown } | undefined)?.value;
  return typeof value === 'string' ? value : undefined;
}

function bearerToken(value: string | undefined): string | undefined {
  return value?.startsWith('Bearer ') ? value.slice(7) : undefined;
}
