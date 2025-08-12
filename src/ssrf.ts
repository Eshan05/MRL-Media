import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

/**
 * SSRF guard for user-supplied webhook URLs. A webhook destination that
 * resolves to private address space would let a customer aim OUR server
 * at OUR internal network (redis, cloud metadata endpoints, ...).
 *
 * Checked twice: syntactically at upload time (fast feedback) and against
 * the RESOLVED addresses in the worker right before delivery — DNS is
 * attacker-controlled, so validating only the hostname is theater.
 */

const BLOCKED_V4_CIDRS = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local + cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // documentation/test networks
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmark networks
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved/future use
] as const;

export class SsrfError extends Error {
  override name = 'SsrfError';
}

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const n = ipv4ToInt(ip);
    return n === undefined || BLOCKED_V4_CIDRS.some(([base, bits]) => inCidr(n, ipv4ToInt(base)!, bits));
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true; // unspecified / loopback
    if (lower.startsWith('ff')) return true; // multicast
    if (lower.startsWith('100:')) return true; // discard prefix
    if (lower.startsWith('2001:db8:') || lower === '2001:db8::') return true; // documentation
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique local
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return true; // fe80::/10 link-local
    }
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7)); // v4-mapped
    return false;
  }
  return false; // not an IP literal
}

/** Fast syntactic screen for upload-time validation. */
export function looksPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }
  return isIP(h) !== 0 && isPrivateAddress(h);
}

/** Resolve the host and reject if ANY address is private. */
export async function assertPublicDestination(url: string): Promise<void> {
  await resolveDestination(url, false);
}

export interface WebhookResponse {
  status: number;
}

export async function postJsonToWebhook(
  url: string,
  payload: unknown,
  options: { allowPrivate?: boolean; timeoutMs?: number; userAgent?: string } = {},
): Promise<WebhookResponse> {
  const parsed = new URL(url);
  const resolved = await resolveDestination(parsed, options.allowPrivate === true);
  const body = JSON.stringify(payload);
  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? https : http;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: resolved.address,
        family: resolved.family,
        port: parsed.port || (isHttps ? 443 : 80),
        method: 'POST',
        path: `${parsed.pathname}${parsed.search}`,
        servername: isHttps ? parsed.hostname : undefined,
        timeout: timeoutMs,
        headers: {
          host: parsed.host,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': options.userAgent ?? 'mrl-media-webhook/0.1',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`webhook timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

async function resolveDestination(input: string | URL, allowPrivate: boolean) {
  const url = typeof input === 'string' ? new URL(input) : input;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('webhook destination must be a http(s) URL');
  }
  const { hostname } = url;
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && looksPrivateHost(bare)) {
    throw new SsrfError(`webhook destination ${bare} is private address space`);
  }
  const literalFamily = isIP(bare);
  if (literalFamily !== 0) {
    return { address: bare, family: literalFamily as 4 | 6 };
  }

  const addrs = await lookup(bare, { all: true });
  if (addrs.length === 0) {
    throw new Error(`webhook destination ${bare} did not resolve`);
  }
  const publicAddrs = [];
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) {
      if (!allowPrivate) {
        throw new SsrfError(`webhook destination ${bare} resolves to private address ${address}`);
      }
    } else {
      publicAddrs.push(address);
    }
  }
  const address = allowPrivate ? addrs[0]!.address : publicAddrs[0];
  if (!address) {
    throw new SsrfError(`webhook destination ${bare} has no public addresses`);
  }
  return { address, family: isIP(address) as 4 | 6 };
}

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let out = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    const n = Number(part);
    if (n < 0 || n > 255) return undefined;
    out = (out << 8) + n;
  }
  return out >>> 0;
}

function inCidr(ip: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (base & mask);
}
