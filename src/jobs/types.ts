export type Tier = 'free' | 'pro';

export interface TranscodeJobData {
  /** uuid shared with the stored file and the /jobs/:id route */
  fileId: string;
  /** filename inside uploads/ */
  storedAs: string;
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
