import path from 'node:path'
import dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true })

// Vitest sets VITEST; the suite runs against TEST_DATABASE_URL and never touches the dev database.
if (process.env.VITEST && process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  API_BASE_URL: z.string().url().default('http://localhost:4000'),
  CLIENT_ORIGINS: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  AUTH_MODE: z.enum(['clerk', 'dev']).default('dev'),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  DEV_AUTH_SECRET: z.string().min(16).default('dev-only-secret-change-me-please-32'),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./storage'),
  MEDIA_SIGNING_SECRET: z.string().min(16).default('dev-only-media-secret-change-me-32'),
  MEDIA_URL_TTL_SECONDS: z.coerce.number().default(900),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  MAX_IMAGE_MB: z.coerce.number().default(10),
  MAX_VIDEO_MB: z.coerce.number().default(500),

  PAYSTACK_SECRET_KEY: z.string().optional(),
  // One in-app credit costs this many kobo (10_000 = ₦100). Content prices must be whole multiples of it.
  CREDIT_PRICE_KOBO: z.coerce.number().int().positive().default(10_000),
  PLATFORM_COMMISSION_BPS: z.coerce.number().int().min(0).max(10000).default(2000),
  PAYOUT_HOLD_DAYS: z.coerce.number().int().min(0).default(0),
  MIN_PAYOUT_KOBO: z.coerce.number().int().min(0).default(100000),

  // TESTING ONLY: auto-approves age/identity verification for every onboarded user. Refused in production.
  DEMO_AUTO_VERIFY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('✖ Invalid environment configuration:')
  for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join('.')}: ${issue.message}`)
  process.exit(1)
}

export const env = parsed.data

// ---- Production safety rails ----
if (env.NODE_ENV === 'production') {
  const problems: string[] = []
  if (env.DEMO_AUTO_VERIFY) problems.push('DEMO_AUTO_VERIFY=true disables age verification and must be removed in production.')
  if (env.AUTH_MODE !== 'clerk') problems.push('AUTH_MODE must be "clerk" in production (dev auth is insecure).')
  if (!env.CLERK_SECRET_KEY) problems.push('CLERK_SECRET_KEY is required in production.')
  if (!env.PAYSTACK_SECRET_KEY?.startsWith('sk_live_'))
    problems.push('PAYSTACK_SECRET_KEY must be a live key (sk_live_…) in production.')
  for (const k of ['DEV_AUTH_SECRET', 'MEDIA_SIGNING_SECRET'] as const) {
    if (env[k].includes('change-me') || env[k].startsWith('dev-only')) problems.push(`${k} must be set to a unique random secret.`)
  }
  if (problems.length) {
    console.error('✖ Refusing to start in production:\n  - ' + problems.join('\n  - '))
    process.exit(1)
  }
}

if (env.AUTH_MODE === 'clerk' && (!env.CLERK_SECRET_KEY || !env.CLERK_PUBLISHABLE_KEY)) {
  console.error('✖ AUTH_MODE=clerk requires CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY.')
  process.exit(1)
}
if (env.STORAGE_DRIVER === 's3' && !(env.S3_BUCKET && env.S3_REGION && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY)) {
  console.error('✖ STORAGE_DRIVER=s3 requires S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.')
  process.exit(1)
}

export const isDev = env.NODE_ENV !== 'production'
export const clientOrigins = env.CLIENT_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
