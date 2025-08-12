import { Cluster, Redis, type NatMap } from 'ioredis';

export type RedisClient = Redis | Cluster;

export function createRedis(url = process.env.REDIS_URL ?? 'redis://localhost:6379'): RedisClient {
  const clusterNodes = parseClusterNodes(process.env.REDIS_CLUSTER_NODES);
  if (clusterNodes.length > 0) {
    const natMap = parseClusterNatMap(process.env.REDIS_CLUSTER_NAT_MAP);
    return new Cluster(clusterNodes, {
      natMap,
      redisOptions: {
        maxRetriesPerRequest: 2,
      },
    });
  }
  return new Redis(url, { maxRetriesPerRequest: 2 });
}

export function parseClusterNodes(value: string | undefined): Array<{ host: string; port: number }> {
  if (!value) return [];
  return value
    .split(',')
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((node) => parseHostPort(node, 'REDIS_CLUSTER_NODES'));
}

export function parseClusterNatMap(value: string | undefined): NatMap | undefined {
  if (!value) return undefined;
  const entries = value
    .split(',')
    .map((raw) => raw.trim())
    .filter(Boolean);
  if (entries.length === 0) return undefined;

  const map: Record<string, { host: string; port: number }> = {};
  for (const entry of entries) {
    const [from, to, extra] = entry.split('=');
    if (!from || !to || extra !== undefined) {
      throw new Error(`invalid REDIS_CLUSTER_NAT_MAP entry: ${entry}`);
    }
    const target = parseHostPort(to, 'REDIS_CLUSTER_NAT_MAP');
    map[from] = target;
  }
  return map;
}

function parseHostPort(value: string, envName: string): { host: string; port: number } {
  const [host, portText, extra] = value.split(':');
  const port = Number(portText);
  if (!host || !Number.isInteger(port) || port <= 0 || extra !== undefined) {
    throw new Error(`invalid ${envName} entry: ${value}`);
  }
  return { host, port };
}
