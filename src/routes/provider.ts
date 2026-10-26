import { Router } from 'express'
import { z } from 'zod'
import crypto from 'node:crypto'
import { prisma } from '../db'
import { env } from '../env'
import { CITIES, NIGERIAN_BANKS } from '../config/constants'
import { badRequest, conflict, forbidden, wrap } from '../lib/errors'
import { me, requireAuth, requireRole } from '../auth'
import { imageUpload, processImage, rm, validateUpload } from '../lib/upload'
import { storage } from '../storage'
import { notify, notifyAdmins } from '../services/notify'
import { formatNaira } from '../lib/money'

export const providerRouter = Router()
providerRouter.use(requireAuth, requireRole('PROVIDER'))

const profileOut = async (userId: string) => {
  const p = await prisma.providerProfile.findUniqueOrThrow({ where: { userId } })
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  return {
    username: u.username, displayName: u.displayName, biography: p.biography, city: p.city, area: p.area, displayAge: p.displayAge,
    visibility: p.visibility, availabilityStatus: p.availabilityStatus,
    publicFields: p.publicFields, verificationStatus: p.verificationStatus, submittedAt: p.submittedAt,
    consentConfirmed: !!p.consentConfirmedAt,
    profileImageUrl: p.profileImage ? await storage.signedUrl(p.profileImage, 3600) : null,
  }
}

providerRouter.get('/profile', wrap(async (req, res) => res.json(await profileOut(me(req).id))))

const profileSchema = z.object({
  displayName: z.string().trim().min(2).max(40).optional(),
  biography: z.string().trim().max(1000).optional(),
  city: z.enum(CITIES).optional(),
  area: z.string().trim().max(60).nullable().optional(),
  displayAge: z.number().int().min(18, 'Providers must be 18 or older').max(99).nullable().optional(),
  visibility: z.enum(['PUBLIC', 'MEMBERS_ONLY', 'HIDDEN']).optional(),
  availabilityStatus: z.enum(['AVAILABLE_NOW', 'BY_APPOINTMENT', 'OFFLINE']).optional(),
  publicFields: z.object({ age: z.boolean(), area: z.boolean() }).optional(),
  consentConfirmed: z.boolean().optional(),
})

providerRouter.put('/profile', wrap(async (req, res) => {
  const u = me(req)
  const body = profileSchema.parse(req.body)
  const { displayName, consentConfirmed, ...rest } = body
  await prisma.$transaction([
    prisma.providerProfile.update({
      where: { userId: u.id },
      data: { ...rest, ...(consentConfirmed === true ? { consentConfirmedAt: new Date() } : consentConfirmed === false ? { consentConfirmedAt: null } : {}) },
    }),
    ...(displayName ? [prisma.user.update({ where: { id: u.id }, data: { displayName } })] : []),
    ...(body.city ? [prisma.user.update({ where: { id: u.id }, data: { city: body.city } })] : []),
  ])
  res.json(await profileOut(u.id))
}))

providerRouter.post('/profile/photo', imageUpload.single('file'), wrap(async (req, res) => {
  const u = me(req)
  await validateUpload(req.file, ['IMAGE'])
  const { main } = await processImage(req.file!.path, { maxWidth: 1000 })
  const key = `profiles/${u.id}/${Date.now()}.jpg`
  await storage.putBuffer(key, main, 'image/jpeg')
  await rm(req.file!.path)
  const old = await prisma.providerProfile.findUniqueOrThrow({ where: { userId: u.id } })
  await prisma.providerProfile.update({ where: { userId: u.id }, data: { profileImage: key } })
  if (old.profileImage) await storage.delete(old.profileImage).catch(() => {})
  res.json({ profileImageUrl: await storage.signedUrl(key, 3600) })
}))

/** Submit the profile for review. Identity & age checks are performed by the external verification provider. */
providerRouter.post('/profile/submit', wrap(async (req, res) => {
  const u = me(req)
  const p = await prisma.providerProfile.findUniqueOrThrow({ where: { userId: u.id } })
  if (p.verificationStatus === 'VERIFIED') throw conflict('Your profile is already verified', 'ALREADY_VERIFIED')
  if (p.verificationStatus === 'PENDING') throw conflict('Your profile is already awaiting review', 'ALREADY_PENDING')
  const missing: string[] = []
  if (!p.profileImage) missing.push('a profile photo')
  if (p.biography.length < 20) missing.push('a biography (at least 20 characters)')
  if (!p.displayAge || p.displayAge < 18) missing.push('your age (18+)')
  if (!p.consentConfirmedAt) missing.push('confirmation of rights and consent for your media')
  if (missing.length) throw badRequest(`Please add ${missing.join(', ')} before submitting`, 'PROFILE_INCOMPLETE')
  await prisma.$transaction([
    prisma.verificationRequest.create({ data: { userId: u.id, type: 'PROVIDER_IDENTITY' } }),
    prisma.providerProfile.update({ where: { userId: u.id }, data: { verificationStatus: 'PENDING', submittedAt: new Date() } }),
  ])
  await notifyAdmins('VERIFICATION_REQUESTED', 'Provider profile submitted', `@${u.username} is waiting for review`, '/admin/verifications')
  res.status(201).json({ verificationStatus: 'PENDING' })
}))

// ─── Dashboard: every number is read from the database ───
providerRouter.get('/overview', wrap(async (req, res) => {
  const u = me(req)
  const [published, drafts, purchases, pendingBookings, completedBookings, earnings, profile, unreadMessages] = await Promise.all([
    prisma.mediaContent.count({ where: { providerId: u.id, status: 'PUBLISHED', moderationStatus: 'APPROVED' } }),
    prisma.mediaContent.count({ where: { providerId: u.id, OR: [{ status: 'DRAFT' }, { moderationStatus: { in: ['PENDING', 'UNDER_REVIEW'] } }] } }),
    prisma.transaction.count({ where: { payeeId: u.id, status: 'SUCCESS' } }),
    prisma.booking.count({ where: { providerId: u.id, status: 'PENDING' } }),
    prisma.booking.count({ where: { providerId: u.id, status: 'COMPLETED' } }),
    prisma.transaction.aggregate({ where: { payeeId: u.id, status: 'SUCCESS' }, _sum: { netAmount: true } }),
    prisma.providerProfile.findUniqueOrThrow({ where: { userId: u.id } }),
    prisma.message.count({ where: { readAt: null, senderId: { not: u.id }, conversation: { participants: { some: { userId: u.id } } } } }),
  ])
  res.json({
    publishedContent: published, pendingContent: drafts, purchases, pendingBookings, completedBookings,
    netEarnings: earnings._sum.netAmount ?? 0, unreadMessages, verificationStatus: profile.verificationStatus,
  })
}))

// ─── Weekly availability ───
providerRouter.get('/availability', wrap(async (req, res) => {
  const rows = await prisma.availability.findMany({ where: { providerId: me(req).id }, orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] })
  res.json({ windows: rows.map((r) => ({ dayOfWeek: r.dayOfWeek, startMinute: r.startMinute, endMinute: r.endMinute })) })
}))

const windowSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
}).refine((w) => w.endMinute - w.startMinute >= 60, 'Each window must be at least 60 minutes')

providerRouter.put('/availability', wrap(async (req, res) => {
  const u = me(req)
  const { windows } = z.object({ windows: z.array(windowSchema).max(35) }).parse(req.body)
  await prisma.$transaction([
    prisma.availability.deleteMany({ where: { providerId: u.id } }),
    prisma.availability.createMany({ data: windows.map((w) => ({ ...w, providerId: u.id })) }),
  ])
  res.json({ windows })
}))

// ─── Earnings: derived exclusively from verified transaction records ───
export async function computeEarnings(providerId: string) {
  const holdCutoff = new Date(Date.now() - env.PAYOUT_HOLD_DAYS * 86400_000)
  const [ok, refunded, pending, releasable, payouts] = await Promise.all([
    prisma.transaction.aggregate({ where: { payeeId: providerId, status: 'SUCCESS' }, _sum: { amount: true, platformFee: true, processingFee: true, netAmount: true }, _count: true }),
    prisma.transaction.aggregate({ where: { payeeId: providerId, status: 'REFUNDED' }, _sum: { amount: true }, _count: true }),
    prisma.transaction.aggregate({ where: { payeeId: providerId, status: 'SUCCESS', paidAt: { gt: holdCutoff } }, _sum: { netAmount: true } }),
    prisma.transaction.aggregate({ where: { payeeId: providerId, status: 'SUCCESS', paidAt: { lte: holdCutoff } }, _sum: { netAmount: true } }),
    prisma.payout.groupBy({ by: ['status'], where: { providerId }, _sum: { amount: true } }),
  ])
  const sumPayout = (s: string) => payouts.find((p) => p.status === s)?._sum.amount ?? 0
  const reserved = sumPayout('REQUESTED') + sumPayout('PAID')
  return {
    grossAmount: ok._sum.amount ?? 0,
    platformFees: ok._sum.platformFee ?? 0,
    processingFees: ok._sum.processingFee ?? 0,
    netEarnings: ok._sum.netAmount ?? 0,
    salesCount: ok._count,
    refundedAmount: refunded._sum.amount ?? 0,
    refundCount: refunded._count,
    pendingBalance: pending._sum.netAmount ?? 0,
    payableBalance: Math.max(0, (releasable._sum.netAmount ?? 0) - reserved),
    paidOut: sumPayout('PAID'),
    payoutRequested: sumPayout('REQUESTED'),
    holdDays: env.PAYOUT_HOLD_DAYS,
    commissionBps: env.PLATFORM_COMMISSION_BPS,
  }
}

providerRouter.get('/earnings', wrap(async (req, res) => {
  const u = me(req)
  const [summary, txs, payouts] = await Promise.all([
    computeEarnings(u.id),
    prisma.transaction.findMany({ where: { payeeId: u.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.payout.findMany({ where: { providerId: u.id }, orderBy: { requestedAt: 'desc' }, take: 50 }),
  ])
  const titles = new Map(
    (await prisma.mediaContent.findMany({ where: { id: { in: txs.map((t) => t.contentId).filter(Boolean) as string[] } }, select: { id: true, title: true } })).map((c) => [c.id, c.title]),
  )
  res.json({
    summary,
    // Buyers are deliberately not identified to providers (data minimisation).
    transactions: txs.map((t) => ({ id: t.id, reference: t.providerReference, title: t.contentId ? titles.get(t.contentId) ?? null : null, amount: t.amount, platformFee: t.platformFee, processingFee: t.processingFee, netAmount: t.netAmount, status: t.status, createdAt: t.createdAt })),
    payouts: payouts.map((p) => ({ id: p.id, reference: p.reference, amount: p.amount, status: p.status, note: p.note, bankName: p.bankName, accountNumberMasked: p.accountNumber ? maskAccount(p.accountNumber) : null, requestedAt: p.requestedAt, paidAt: p.paidAt })),
  })
}))

// ─── Payout account + withdrawals (paid manually by an administrator) ───
const maskAccount = (n: string) => `••••••${n.slice(-4)}`

async function requireVerifiedProvider(userId: string) {
  const profile = await prisma.providerProfile.findUniqueOrThrow({ where: { userId } })
  if (profile.verificationStatus !== 'VERIFIED') throw forbidden('Only verified providers can withdraw', 'NOT_VERIFIED')
}

/** Balance that can be withdrawn right now (released from the hold, minus pending and paid withdrawals). */
async function availableToWithdraw(db: Pick<typeof prisma, 'transaction' | 'payout'>, providerId: string) {
  const holdCutoff = new Date(Date.now() - env.PAYOUT_HOLD_DAYS * 86400_000)
  const rel = await db.transaction.aggregate({ where: { payeeId: providerId, status: 'SUCCESS', paidAt: { lte: holdCutoff } }, _sum: { netAmount: true } })
  const used = await db.payout.aggregate({ where: { providerId, status: { in: ['REQUESTED', 'PAID'] } }, _sum: { amount: true } })
  return (rel._sum.netAmount ?? 0) - (used._sum.amount ?? 0)
}

providerRouter.get('/payout-account', wrap(async (req, res) => {
  const a = await prisma.payoutAccount.findUnique({ where: { userId: me(req).id } })
  res.json({ banks: NIGERIAN_BANKS, account: a ? { bankName: a.bankName, accountName: a.accountName, accountNumberMasked: maskAccount(a.accountNumber), updatedAt: a.updatedAt } : null })
}))

providerRouter.put('/payout-account', wrap(async (req, res) => {
  const u = me(req)
  await requireVerifiedProvider(u.id)
  const body = z.object({
    bankName: z.enum(NIGERIAN_BANKS),
    accountNumber: z.string().regex(/^\d{10}$/, 'Account number must be 10 digits'),
    accountName: z.string().trim().min(3, 'Enter the account name').max(80),
  }).parse(req.body)
  await prisma.payoutAccount.upsert({ where: { userId: u.id }, update: body, create: { userId: u.id, ...body } })
  await notify(u.id, 'PAYOUT', 'Payout account updated', `${body.bankName} ${maskAccount(body.accountNumber)}. If this was not you, contact support immediately.`, '/provider/earnings').catch(() => {})
  res.json({ ok: true, account: { bankName: body.bankName, accountName: body.accountName, accountNumberMasked: maskAccount(body.accountNumber) } })
}))

/**
 * Withdraw earnings. Creates a payout request with a snapshot of the bank details and alerts the admins, who send the
 * money by bank transfer and mark it paid. The balance is re-checked under a lock so concurrent requests cannot over-draw it.
 */
providerRouter.post('/payouts', wrap(async (req, res) => {
  const u = me(req)
  const { amount } = z.object({ amount: z.number().int().positive() }).parse(req.body)
  await requireVerifiedProvider(u.id)
  if (amount < env.MIN_PAYOUT_KOBO) throw badRequest(`The minimum withdrawal is ${formatNaira(env.MIN_PAYOUT_KOBO)}`, 'BELOW_MINIMUM')
  const account = await prisma.payoutAccount.findUnique({ where: { userId: u.id } })
  if (!account) throw badRequest('Add your bank account before withdrawing', 'NO_PAYOUT_ACCOUNT')

  const payout = await prisma.$transaction(async (db) => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'payout:' + u.id}))`
    if (amount > (await availableToWithdraw(db, u.id))) throw conflict('Amount exceeds your payable balance', 'INSUFFICIENT_BALANCE')
    return db.payout.create({
      data: { providerId: u.id, amount, reference: `po_${crypto.randomBytes(8).toString('hex')}`, bankName: account.bankName, accountNumber: account.accountNumber, accountName: account.accountName },
    })
  })

  await notifyAdmins('PAYOUT_REQUESTED', 'Withdrawal to pay', `@${u.username} · ${formatNaira(payout.amount)} · ${account.bankName} ${account.accountNumber}`, '/admin/transactions')
  res.status(201).json({ id: payout.id, reference: payout.reference, amount: payout.amount, status: payout.status, arrivesWithinHours: 24 })
}))
