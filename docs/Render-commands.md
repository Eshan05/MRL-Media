# Render Deployment

The public demo runs on one free Render web service. The service starts both
the Fastify API and the BullMQ worker through `scripts/render-start.mjs`; this
keeps the demonstration functional without a paid background-worker plan.

## Resources

- One Docker web service built from this repository.
- One Render Key Value instance used by Redis limiters and BullMQ.
- One Render PostgreSQL database used by Better Auth, file metadata, the job
  outbox, and the small-demo object-storage fallback.

No credentials or workspace-specific resource IDs belong in this document.

## Required Environment

```env
REDIS_URL=<render-internal-key-value-url>
DATABASE_URL=<render-internal-postgres-url>
STORAGE_DRIVER=database
TRUST_PROXY=1
RUN_WORKER=1
WEBHOOK_ALLOW_PRIVATE=0
BETTER_AUTH_SECRET=<at-least-32-random-bytes>
MEDIA_CODE_SECRET=<independent-random-secret>
ANON_KEY_SALT=<independent-random-secret>
ADMIN_KEY=<optional-operations-key>
```

S3 or R2 should replace database object storage for a persistent production
deployment. Configure the `S3_*` variables documented in the README.

## Startup

The Docker image runs:

```bash
node scripts/render-start.mjs
```

Startup applies the current Drizzle schema with `db:push`, then starts the API
and, when `RUN_WORKER` is not `0`, the worker. Formal migrations are deferred
and should replace schema push before treating this as a production service.

## Verification

After every deploy:

1. Open `/health` and require `ok: true`, `worker.alive: true`, and an outbox
   pending count that returns to zero.
2. Create a normal user through `/signup`.
3. Upload an image through `POST /api/v1/uploads` and require `202` with
   `state: pending`.
4. Poll the returned status URL until `state: completed` and verify both image
   derivatives can be read by the owner.
5. Open the playground on desktop and mobile and confirm signup, upload, file
   listing, state display, and limiter rows do not overlap.

`/health` intentionally remains informational if the worker is absent; Render
will not restart the service solely because `worker.alive` is false.

## Free-Tier Limits

Free services can cold-start slowly and free databases can expire. Those are
demo-hosting constraints, not application availability guarantees. Do not add
paid infrastructure without explicit approval.
