import path from 'node:path';
import { fileURLToPath } from 'node:url';

function appPath(envName: string, fallbackUrl: string): string {
  const configured = process.env[envName];
  if (configured) return path.resolve(configured);
  return fileURLToPath(new URL(fallbackUrl, import.meta.url));
}

export const DATA_DIR = appPath('DATA_DIR', '../data/');
export const UPLOAD_DIR = appPath('UPLOAD_DIR', '../uploads/');
export const PUBLIC_DIR = appPath('PUBLIC_DIR', '../public/');
