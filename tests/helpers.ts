import request from 'supertest'
import sharp from 'sharp'
import fs from 'node:fs'
import crypto from 'node:crypto'
import type { Prisma, User } from '@prisma/client'
import { prisma } from '../src/db'
import { env } from '../src/env'
import { createApp } from '../src/app'
import { signDevToken } from '../src/auth'
import { localRoot, storage } from '../src/storage'
import { resetMessageRateLimits } from '../src/services/messaging'

if (!/test/i.test(env.DATABASE_URL)) throw new Error('Refusing to run tests against a non-test database: ' + env.DATABASE_URL)

export const app = createApp()
export const api = () => request(app)

export async function resetAll() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`)
  await fs.promises.rm(localRoot(), { recursive: true, force: true })
  resetMessageRateLimits()
}

export const tokenFor = (u: Pick<User, 'authProviderId'>) => signDevToken(u.authProviderId)
export const auth = (u: Pick<User, 'authProviderId'>) => ({ Authorization: `Bearer ${tokenFor(u)}` })

let seq = 0
export async function makeUser(over: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  const n = ++seq
  const username = (over.username as string | undefined) ?? `user${n}`
  return prisma.user.create({
    data: {
      authProviderId: `test_${username}_${n}`, username, displayName: username, role: 'CLIENT', ageVerificationStatus: 'VERIFIED',
      city: 'Lagos', onboardedAt: new Date(), email: `${username}@example.test`, ...over,
    },
  })
}
export const makeClient = (over: Partial<Prisma.UserUncheckedCreateInput> = {}) => makeUser({ role: 'CLIENT', ...over })
export const makeAdmin = (over: Partial<Prisma.UserUncheckedCreateInput> = {}) => makeUser({ role: 'ADMIN', ...over })

export async function makeProvider(
  over: Partial<Prisma.UserUncheckedCreateInput> = {},
  profile: Partial<Prisma.ProviderProfileUncheckedCreateInput> = {},
) {
  const user = await makeUser({ role: 'PROVIDER', ...over })
  await prisma.providerProfile.create({
    data: {
      userId: user.id, biography: 'A fictional test provider with a long enough biography.', city: 'Lagos', area: 'Lekki', displayAge: 25,
      verificationStatus: 'VERIFIED', visibility: 'PUBLIC', availabilityStatus: 'AVAILABLE_NOW',
      consentConfirmedAt: new Date(), profileImage: 'profiles/test.jpg', ...profile,
    },
  })
  return user
}

export async function openAvailability(providerId: string) {
  await prisma.availability.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ providerId, dayOfWeek: d, startMinute: 8 * 60, endMinute: 22 * 60 })) })
}

export const lagosDate = (daysAhead: number) => new Date(Date.now() + daysAhead * 86400_000 + 3600_000).toISOString().slice(0, 10)

export const png = (w = 64, h = 64) => sharp({ create: { width: w, height: h, channels: 3, background: '#aa0033' } }).png().toBuffer()

export async function makeContent(providerId: string, over: Partial<Prisma.MediaContentUncheckedCreateInput> = {}) {
  const id = over.id ?? crypto.randomUUID()
  const img = await png()
  await storage.putBuffer(`content/${providerId}/${id}.png`, img, 'image/png')
  await storage.putBuffer(`thumbs/${providerId}/${id}.jpg`, img, 'image/jpeg')
  return prisma.mediaContent.create({
    data: {
      id, providerId, title: 'Test item', mediaType: 'IMAGE', mimeType: 'image/png', sizeBytes: img.length,
      storageKey: `content/${providerId}/${id}.png`, thumbnailKey: `thumbs/${providerId}/${id}.jpg`,
      visibility: 'PAID', price: 500_000, status: 'PUBLISHED', moderationStatus: 'APPROVED', consentConfirmed: true, ...over,
    },
  })
}

// ───────────── Paystack test double (no network in tests) ─────────────
/** Transactions Paystack should report as paid when the server asks it directly (keyed by reference). */
export const paystackTx = new Map<string, { id: number; status: string; amount: number; currency: string }>()
const realFetch = globalThis.fetch
const jsonRes = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input)
  if (url.startsWith('https://api.paystack.co/transaction/initialize')) {
    const b = JSON.parse(init.body)
    return jsonRes({ status: true, message: 'ok', data: { authorization_url: `https://checkout.paystack.com/${b.reference}`, reference: b.reference } })
  }
  const m = /^https:\/\/api\.paystack\.co\/transaction\/verify\/(.+)$/.exec(url)
  if (m) {
    const ref = decodeURIComponent(m[1])
    const t = paystackTx.get(ref)
    return jsonRes({ status: true, message: 'ok', data: t ? { ...t, reference: ref } : { id: 0, status: 'abandoned', reference: ref, amount: 0, currency: 'NGN' } })
  }
  return realFetch(input, init)
}) as typeof fetch

let evtSeq = 1000
/** Builds a Paystack `charge.success` webhook for a reference and signs it exactly like Paystack does (HMAC-SHA512 of the body with the secret key). */
export function signedEvent(reference: string, amount: number, over: { id?: number; event?: string; status?: string; currency?: string } = {}) {
  const body = Buffer.from(JSON.stringify({
    event: over.event ?? 'charge.success',
    data: { id: over.id ?? ++evtSeq, status: over.status ?? 'success', reference, amount, currency: over.currency ?? 'NGN' },
  }))
  return { body, signature: crypto.createHmac('sha512', env.PAYSTACK_SECRET_KEY!).update(body).digest('hex') }
}
export const postWebhook = (e: { body: Buffer; signature: string }) =>
  api().post('/api/webhooks/payments').set('content-type', 'application/json').set('x-paystack-signature', e.signature).send(e.body.toString('utf8'))

export const pathOf = (url: string) => new URL(url).pathname
export { prisma }
