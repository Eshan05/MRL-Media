# LEARNING.md — the six algorithms, in order

How to use this: one layer per sitting. For each layer — read the concept
here, then the Lua script (they're short), then **predict what each test in
the matching test file will do before running it**. Prediction is the part
that makes it stick. Finish with the exercise; each one changes behavior, so
you can't complete it by skimming.

Run a single suite while studying:

```bash
pnpm vitest run tests/sliding-window.test.ts
```

---

## Lua in 10 lines (all you need)

| TypeScript | Redis Lua |
|---|---|
| `const x = 5` | `local x = 5` |
| `Number(argv[0])` | `tonumber(ARGV[1])` — everything arrives as a string, **1-indexed** |
| `` `${a}:${b}` `` | `a .. ':' .. b` |
| `if (a > b) { }` | `if a > b then ... end` |
| `cond ? 1 : 0` | `cond and 1 or 0` |
| `await redis.get(k)` | `redis.call('GET', k)` |
| `return [a, b]` | `return { a, b }` |
| `!==` | `~=` |

Gotchas: only `nil` and `false` are falsy (`0` and `''` are truthy — hence
the `or '0'` fallback after GET); a missing GET returns `false`, not `nil`;
**floats returned from Lua get truncated to integers by Redis**, which is why
every script floors/ceils explicitly before returning.

Why Lua at all: the whole read-compute-write must be atomic. Two racing
requests with one slot left must not both pass. A script runs on the Redis
thread with nothing interleaved — that's the concurrency story, and it's
also why `check()` is one round-trip instead of three.

Why `now` is injected instead of using Redis `TIME`: identical in
production, but tests can jump 3 hours in one line (`tests/util.ts`). Watch
every test file exploit this — zero `sleep`s in the whole suite.

---

## Layer 1 — fixed window (`fixed-window.lua`)

**One counter per (id, time-bucket).** `window_id = floor(now / window)` is
the whole trick — the key namespace does the resetting, no cleanup needed
beyond a TTL.

**The flaw is a feature of its cheapness:** the last test in
`fixed-window.test.ts` proves 10 requests can land in ~2 s around a boundary
with a limit of 5. We keep it anyway for the per-IP surface: millions of
anonymous IPs, one `INCRBY` each, and coarse DDoS filtering doesn't care
about 2× on the boundary.

**Design decision to notice:** we only count *allowed* requests. The
alternative (count everything, check after) punishes clients that keep
hammering while blocked. Both are legitimate; know which you're running.

**Exercise:** add an option `countRejected: boolean` to
`fixedWindow()` and the script, and write one test showing the behavioral
difference between the two modes for a client that never stops sending.

---

## Layer 2 — sliding window (`sliding-window.lua`)

**Same two counters fixed window already had — the previous one just fades
instead of vanishing:**

```
estimate = prev × (1 − elapsed_fraction) + curr
allow if estimate + cost ≤ limit
```

Worked example (do it by hand, then find it as the `sw4` test): 60 s window,
prev = 12, curr = 4, 18 s elapsed → weight 0.7 → estimate = 12 × 0.7 + 4 =
12.4. Limit 10, cost 1 → blocked, even though the current window only holds
4. That's the smoothing.

**It's an approximation:** it assumes prev's requests were evenly spread.
Skewed traffic makes the estimate wrong in either direction, bounded by
prev's count. The exact alternative (a ZSET holding every request timestamp)
costs memory per request instead of two integers per user — that trade is
the entire reason this variant exists.

**Don't assume `prev ≤ limit`:** adaptive multipliers (layer 6) change the
limit per user per moment, so history can legitimately exceed today's limit.
The formula never needs the assumption.

**Predict before running:** `sw2` is the same scenario as fixed window's
boundary-burst test — same setup, opposite outcome.

**Exercise:** implement the exact ZSET-log variant (`ZADD` timestamp per
request, `ZREMRANGEBYSCORE` to trim, `ZCARD` to count) and add a test showing
where the approximation and the exact version disagree.

---

## Layer 3 — token bucket (`token-bucket.lua`)

**State is `{tokens, ts}` and nothing ever ticks.** Each call refills lazily:

```
tokens = min(capacity, tokens + elapsed_seconds × rate)
```

`capacity` is the burst (album dump), `rate` is the sustained average.
That's the shape uploads have, which is why this layer guards `/upload`.

**Things to notice in the script:** fresh ids start with a *full* bucket
(first impression matters — and it means an attacker cycling ids gets
`capacity` free hits per id, which is exactly what layers 1–2 above it are
for); the idle-cap test (`tb3`) proves an hour of silence doesn't bank an
hour of tokens; `resetAt` is computed from the deficit — the client is told
precisely when to come back, which is what good `Retry-After` headers are
made of.

**Exercise:** add `peek(id)` — read the current token count *without*
spending. Harder than it looks: peek must still do the lazy refill math to
be truthful, but must not write. Decide whether it updates `ts` and defend
the choice with a test.

---

## Layer 4 — concurrency semaphore (`concurrency-acquire.lua` / `-release.lua`)

**Different question than every other layer:** not "how often" but "how many
at once." A transcode holds CPU and RAM for minutes; 100 requests per hour
is fine, 100 *simultaneous* ffmpeg processes is an outage.

**The data structure is the lesson:** a ZSET of `holder_id → deadline`.
Acquire sweeps expired deadlines, counts, adds. Release removes. The
deadline answers the question every semaphore must answer: **what happens
when a holder crashes without releasing?** Here: nothing, for at most
`ttlMs` — then the slot self-heals (`cc3` test). Without the TTL a crashed
worker leaks a slot forever.

**In the wrapper**, `run()` is the only API the worker should touch —
acquire/try/finally-release in one place. `release()` returning `false`
means the job outlived its TTL: log it loudly, it means `ttlMs` is tuned too
low or a job hung.

**Tier connection:** `slots` comes from the user's plan (free = 1, pro = 4),
scaled by layer 6.

**Exercise:** long jobs need a heartbeat — add
`extend(id, holderId, ttlMs)` (a `ZADD XX` that refreshes the deadline only
if the holder still exists) and a test where a slow job survives past the
original TTL because it kept extending.

---

## Layer 5 — GCRA (`gcra.lua`)

**Every previous layer answers "how many." GCRA answers "how far apart."**
A webhook receiver allowed 30/min under a window algorithm can still get all
30 in one second. GCRA with a 2 s interval guarantees ≥2 s gaps. For egress
pacing — being a polite sender — spacing is the actual requirement.

**The entire state is one number**, TAT (theoretical arrival time — when the
next perfectly-paced request "should" arrive):

```
tat = max(stored_tat, now)
allow if tat − now ≤ tau          # tau = burst tolerance
on allow: store tat + interval
```

Blocked callers get `retryAt = tat − tau` — not "try later," but the exact
millisecond it will succeed. The worker schedules the redelivery for
precisely then, no guessing, no exponential backoff needed for the pacing
case.

**The unification worth internalizing:** set `tau = (burst−1) × interval`
and GCRA *is* a token bucket, expressed in time instead of tokens — with one
stored number instead of a hash, and no floating-point drift. Test `g3`
shows idle time capping at the burst exactly like a full bucket. This is why
GCRA has no "remaining" in its result type: a spacing limiter has nothing to
count.

**Exercise:** prove the equivalence — write a property-style test that runs
the same request sequence through `tokenBucket(capacity=B, refillPerSec=R)`
and `gcra(intervalMs=1000/R, burst=B)` and asserts allow/block decisions
match. Then find the one input class where they diverge (hint: fractional
costs interact with `math.floor` differently).

---

## Layer 6 — adaptive (`adaptive.ts` — deliberately not Lua)

**Not a seventh limiter — a policy multiplier over layers 2–4.** Mechanism
(the five algorithms, pure, dumb, atomic) stays in Lua; policy (who deserves
how much of it) lives in TypeScript where it can read the database, the
queue, anything. This separation is the most transferable architecture
lesson in the repo.

```
new account → 0.5×      veteran → 1.5×
each recent violation divides headroom
queue deeper than soft limit → everyone scales down proportionally
clamped to [0.1, 2]
```

`violationTracker` is the memory: any layer that blocks calls `record(id)`;
the multiplier reads `count(id)`. Rolling expiry means persistent offenders
stay remembered, one-off spikes are forgiven.

**Exercises:** (1) wire it — in `server.ts`, call `vt.record()` on every
429, and compute `scaledLimit(base, trustMultiplier(signals))` per request
for layers 2–3. (2) The multiplier is recomputed per request and the queue
depth read is a BullMQ call — add a 10 s cache and reason about what
staleness costs you here (answer: almost nothing, which is why it's safe).
(3) Harder: adaptive on 429s creates a feedback loop (block → violation →
lower limit → more blocks). Is the clamp floor of 0.1 enough to keep a
legitimate-but-bursty user from spiraling? Design the escape hatch.

---

## Wiring it into MRL-Media (the remaining build)

Ordered so each step is independently shippable:

1. ~~**Auth stub**~~ — done as the `x-user-id` header in `server.ts`. Still
   open: a real users table (created_at gives you `accountAgeDays`, tier
   gives you `slots`) instead of the stubbed signals.
2. ~~**Layers 2, 3, 6 in `server.ts`**~~ — done: sliding window per user,
   token bucket on `POST /upload`, both scaled by `trustMultiplier`,
   `violationTracker.record()` on every 429, real `Retry-After` headers.
   Study it live: `pnpm dev:api`, open `/`, hit "Spam ×12" and read the log
   bottom-up — bucket drains (5×200), token bucket fires (429s), each 429
   drops trust, and then **the sliding window starts blocking because the
   shrunken trust multiplier lowered its scaled limit below what was already
   spent**. That's the layer-6 feedback loop from the exercise, visible in
   one click.
3. ~~**Real uploads**~~ — done: streaming multipart to `uploads/`. Still
   open: job row in SQLite + `queue.add()` to BullMQ.
4. ~~**Worker + layer 4**~~ — done: `src/worker/index.ts`. Tier slots
   (free 3 / pro 10) via the semaphore; when no slot is free the job is
   parked with `moveToDelayed` instead of burning a worker — the BullMQ
   manual-limit pattern. Note the same primitive also guards *uploads in
   flight* in `server.ts` (free 2 / pro 5) — one semaphore, two different
   scarce resources (sockets+disk there, CPU+RAM here).
5. ~~**Webhooks + layer 5**~~ — done: the webhook worker checks
   `gcra.check(host)` and, when blocked, delays the job to GCRA's exact
   `retryAt` — no guessing, no generic backoff for the pacing case (HTTP
   failures still retry with exponential backoff, a different concern).
   Proof: `node scripts/e2e-worker.mjs` measures delivery gaps; expect
   ~`[0, 2000, 2000]` ms for 4 simultaneous deliveries at burst 2.
6. ~~**The victory lap**~~ — done: `scripts/load-test.mjs` simulates ~100
   users in four personas (polite / aggressive / parallel-burst / botnet
   behind one IP) and asserts the invariants: polite users never limited,
   every layer fires for its intended abuser, no 5xx, trust decays.
   Run it against an instance started with `TRUST_PROXY=1` so each
   simulated user gets its own IP via `x-forwarded-for`:

   ```bash
   TRUST_PROXY=1 PORT=3210 pnpm exec tsx src/api/server.ts &
   node scripts/load-test.mjs http://127.0.0.1:3210
   ```

   Reference run: 714 requests / 11 s — polite 340/340 clean; aggressive
   users each got exactly 5×201 → 5×token-bucket → 5×sliding-window (trust
   decay shrinking the scaled limit mid-run); botnet exactly 100/200
   through the IP wall; burst users caught by in-flight slots; final
   aggressive trust 0.18; p95 latency 13 ms.

   Slow edge proofs live in `scripts/matrix-slow.mjs`: layer 2 firing at
   full trust while the upload bucket would still admit the paced request,
   and layer 5's webhook retry path against a receiver that fails twice
   then accepts.

## Proof boundaries — what is and is not demonstrated

Proven on this machine (scripts in `scripts/`):

- **Attribution** (`layer-matrix.mjs`): each behavior is caught by exactly
  the intended layer; tier and per-user isolation hold; the three-phase
  cascade (bucket → violations → trust decay → sliding window) is exact.
- **Slow attribution** (`matrix-slow.mjs`): layer 2 also fires without
  trust decay. The upload bucket can admit `5 + 30 = 35` attempts in 60 s,
  while the user sliding window caps at 30/min, so paced traffic hits
  `sliding-window-user` at `x-rl-trust: 1.000`. The same script proves
  webhook retry delivery by using a receiver that returns 500 twice and
  then 200.
- **Distributed correctness** (`distributed.mjs`): with 3 API instances on
  one redis, the bucket, semaphore, and IP window are *global* — 5 tokens
  total, 2 in-flight total, exactly 100/110 through the IP wall. This is
  the property that justifies redis + Lua over in-process counters.
- **Backpressure** (layer 6): with the worker stopped and ~120 jobs queued,
  a fresh innocent user's trust reads 0.833 = softLimit/depth. Everyone
  slows down when the system is drowning.
- **Worker slot parking** (layer 4b): with `TRANSCODE_SLOTS_FREE=1`, three
  simultaneous transcodes complete ~2000 ms apart — the `moveToDelayed`
  retry interval, observable in `finishedOn`.
- **Volume smoke** (`soak.mjs`): closed-loop concurrent users through the
  upload/health mix. It checks for 5xx, network errors, and p95 drift, but
  it must not be read as an RPS capacity number because slower responses
  slow the client loop too.
- **Local scale smoke** (`local-scale.mjs`): fixed-arrival scheduling with
  latency measured from planned send time to response end. This is the
  better local regression shape for throughput/latency because it avoids
  hiding server stalls behind client pacing. It is still one client process,
  loopback, one redis, and one laptop.
- **Artillery local profile** (`pnpm scale:artillery`): same intent in a
  standard tool. The test uses constant-arrival/ramp phases, rotates
  `x-forwarded-for` to avoid measuring only layer 1, and sends a small
  multipart upload sample through `/upload`.
- **Compose replica smoke** (`pnpm scale:compose`): boots redis, one worker,
  nginx, and a configurable number of API replicas. The script writes an
  explicit nginx upstream for the requested replica count, confirms nginx
  reaches every API container via `x-api-instance`, then runs the
  fixed-arrival scale check through the load balancer. This proves local
  replica wiring and shared-Redis correctness pressure, not production
  capacity. On this Docker Desktop machine, `12 replicas × 50/s` passes
  cleanly; `12 replicas × 200/s` reaches all replicas but overloads the
  local Docker/client path with drops and network errors, so that number is
  a laptop limit, not an application claim.

Also proven since first writing this list:

- **Cross-node cascade** (`distributed.mjs` D5): the three-phase pattern
  (bucket → violations → trust decay → sliding window) holds exactly when
  the 15 requests round-robin across 3 API instances — sliding counters
  AND the violation tracker are shared state.
- **Trust recovery**: violations expire and trust returns — unit-tested
  with a short tracker window (the one test in the suite that sleeps,
  because expiry runs on the redis server clock).
- **Local capacity knee** (`local-scale.mjs` at fixed arrival rates):
  one instance on this laptop is comfortable at ~1200 req/s open-loop
  through the full limiter stack (p95 ≈ 11 ms) and hits queueing at
  ~2400 req/s (p95 hundreds of ms, zero errors — it degrades by queueing,
  not by failing). Client and server share the machine, so read this as a
  floor, not a ceiling.
- **Worker liveness is observable**: connection lifecycle logging,
  fail-fast startup (redis unreachable → loud exit 1 within 10 s), a
  heartbeat key, and `/health` reporting `queueDepth` + worker liveness —
  added after a silently-wedged worker survived undetected for hours.
- **Tier 3.1 mechanics** (`pnpm test`): rejected fixed-window attempts can
  be counted when policy wants that, token-bucket `peek()` reads without
  mutating state, semaphore `extend()` keeps long holders alive, and the
  exact ZSET sliding window has a test showing where it disagrees with the
  weighted approximation.
- **Video processing path** (`pnpm e2e:video`): local ffmpeg generates a
  test mp4, the API accepts it, the worker emits a poster webp plus web mp4,
  and `GET /jobs/:id` reports both outputs.
- **Redis Cluster path** (`pnpm redis:cluster` + `pnpm redis:cluster:smoke`):
  a local 3-master/3-replica cluster covers all 16384 slots, and every
  limiter family succeeds through ioredis Cluster. Local Docker Desktop
  needs `REDIS_CLUSTER_NAT_MAP` because the cluster advertises
  `host.docker.internal` while host clients reach published ports on
  `127.0.0.1`.
- **Chaos check** (`pnpm chaos`): on an isolated Redis DB, worker heartbeat
  comes alive, a killed worker becomes visible in `/health`, a restarted
  worker restores liveness, uploads work after restart, Redis pause does not
  return a false 200, and unpause recovers health.

NOT proven here, and honestly can't be on one laptop:

- True capacity (loopback network, single client process sharing the CPU
  with the server, single redis — no network jitter, no redis failover,
  no multi-machine clock skew).
- Multi-day behavior: key churn over days, redis persistence/restart
  semantics under real traffic.
- Real Redis failover behavior under load. The local cluster smoke proves
  hash-slot correctness and client topology/NAT config, not failover SLOs.

## Further reading

- [smudge.ai: rate limit algorithms](https://smudge.ai/blog/ratelimit-algorithms) — where this started
- [brandur.org: GCRA](https://brandur.org/rate-limiting) — the TAT derivation, Stripe context
- [Cloudflare: sliding window approximation](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/) — the production story, with error-rate measurements
- [Stripe: scaling rate limiters](https://stripe.com/blog/rate-limiters) — where concurrency limits and load shedders sit in a real API
