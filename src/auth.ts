import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from './db.js';
import * as authSchema from './db/schema/auth.js';
import type { AuthTier } from './db.js';

const renderURL = process.env.RENDER_EXTERNAL_HOSTNAME
  ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
  : undefined;
const baseURL = process.env.BETTER_AUTH_URL ?? renderURL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const secret =
  process.env.BETTER_AUTH_SECRET ??
  'dev-only-change-me-32-byte-better-auth-secret';

export const auth = betterAuth({
  appName: 'MRL Media',
  baseURL,
  basePath: '/api/auth',
  secret,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: authSchema,
  }),
  emailAndPassword: {
    enabled: true,
  },
  user: {
    additionalFields: {
      tier: {
        type: 'string',
        required: true,
        input: false,
        defaultValue: 'free',
      },
    },
  },
  plugins: [
    apiKey({
      defaultPrefix: 'mk_',
      requireName: true,
      enableSessionForAPIKeys: true,
      rateLimit: {
        enabled: false,
      },
      startingCharactersConfig: {
        shouldStore: true,
        charactersLength: 10,
      },
      customAPIKeyGetter(ctx) {
        const direct = ctx.headers?.get('x-api-key');
        if (direct) return direct;

        const authHeader = ctx.headers?.get('authorization');
        if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
        return null;
      },
    }),
  ],
  trustedOrigins: [baseURL, 'http://localhost:3000', 'http://127.0.0.1:3000'],
});

type BetterAuthUser = {
  id: string;
  name: string;
  createdAt: Date | string | number;
  tier?: unknown;
};

export function toAppUser(user: BetterAuthUser) {
  return {
    id: user.id,
    name: user.name,
    tier: user.tier === 'pro' ? ('pro' as AuthTier) : ('free' as AuthTier),
    created_at: toMillis(user.createdAt),
  };
}

function toMillis(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
