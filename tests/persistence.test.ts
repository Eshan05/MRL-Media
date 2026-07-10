import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimOutboxBatch,
  completeFileProcessing,
  createStagingFile,
  deleteFileRowById,
  failFileProcessing,
  fileById,
  finalizeStagedFile,
  markFileProcessing,
  markFileQueued,
  markOutboxDispatched,
  pendingOutboxCount,
  staleStagingFiles,
} from '../src/db.js';
import type { TranscodeJobData } from '../src/jobs/types.js';

const createdIds: string[] = [];

function fixture() {
  const id = randomUUID();
  const storedAs = `${id}.txt`;
  createdIds.push(id);
  const job: TranscodeJobData = {
    fileId: id,
    storedAs,
    ownerId: null,
    userId: `test:${id}`,
    tier: 'anonymous',
    originalName: 'test.txt',
    bytes: 12,
  };
  return { id, storedAs, job };
}

async function stage(id: string, storedAs: string): Promise<void> {
  await createStagingFile({
    id,
    user_id: null,
    stored_as: storedAs,
    original_name: 'test.txt',
    visibility: 'public',
    access_code_hash: null,
    webhook_url: null,
    expires_at: null,
  });
}

afterEach(async () => {
  await Promise.all(createdIds.splice(0).map((id) => deleteFileRowById(id)));
});

describe('durable upload persistence', () => {
  it('commits the file transition and outbox event together', async () => {
    const { id, storedAs, job } = fixture();
    await stage(id, storedAs);
    expect((await fileById(id))?.processing_status).toBe('staging');

    await finalizeStagedFile({ id, bytes: 12, job });
    const pending = await fileById(id);
    expect(pending?.processing_status).toBe('pending');
    expect(pending?.bytes).toBe(12);

    const claimed = await claimOutboxBatch({ now: Date.now(), leaseMs: 30_000, limit: 1_000 });
    const event = claimed.find((row) => row.file_id === id);
    expect(event?.file_id).toBe(id);
    expect(event?.attempts).toBe(1);

    await markOutboxDispatched(event!.id);
    await markFileQueued(id);
    expect((await fileById(id))?.processing_status).toBe('queued');
  });

  it('reclaims an outbox event after its dispatch lease expires', async () => {
    const { id, storedAs, job } = fixture();
    await stage(id, storedAs);
    await finalizeStagedFile({ id, bytes: 12, job });

    const now = Date.now();
    const first = await claimOutboxBatch({ now, leaseMs: 30_000, limit: 1_000 });
    expect(first.find((row) => row.file_id === id)?.attempts).toBe(1);
    const early = await claimOutboxBatch({ now: now + 1_000, leaseMs: 30_000, limit: 1_000 });
    expect(early.some((row) => row.file_id === id)).toBe(false);

    const reclaimed = await claimOutboxBatch({ now: now + 30_001, leaseMs: 30_000, limit: 1_000 });
    expect(reclaimed.find((row) => row.file_id === id)?.attempts).toBe(2);
  });

  it('persists processing completion and terminal failure independently of BullMQ', async () => {
    const completed = fixture();
    await stage(completed.id, completed.storedAs);
    await finalizeStagedFile({ id: completed.id, bytes: 12, job: completed.job });
    await markFileQueued(completed.id);
    await markFileProcessing(completed.id, 100);
    await completeFileProcessing(
      completed.id,
      [{ kind: 'web', file: `${completed.id}-web.webp`, bytes: 8, url: `/files/${completed.id}-web.webp` }],
      200,
    );
    const done = await fileById(completed.id);
    expect(done?.processing_status).toBe('completed');
    expect(done?.processing_outputs).toHaveLength(1);
    expect(done?.processing_finished_at).toBe(200);

    const failed = fixture();
    await stage(failed.id, failed.storedAs);
    await finalizeStagedFile({ id: failed.id, bytes: 12, job: failed.job });
    await failFileProcessing(failed.id, 'ffmpeg failed', 300);
    expect(await fileById(failed.id)).toMatchObject({
      processing_status: 'failed',
      processing_error: 'ffmpeg failed',
      processing_finished_at: 300,
    });
  });

  it('finds stale staging rows without exposing newer ones', async () => {
    const { id, storedAs } = fixture();
    await stage(id, storedAs);
    expect((await staleStagingFiles(Date.now() + 1)).some((file) => file.id === id)).toBe(true);
    expect((await staleStagingFiles(Date.now() - 60_000)).some((file) => file.id === id)).toBe(false);
    expect(await pendingOutboxCount()).toBeGreaterThanOrEqual(0);
  });
});
