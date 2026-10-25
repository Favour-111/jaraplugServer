import { Router } from 'express'
import fs from 'node:fs'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../db'
import { env } from '../env'
import { CITIES, BOOKING_LEAD_HOURS, BOOKING_MAX_DAYS_AHEAD, LAGOS_OFFSET, BOOKING_DURATION_MINS, MAX_PAID_PRICE_KOBO, MIN_PAID_PRICE_KOBO } from '../config/constants'
import { notFound, wrap } from '../lib/errors'
import { resolveLocalPath, verifyMediaToken } from '../storage'
import { optionalAuth, signDevToken } from '../auth'
import { toProviderCard } from '../lib/serializers'
import { blockedIdsFor, isBlockedEitherWay } from '../services/blocks'
import { serializeContent } from '../services/content'
import { forbidden } from '../lib/errors'


export const publicRouter = Router()

publicRouter.get('/health', (_req, res) => res.json({ ok: true }))

publicRouter.get('/config', (_req, res) => {
  res.json({
    authMode: env.AUTH_MODE,
    demoAutoVerify: env.DEMO_AUTO_VERIFY,
    cities: CITIES,
    maxImageMb: env.MAX_IMAGE_MB,
    maxVideoMb: env.MAX_VIDEO_MB,
    minPaidPriceKobo: MIN_PAID_PRICE_KOBO,
    maxPaidPriceKobo: MAX_PAID_PRICE_KOBO,
    creditPriceKobo: env.CREDIT_PRICE_KOBO,
    commissionBps: env.PLATFORM_COMMISSION_BPS,
    payoutHoldDays: env.PAYOUT_HOLD_DAYS,
    minPayoutKobo: env.MIN_PAYOUT_KOBO,
  })
})

// ───────────── Signed media delivery (token = HMAC-signed key + expiry) ─────────────
publicRouter.get('/media/f/:token', wrap(async (req, res) => {
  const key = verifyMediaToken(String(req.params.token))
  if (!key) throw forbidden('This link has expired or is invalid', 'BAD_MEDIA_TOKEN')
  const file = resolveLocalPath(key)
  if (!fs.existsSync(file)) throw notFound()
  res.set({
    'Cache-Control': 'private, no-store',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
  })
  res.sendFile(file, { dotfiles: 'allow', acceptRanges: true })
}))

// ───────────── Dev-only auth (disabled in production / when Clerk is the auth provider) ─────────────
if (env.AUTH_MODE === 'dev' && env.NODE_ENV !== 'production') {
  publicRouter.get('/dev/accounts', wrap(async (_req, res) => {
    const users = await prisma.user.findMany({
      where: { isDemo: true, accountStatus: 'ACTIVE' },
      orderBy: [{ role: 'asc' }, { username: 'asc' }],
      select: { username: true, displayName: true, role: true, authProviderId: true },
    })
    res.json({ accounts: users })
  }))
  publicRouter.post('/dev/login', wrap(async (req, res) => {
    const { authProviderId } = z.object({ authProviderId: z.string().min(1) }).parse(req.body)
    const user = await prisma.user.findUnique({ where: { authProviderId } })
    if (!user) throw notFound('No such dev account')
    res.json({ token: signDevToken(user.authProviderId) })
  }))
  publicRouter.post('/dev/register', wrap(async (req, res) => {
    const { email, displayName } = z.object({ email: z.string().email().optional(), displayName: z.string().max(60).optional() }).parse(req.body)
    const user = await prisma.user.create({ data: { authProviderId: `dev_${crypto.randomUUID()}`, email, displayName } })
    res.status(201).json({ token: signDevToken(user.authProviderId) })
  }))
}

// ───────────── Discovery ─────────────
const discoverQuery = z.object({
  q: z.string().trim().max(80).optional(),
  city: z.string().max(40).optional(),
  availability: z.enum(['AVAILABLE_NOW', 'BY_APPOINTMENT']).optional(),
  newOnly: z.enum(['true', 'false']).optional(),
  online: z.enum(['true', 'false']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(24),
})

publicRouter.get('/providers', optionalAuth, wrap(async (req, res) => {
  const q = discoverQuery.parse(req.query)
  const viewer = req.user
  const blocked = viewer ? await blockedIdsFor(viewer.id) : []

  const profileWhere: Prisma.ProviderProfileWhereInput = {
    verificationStatus: 'VERIFIED',
    profileImage: { not: null }, // never list a profile without a photo
    // Anonymous viewers only see PUBLIC profiles; verified signed-in adults also see MEMBERS_ONLY.
    visibility: viewer && (viewer.ageVerificationStatus === 'VERIFIED' || viewer.role === 'ADMIN') ? { in: ['PUBLIC', 'MEMBERS_ONLY'] } : 'PUBLIC',
    ...(q.city ? { city: q.city } : {}),
    ...(q.availability ? { availabilityStatus: q.availability } : {}),
  }
  const where: Prisma.UserWhereInput = {
    role: 'PROVIDER',
    accountStatus: 'ACTIVE',
    id: { notIn: blocked },
    providerProfile: { is: profileWhere },
    ...(q.newOnly === 'true' ? { createdAt: { gte: new Date(Date.now() - 30 * 86400_000) } } : {}),
    ...(q.q
      ? {
          OR: [
            { displayName: { contains: q.q, mode: 'insensitive' } },
            { username: { contains: q.q, mode: 'insensitive' } },
            { providerProfile: { is: { biography: { contains: q.q, mode: 'insensitive' } } } },
            { providerProfile: { is: { area: { contains: q.q, mode: 'insensitive' } } } },
            { providerProfile: { is: { city: { contains: q.q, mode: 'insensitive' } } } },
          ],
        }
      : {}),
  }

  const rows = await prisma.user.findMany({
    where,
    include: { providerProfile: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  })
  const favs = viewer
    ? new Set((await prisma.favorite.findMany({ where: { userId: viewer.id, providerId: { in: rows.map((r) => r.id) } } })).map((f) => f.providerId))
    : new Set<string>()
  const page = rows.slice(0, q.limit)
  let items = await Promise.all(page.map((r) => toProviderCard(r, r.providerProfile!, { isFavorite: favs.has(r.id) })))
  if (q.online === 'true') items = items.filter((i) => i.online)
  res.json({ items, nextCursor: rows.length > q.limit ? page[page.length - 1].id : null })
}))

async function loadVisibleProvider(username: string, viewer: Express.Request['user']) {
  const user = await prisma.user.findFirst({
    where: { username: { equals: username, mode: 'insensitive' }, role: 'PROVIDER', accountStatus: 'ACTIVE' },
    include: { providerProfile: true },
  })
  const profile = user?.providerProfile
  if (!user || !profile) throw notFound('Profile not found')
  const isSelf = viewer?.id === user.id
  const isAdmin = viewer?.role === 'ADMIN'
  if (!isSelf && !isAdmin) {
    if (profile.verificationStatus !== 'VERIFIED' || profile.visibility === 'HIDDEN') throw notFound('Profile not found')
    if (profile.visibility === 'MEMBERS_ONLY' && viewer?.ageVerificationStatus !== 'VERIFIED') throw notFound('Profile not found')
    if (viewer && (await isBlockedEitherWay(viewer.id, user.id))) throw notFound('Profile not found')
  }
  return { user, profile }
}

publicRouter.get('/providers/:username', optionalAuth, wrap(async (req, res) => {
  const viewer = req.user
  const { user, profile } = await loadVisibleProvider(String(req.params.username), viewer)
  const isFav = viewer ? !!(await prisma.favorite.findUnique({ where: { userId_providerId: { userId: viewer.id, providerId: user.id } } })) : false
  const card = await toProviderCard(user, profile, { isFavorite: isFav })

  const isOwner = viewer?.id === user.id
  const contentRows = await prisma.mediaContent.findMany({
    where: { providerId: user.id, ...(isOwner ? {} : { status: 'PUBLISHED', moderationStatus: 'APPROVED' }) },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  const content = await Promise.all(contentRows.map((c) => serializeContent(c, viewer ?? null)))
  res.json({
    ...card,
    biography: profile.biography,
    content,
    isSelf: isOwner,
  })
}))

// ───────────── Bookable time slots for a provider/date ─────────────
publicRouter.get('/providers/:username/slots', optionalAuth, wrap(async (req, res) => {
  const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query)
  const { user } = await loadVisibleProvider(String(req.params.username), req.user)
  res.json({ date, slots: await computeSlots(user.id, date) })
}))

export async function computeSlots(providerId: string, date: string): Promise<string[]> {
  const dayStart = new Date(`${date}T00:00:00${LAGOS_OFFSET}`)
  if (Number.isNaN(dayStart.getTime())) return []
  const dow = new Date(`${date}T12:00:00${LAGOS_OFFSET}`).getUTCDay()
  const windows = await prisma.availability.findMany({ where: { providerId, dayOfWeek: dow } })
  const accepted = await prisma.booking.findMany({
    where: { providerId, status: 'ACCEPTED', scheduledAt: { gte: dayStart, lt: new Date(dayStart.getTime() + 86400_000) } },
  })
  const earliest = Date.now() + BOOKING_LEAD_HOURS * 3600_000
  const latest = Date.now() + BOOKING_MAX_DAYS_AHEAD * 86400_000
  const slots: string[] = []
  for (const w of windows) {
    for (let m = w.startMinute; m + BOOKING_DURATION_MINS <= w.endMinute; m += BOOKING_DURATION_MINS) {
      const hh = String(Math.floor(m / 60)).padStart(2, '0')
      const mm = String(m % 60).padStart(2, '0')
      const start = new Date(`${date}T${hh}:${mm}:00${LAGOS_OFFSET}`).getTime()
      if (start < earliest || start > latest) continue
      const end = start + BOOKING_DURATION_MINS * 60_000
      if (accepted.some((b) => b.scheduledAt.getTime() < end && b.scheduledAt.getTime() + b.durationMins * 60_000 > start)) continue
      slots.push(`${hh}:${mm}`)
    }
  }
  return [...new Set(slots)].sort()
}
