export type Tier = 'anonymous' | 'free' | 'pro';

export interface TranscodeJobData {
  /** uuid shared with the stored file and the /jobs/:id route */
  fileId: string;
  /** filename inside uploads/ */
  storedAs: string;
  /** authenticated owner id, or null for no-account uploads */
  ownerId: string | null;
  /** limiter/concurrency identity; anonymous uploads are keyed by IP hash */
  userId: string;
  tier: Tier;
  originalName?: string;
  bytes: number;
  /** optional destination for a media.processed event */
  webhookUrl?: string;
}

export interface TranscodeOutput {
  kind: 'thumb' | 'web' | 'video';
  file: string;
  bytes: number;
  url: string;
}

export interface TranscodeResult {
  outputs: TranscodeOutput[];
}

export interface WebhookJobData {
  url: string;
  payload: {
    event: 'media.processed';
    fileId: string;
    original: { name?: string; bytes: number; url: string };
    outputs: TranscodeOutput[];
    processedAt: string;
  };
}
