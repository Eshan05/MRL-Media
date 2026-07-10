# MRL-Media Roadmap

This is the current project roadmap. Historical implementation notes and
machine-specific commands belong in Git history, not in this file.

## Current Capabilities

- Five Redis-backed limiter mechanisms across six policy layers: fixed window,
  weighted sliding window, token bucket, concurrency semaphore, GCRA pacing,
  and adaptive policy. An exact sliding-window log is also available.
- Anonymous and authenticated media uploads with public/private links and
  owner-only file management.
- PostgreSQL-backed auth, file metadata, object fallback storage, and durable
  processing state.
- BullMQ workers for image/video derivatives and paced webhook delivery.
- SSRF protection, Prometheus metrics, worker heartbeat, Redis Cluster-safe
  scripts, and distributed/chaos/load proof tooling.

## Active Work

- [x] Complete the TypeScript 7 and durable-upload implementation recorded in
      `docs/plans/2026-07-10-ts7-durable-uploads.md`.
- [ ] Verify the versioned upload/job contract locally and on Render.
- [x] Capture current desktop and mobile product screenshots.

## Next Hardening

- [ ] Move untrusted media to a separate origin or force active content to
      download with strict MIME handling.
- [ ] Replace `db:push` with reviewed PostgreSQL migrations.
- [ ] Add an escape hatch to the adaptive violation feedback loop.
- [ ] Split API and worker deployments when a paid/background-worker plan is
      justified.
- [ ] Add multi-day persistence and real Redis failover exercises.
