import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { eq } from 'drizzle-orm';
import { db } from './db.js';
import { objects } from './db/schema/app.js';
import { UPLOAD_DIR } from './paths.js';

export interface StoredObject {
  key: string;
  contentType: string;
  bytes: number;
  stream: NodeJS.ReadableStream;
}

export interface StorageProvider {
  putFile(key: string, filePath: string, contentType: string): Promise<{ bytes: number }>;
  getObject(key: string): Promise<StoredObject | null>;
  downloadToFile(key: string, filePath: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
}

class LocalStorage implements StorageProvider {
  async putFile(key: string, filePath: string): Promise<{ bytes: number }> {
    await mkdir(UPLOAD_DIR, { recursive: true });
    const dest = path.join(UPLOAD_DIR, key);
    if (path.resolve(filePath) !== path.resolve(dest)) {
      await pipeline(createReadStream(filePath), createWriteStream(dest));
    }
    const info = await stat(dest);
    return { bytes: info.size };
  }

  async getObject(key: string): Promise<StoredObject | null> {
    const file = path.join(UPLOAD_DIR, key);
    try {
      const info = await stat(file);
      return {
        key,
        contentType: contentTypeForKey(key),
        bytes: info.size,
        stream: createReadStream(file),
      };
    } catch {
      return null;
    }
  }

  async downloadToFile(key: string, filePath: string): Promise<void> {
    await pipeline(createReadStream(path.join(UPLOAD_DIR, key)), createWriteStream(filePath));
  }

  async deleteObject(key: string): Promise<void> {
    await unlink(path.join(UPLOAD_DIR, key)).catch(() => {});
  }
}

class DatabaseStorage implements StorageProvider {
  async putFile(key: string, filePath: string, contentType: string): Promise<{ bytes: number }> {
    const data = await readFile(filePath);
    await db
      .insert(objects)
      .values({
        object_key: key,
        content_type: contentType,
        bytes: data.byteLength,
        data_base64: data.toString('base64'),
        created_at: Date.now(),
      })
      .onConflictDoUpdate({
        target: objects.object_key,
        set: {
          content_type: contentType,
          bytes: data.byteLength,
          data_base64: data.toString('base64'),
          created_at: Date.now(),
        },
      });
    return { bytes: data.byteLength };
  }

  async getObject(key: string): Promise<StoredObject | null> {
    const [row] = await db.select().from(objects).where(eq(objects.object_key, key)).limit(1);
    if (!row) return null;
    const data = Buffer.from(row.data_base64, 'base64');
    return {
      key,
      contentType: row.content_type,
      bytes: row.bytes,
      stream: Readable.from(data),
    };
  }

  async downloadToFile(key: string, filePath: string): Promise<void> {
    const object = await this.getObject(key);
    if (!object) throw new Error(`object not found: ${key}`);
    await writeFile(filePath, Buffer.from(await streamToBuffer(object.stream)));
  }

  async deleteObject(key: string): Promise<void> {
    await db.delete(objects).where(eq(objects.object_key, key));
  }
}

class S3Storage implements StorageProvider {
  private readonly bucket = requiredEnv('S3_BUCKET');
  private readonly client = new S3Client({
    region: process.env.S3_REGION ?? 'auto',
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1',
    credentials:
      process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
          }
        : undefined,
  });

  async putFile(key: string, filePath: string, contentType: string): Promise<{ bytes: number }> {
    const info = await stat(filePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: info.size,
        ContentType: contentType,
      }),
    );
    return { bytes: info.size };
  }

  async getObject(key: string): Promise<StoredObject | null> {
    let res: GetObjectCommandOutput;
    try {
      res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return null;
      throw err;
    }
    if (!res.Body) return null;
    return {
      key,
      contentType: res.ContentType ?? contentTypeForKey(key),
      bytes: res.ContentLength ?? 0,
      stream: bodyToNodeStream(res.Body),
    };
  }

  async downloadToFile(key: string, filePath: string): Promise<void> {
    const object = await this.getObject(key);
    if (!object) throw new Error(`object not found: ${key}`);
    await pipeline(object.stream, createWriteStream(filePath));
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export const storage = createStorage();

export function contentTypeForKey(key: string, fallback = 'application/octet-stream'): string {
  const ext = path.extname(key).toLowerCase();
  return (
    {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.mp4': 'video/mp4',
      '.txt': 'text/plain',
      '.json': 'application/json',
    }[ext] ?? fallback
  );
}

export async function removeTempFile(filePath: string): Promise<void> {
  await unlink(filePath).catch(() => {});
}

function createStorage(): StorageProvider {
  const driver = process.env.STORAGE_DRIVER ?? (process.env.DATABASE_URL ? 'database' : 'local');
  if (driver === 's3') return new S3Storage();
  if (driver === 'database') return new DatabaseStorage();
  if (driver === 'local') return new LocalStorage();
  throw new Error(`unsupported STORAGE_DRIVER=${driver}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function bodyToNodeStream(body: unknown): NodeJS.ReadableStream {
  if (body instanceof Readable) return body;
  if (body instanceof Uint8Array) return Readable.from(body);
  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === 'function') {
    async function* chunks() {
      const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
      yield Buffer.from(bytes);
    }
    return Readable.from(chunks());
  }
  if (typeof (body as { getReader?: unknown }).getReader === 'function') {
    return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  }
  throw new Error('unsupported S3 body stream');
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
