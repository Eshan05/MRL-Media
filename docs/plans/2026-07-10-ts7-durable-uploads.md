# TypeScript 7, Durable Uploads, and API Restructure

## Status

Implemented and verified, 2026-07-10. This document records the design
decisions and the resulting verification baseline.

The implementation landed in `d0becd2` and the Render worker default in
`c8b6ae3`. GitHub CI passed all checks. Render deployed `c8b6ae3`, reported a
live worker heartbeat with an empty outbox, and completed an authenticated
`POST /api/v1/uploads` smoke job from `pending` to `completed`.

## Goals

- Upgrade the core project to TypeScript 7.0.2.
- Make accepted uploads recoverable through PostgreSQL-backed lifecycle state
  and a transactional outbox.
- Replace the monolithic API server with cohesive Fastify route plugins and a
  small composition root.
- Introduce a versioned asynchronous upload/job API without breaking the
  existing routes.
- Repair CI, Compose, documentation, and the live Render demonstration.

## API And Server Shape

- `src/api/server.ts` becomes a small startup/composition entrypoint.
- A side-effect-free app factory registers multipart support, global request
  policy, error handling, and focused plugins for accounts/auth, uploads/jobs,
  files/media, and operations/playground.
- Plugins receive typed concrete dependencies. Formal repositories and a DI
  framework are intentionally deferred.
- `POST /api/v1/uploads` keeps current upload inputs and returns `202 Accepted`
  after the object and outbox transaction are durable. Its response adds
  `state: "pending"` and a versioned job URL for authenticated users.
- `GET /api/v1/jobs/:id` reads persisted processing state and outputs.
- Legacy `POST /upload` and `GET /jobs/:id` remain adapters over the same
  workflow; the legacy upload continues returning `201`.

## Durable Upload Lifecycle

Files move through:

```text
staging -> pending -> queued -> processing -> completed
                                      \----> failed
```

- Existing rows are treated as `completed`; new rows explicitly begin as
  `staging`.
- After the request body reaches a temporary file, the API inserts a staging
  row, stores the object, then transactionally updates the row to `pending`
  and inserts one `transcode` outbox event.
- Storage or transaction failures trigger compensating object/row deletion.
- Staging rows older than 15 minutes are swept so a process crash cannot leave
  permanent partial uploads.
- Persist outputs, final errors, and processing timestamps with the file row.

The worker owns outbox dispatch:

- Poll every second and claim up to 25 available events using PostgreSQL
  `FOR UPDATE SKIP LOCKED` with a 30-second recoverable lease.
- Enqueue BullMQ jobs with `jobId = fileId`, then mark the event dispatched and
  conditionally advance `pending` files to `queued`.
- Retry dispatch indefinitely with exponential backoff from 1 to 60 seconds.
- Mark files `processing`, `completed`, or terminally `failed` from worker
  execution and persist outputs/errors independently of BullMQ job retention.
- Use a deterministic webhook job ID per processed file to prevent duplicate
  delivery across crash retries.

## Schema And Operations

- Continue using the existing `db:push` deployment path for compatibility with
  the current Render database.
- Remove misleading SQLite migration artifacts and document formal PostgreSQL
  migrations as future hardening.
- Add PostgreSQL 18 plus schema setup to CI.
- Repair scale Compose with PostgreSQL, a schema-init service, shared database
  configuration, `ADMIN_KEY`, and `RUN_WORKER=0` for API replicas.
- Co-locate API and worker on the existing free Render web service with
  `WORKER_MODE=co-located`; do not create paid infrastructure.
- `/health` remains informational when a worker is absent, but exposes worker
  and pending-outbox state for explicit verification.

## Documentation And Verification

- Correct the README, `TASK.md`, learning material, deployment guide, recipes,
  environment examples, algorithm terminology, and broken screenshots.
- Describe the design as five limiter mechanisms across six policy layers,
  plus the exact sliding-window variant.
- Move the playground to `/api/v1` and teach it the pending/completed flow.
- Run TypeScript checking, Vitest, distributed/matrix/e2e proofs, Docker build,
  and repaired Compose scale smoke.
- Commit and push focused changes to `main`, verify the co-located worker and
  durable upload flow on Render, then capture and commit current screenshots.

## Explicit Deferrals

- Same-origin active-content/MIME hardening.
- Changes to the adaptive-trust feedback loop.
- Formal domain/repository layers.
- Paid Render services and formal PostgreSQL migrations.
