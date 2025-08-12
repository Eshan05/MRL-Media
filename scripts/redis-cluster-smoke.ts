import {
  concurrency,
  createRedis,
  exactSlidingWindow,
  fixedWindow,
  gcra,
  slidingWindow,
  tokenBucket,
  violationTracker,
} from '../src/limiter/index.js';

process.env.REDIS_CLUSTER_NODES ??=
  '127.0.0.1:7000,127.0.0.1:7001,127.0.0.1:7002,127.0.0.1:7003,127.0.0.1:7004,127.0.0.1:7005';
process.env.REDIS_CLUSTER_NAT_MAP ??=
  'host.docker.internal:7000=127.0.0.1:7000,host.docker.internal:7001=127.0.0.1:7001,host.docker.internal:7002=127.0.0.1:7002,host.docker.internal:7003=127.0.0.1:7003,host.docker.internal:7004=127.0.0.1:7004,host.docker.internal:7005=127.0.0.1:7005';

const redis = createRedis();
const id = `smoke-${Date.now()}`;
const now = () => 1_000_000;
const checks: string[] = [];

function assert(ok: unknown, name: string): void {
  if (!ok) throw new Error(`cluster smoke failed: ${name}`);
  checks.push(name);
}

try {
  const fixed = fixedWindow(redis, { name: `cluster-fw-${id}`, limit: 1, windowMs: 60_000, now });
  assert((await fixed.check(id)).allowed, 'fixed-window allow');
  assert(!(await fixed.check(id)).allowed, 'fixed-window block');

  const weighted = slidingWindow(redis, { name: `cluster-sw-${id}`, limit: 1, windowMs: 60_000, now });
  assert((await weighted.check(id)).allowed, 'sliding-window allow');
  assert(!(await weighted.check(id)).allowed, 'sliding-window block');

  const exact = exactSlidingWindow(redis, { name: `cluster-exact-${id}`, limit: 1, windowMs: 60_000, now });
  assert((await exact.check(id)).allowed, 'exact-sliding allow');
  assert(!(await exact.check(id)).allowed, 'exact-sliding block');

  const bucket = tokenBucket(redis, { name: `cluster-tb-${id}`, capacity: 1, refillPerSec: 1, now });
  assert((await bucket.check(id)).allowed, 'token-bucket allow');
  assert(!(await bucket.check(id)).allowed, 'token-bucket block');
  assert((await bucket.peek(id)).remaining === 0, 'token-bucket peek');

  const slots = concurrency(redis, { name: `cluster-cc-${id}`, slots: 1, ttlMs: 1000, now });
  const acquired = await slots.acquire(id);
  assert(acquired.acquired && acquired.holderId, 'concurrency acquire');
  assert((await slots.acquire(id)).acquired === false, 'concurrency block');
  assert(acquired.holderId && (await slots.extend(id, acquired.holderId)), 'concurrency extend');
  assert(acquired.holderId && (await slots.release(id, acquired.holderId)), 'concurrency release');

  const paced = gcra(redis, { name: `cluster-gcra-${id}`, intervalMs: 1000, burst: 1, now });
  assert((await paced.check(id)).allowed, 'gcra allow');
  assert(!(await paced.check(id)).allowed, 'gcra block');

  const violations = violationTracker(redis, { name: `cluster-viol-${id}`, windowMs: 60_000 });
  await violations.record(id);
  assert((await violations.count(id)) === 1, 'violation tracker');

  console.log(`PASS redis cluster smoke: ${checks.join(', ')}`);
} finally {
  await redis.quit();
}
