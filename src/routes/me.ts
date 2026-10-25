import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db'
import { applyReferral } from '../services/referrals'
import { env } from '../env'
import { CITIES } from '../config/constants'
import { badRequest, conflict, forbidden, wrap } from '../lib/errors'
import { me, requireAuth } from '../auth'
import { toSelf } from '../lib/serializers'
import { imageUpload, processImage, rm, validateUpload } from '../lib/upload'
import { storage } from '../storage'
import { serializeContent } from '../services/content'
import { emitToUser } from '../services/realtime'

export const meRouter = Router()
meRouter.use(requireAuth)

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,24}$/, 'Usernames are 3–24 characters: letters, numbers and underscores')

meRouter.get('/', wrap(async (req, res) => {
  const u = me(req)
  const profile = u.role === 'PROVIDER' ? await prisma.providerProfile.findUnique({ where: { userId: u.id } }) : null
  const [unreadMessages, unreadNotifications, pendingBookings] = await Promise.all([
    prisma.message.count({ where: { readAt: null, senderId: { not: u.id }, conversation: { participants: { some: { userId: u.id } } } } }),
    prisma.notification.count({ where: { userId: u.id, readAt: null } }),
    u.role === 'PROVIDER' ? prisma.booking.count({ where: { providerId: u.id, status: 'PENDING' } }) : 0,
  ])
  const avatarKey = profile?.profileImage ?? u.avatarKey
  res.json({
    ...toSelf(u, profile),
    avatarUrl: avatarKey ? await storage.signedUrl(avatarKey, 3600) : null,
    creditBalance: u.creditBalance,
    counts: { unreadMessages, unreadNotifications, pendingBookings },
  })
}))

// ─── Onboarding: the ONLY place a role is chosen, and only once. ADMIN can never be self-assigned. ───
const onboardingSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('CLIENT'),
    username,
    displayName: z.string().trim().min(2).max(40).optional(),
    city: z.enum(CITIES),
    acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You must accept the Terms and Privacy Policy' }) }),
    referralCode: z.string().max(20).optional(),
  }),
  z.object({
    role: z.literal('PROVIDER'),
    username,
    displayName: z.string().trim().min(2).max(40),
    city: z.enum(CITIES),
    acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You must accept the Terms and Privacy Policy' }) }),
  }),
])

meRouter.post('/onboarding', wrap(async (req, res) => {
  const u = me(req)
  if (u.role !== 'UNASSIGNED' || u.onboardedAt) throw conflict('Your account type is already set and cannot be changed', 'ROLE_LOCKED')
  const body = onboardingSchema.parse(req.body)
  const taken = await prisma.user.findFirst({ where: { username: body.username, id: { not: u.id } } })
  if (taken) throw conflict('That username is taken', 'USERNAME_TAKEN')
  const now = new Date()
  const updated = await prisma.$transaction(async (db) => {
    const user = await db.user.update({
      where: { id: u.id },
      data: {
        role: body.role,
        username: body.username,
        displayName: body.displayName ?? body.username,
        city: body.city,
        termsAcceptedAt: now,
        privacyAcceptedAt: now,
        onboardedAt: now,
        // The mandatory "I am 18 or older" tick-box is the age declaration.
        ageVerificationStatus: 'VERIFIED',
      },
    })
    await db.verificationRequest.create({ data: { userId: u.id, type: 'AGE', status: 'APPROVED', providerRef: 'self-declared', reviewedAt: now } })
    if (body.role === 'PROVIDER') {
      await db.providerProfile.create({ data: { userId: u.id, city: body.city, visibility: 'PUBLIC' } })
    }
    return user
  })
  if (body.role === 'CLIENT') await applyReferral(updated, body.referralCode)
  res.status(201).json(toSelf(updated))
}))

meRouter.patch('/', wrap(async (req, res) => {
  const u = me(req)
  const body = z.object({
    displayName: z.string().trim().min(2).max(40).optional(),
    city: z.enum(CITIES).optional(),
  }).parse(req.body)
  const updated = await prisma.user.update({ where: { id: u.id }, data: body })
  res.json(toSelf(updated))
}))

meRouter.post('/avatar', imageUpload.single('file'), wrap(async (req, res) => {
  const u = me(req)
  const sniffed = await validateUpload(req.file, ['IMAGE'])
  void sniffed
  const { main } = await processImage(req.file!.path, { maxWidth: 512 })
  const key = `avatars/${u.id}/${Date.now()}.jpg`
  await storage.putBuffer(key, main, 'image/jpeg')
  await rm(req.file!.path)
  if (u.avatarKey) await storage.delete(u.avatarKey).catch(() => {})
  await prisma.user.update({ where: { id: u.id }, data: { avatarKey: key } })
  res.json({ avatarUrl: await storage.signedUrl(key, 3600) })
}))

// ─── Purchased-content library ───
meRouter.get('/purchases', wrap(async (req, res) => {
  const u = me(req)
  const rows = await prisma.contentPurchase.findMany({
    where: { buyerId: u.id },
    orderBy: { purchasedAt: 'desc' },
    include: { content: { include: { provider: { select: { username: true, displayName: true } } } }, transaction: { select: { providerReference: true, status: true } } },
  })
  const items = await Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      purchasedAt: r.purchasedAt,
      amount: r.amount,
      status: r.status,
      reference: r.transaction.providerReference,
      provider: r.content.provider,
      content: await serializeContent(r.content, u, { withUrl: false }),
    })),
  )
  res.json({ items })
}))

meRouter.get('/transactions', wrap(async (req, res) => {
  const u = me(req)
  const rows = await prisma.transaction.findMany({
    where: { userId: u.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  const contentIds = rows.map((r) => r.contentId).filter(Boolean) as string[]
  const contents = await prisma.mediaContent.findMany({ where: { id: { in: contentIds } }, select: { id: true, title: true } })
  const titles = new Map(contents.map((c) => [c.id, c.title]))
  res.json({
    items: rows.map((r) => ({
      id: r.id, reference: r.providerReference, amount: r.amount, currency: r.currency, status: r.status,
      type: r.transactionType, title: r.contentId ? titles.get(r.contentId) ?? null : null, createdAt: r.createdAt, paidAt: r.paidAt,
    })),
  })
}))

// ─── Privacy: data export & account deletion ───
meRouter.get('/export', wrap(async (req, res) => {
  const u = me(req)
  const [profile, favorites, bookings, purchases, transactions, reports, notifications, messages] = await Promise.all([
    prisma.providerProfile.findUnique({ where: { userId: u.id } }),
    prisma.favorite.findMany({ where: { userId: u.id } }),
    prisma.booking.findMany({ where: { OR: [{ clientId: u.id }, { providerId: u.id }] } }),
    prisma.contentPurchase.findMany({ where: { buyerId: u.id } }),
    prisma.transaction.findMany({ where: { OR: [{ userId: u.id }, { payeeId: u.id }] } }),
    prisma.report.findMany({ where: { reporterId: u.id } }),
    prisma.notification.findMany({ where: { userId: u.id } }),
    prisma.message.findMany({ where: { senderId: u.id }, select: { id: true, conversationId: true, body: true, createdAt: true } }),
  ])
  res.setHeader('Content-Disposition', 'attachment; filename="jaraplug-data-export.json"')
  res.json({ exportedAt: new Date(), account: toSelf(u), providerProfile: profile, favorites, bookings, purchases, transactions, reports, notifications, messagesSent: messages })
}))

meRouter.delete('/', wrap(async (req, res) => {
  const u = me(req)
  const { confirm } = z.object({ confirm: z.literal('DELETE') }).parse(req.body)
  void confirm
  if (u.role === 'ADMIN') throw forbidden('Administrator accounts must be removed by another administrator')

  const openPayout = await prisma.payout.count({ where: { providerId: u.id, status: 'REQUESTED' } })
  if (openPayout) throw conflict('You have a payout in progress. Contact support before deleting your account.', 'PAYOUT_PENDING')

  const content = await prisma.mediaContent.findMany({ where: { providerId: u.id }, include: { _count: { select: { purchases: true } } } })
  const profile = await prisma.providerProfile.findUnique({ where: { userId: u.id } })
  const authId = u.authProviderId
  const filesToDelete = [u.avatarKey, profile?.profileImage, ...content.flatMap((c) => [c.storageKey, c.thumbnailKey])].filter(Boolean) as string[]
  const attachments = await prisma.message.findMany({ where: { senderId: u.id, attachmentKey: { not: null } }, select: { attachmentKey: true } })
  filesToDelete.push(...attachments.map((a) => a.attachmentKey!))

  await prisma.$transaction(async (db) => {
    await db.booking.updateMany({ where: { OR: [{ clientId: u.id }, { providerId: u.id }], status: { in: ['PENDING', 'ACCEPTED'] } }, data: { status: 'CANCELLED', declineReason: 'Account deleted' } })
    // Content with purchases is kept as a removed tombstone so financial records stay consistent; the files are erased.
    for (const c of content) {
      if (c._count.purchases > 0) await db.mediaContent.update({ where: { id: c.id }, data: { status: 'DRAFT', moderationStatus: 'REMOVED', storageKey: 'deleted', thumbnailKey: null, title: 'Removed content', description: '' } })
      else await db.mediaContent.delete({ where: { id: c.id } })
    }
    await db.message.updateMany({ where: { senderId: u.id }, data: { body: '', attachmentKey: null } })
    await db.providerProfile.deleteMany({ where: { userId: u.id } })
    await db.favorite.deleteMany({ where: { OR: [{ userId: u.id }, { providerId: u.id }] } })
    await db.block.deleteMany({ where: { OR: [{ blockerId: u.id }, { blockedId: u.id }] } })
    await db.availability.deleteMany({ where: { providerId: u.id } })
    await db.notification.deleteMany({ where: { userId: u.id } })
    await db.supportRequest.deleteMany({ where: { userId: u.id } })
    await db.verificationRequest.deleteMany({ where: { userId: u.id } })
    await db.user.update({
      where: { id: u.id },
      data: {
        accountStatus: 'DELETED', username: null, displayName: 'Deleted user', email: null, city: null, preferences: undefined,
        // authProviderId is intentionally kept: the tombstone makes any lingering session token resolve to a DELETED
        // account (401) instead of silently creating a brand-new blank account for the same identity.
        avatarKey: null, ageVerificationStatus: 'NOT_STARTED',
      },
    })
  })
  await Promise.all(filesToDelete.filter((k) => k !== 'deleted').map((k) => storage.delete(k).catch(() => {})))
  if (env.AUTH_MODE === 'clerk' && !authId.startsWith('dev_')) {
    try {
      const { createClerkClient } = await import('@clerk/backend')
      await createClerkClient({ secretKey: env.CLERK_SECRET_KEY! }).users.deleteUser(authId)
    } catch (e) {
      console.error('Failed to delete Clerk user', e)
    }
  }
  emitToUser(u.id, 'account:deleted', {})
  res.json({ ok: true })
}))

void badRequest
