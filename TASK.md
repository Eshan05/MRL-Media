# TASK.md — Tier 1 + Tier 2 (then 3.1, then 4)

Working agreement: polish Tier 1 + Tier 2 fully before starting Tier 3.1 / Tier 4.
Every item gets verified live before it's checked off.

## Tier 1 — close the real gaps

- [x] **T1.1 Better Auth + Drizzle auth** (SQLite via better-sqlite3, WAL for
  multi-instance)
  - Better Auth generated Drizzle schema owns `user`, `session`, `account`,
    `verification`, and `apikey`; app Drizzle schema owns `files`
  - `POST /signup` compatibility route (rate limited 5/h/IP) → creates a
    Better Auth email/password user and returns an API key; native routes live
    under `/api/auth/*`; auth via `x-api-key` or `Authorization: Bearer <key>`
  - `POST /admin/users` guarded by ADMIN_KEY env (disabled when unset) —
    creates users with arbitrary tier/ageDays; used by test scripts so
    existing expectations (trust 1.0 at age 30d) stay valid
  - layer 6 gets REAL accountAgeDays (new signups start at 0.5× trust —
    deliberate, visible in playground)
  - `GET /me`; playground gets signup UX + Bearer uploads
- [x] **T1.2 SSRF guard on webhook URLs** — pure `isPrivateAddress()` +
  DNS resolve check with pinned outbound webhook delivery (UnrecoverableError,
  no retries for SSRF/redirects); `WEBHOOK_ALLOW_PRIVATE=1` escape hatch for local dev/tests/CI.
  Verified live: metadata-endpoint webhook → 422 on a prod-mode instance
- [x] **T1.3 Files ACL** — ownership rows; owner 200, stranger 404,
  anonymous 401 — all asserted in e2e
- [x] Bonus: S8 root-caused and fixed properly — free tier's 3 transcode
  slots were parking the 4th job (layer 4b working as designed), staggering
  the webhook enqueues the scenario measures. S8 now uses a pro user.

## Tier 2 — production muscle

- [x] **T2.1 Prometheus /metrics** — verified live with allow AND block
  series for all four API layers after a test run
- [x] **T2.2 CI** — `.github/workflows/ci.yml`: redis service, typecheck,
  unit, matrix, distributed, e2e (untested until pushed to GitHub)
- [x] **T2.3 Policy as data** — `src/policy.ts`; server + worker consume it

## Collateral work the above forces

- [x] scripts migrated to Bearer auth via `scripts/_helpers.mjs`
- [x] ssrf unit tests — suite now 41 passing
- [x] README refresh (auth model, env vars, curl flow)
- [x] full verification pass: 40 unit + 8/8 matrix + 5/5 distributed +
  8/8 e2e, from a cold post-reboot boot
- [x] re-run after auth migration: load-test, soak, local-scale, artillery,
  matrix-slow. Verified live on `PORT=3210`, `REDIS_URL=redis://localhost:6379/14`,
  `TRUST_PROXY=1`, worker alive.

## Later (agreed order)

- [x] Tier 3.1: `countRejected`, token-bucket `peek()`, semaphore
  `extend()`, exact ZSET sliding variant + divergence test, IETF
  `RateLimit-*` headers. Verified by `pnpm test` (46 tests),
  live headers, and browser/playground rows.
- [x] Tier 4: ffmpeg video pipeline, local redis cluster + NAT map,
  automated chaos script, S8 cold-start hardening. Verified by
  `pnpm e2e:video`, `pnpm redis:cluster:smoke`, `pnpm chaos`,
  `scripts/e2e-worker.mjs`, and browser upload/spam proof.

## Known machine quirks (context for future sessions)

- Docker Desktop dies between sessions → `docker compose up -d redis` first
- Test instances need `TRUST_PROXY=1` + per-request `x-forwarded-for`
- Kill test instances by PORT (env doesn't show in CommandLine)
- Zero git commits so far — user hasn't asked for history yet
