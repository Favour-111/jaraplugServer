import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db'
import { badRequest, conflict, forbidden, notFound, wrap } from '../lib/errors'
import { me, requireAuth, requireRole } from '../auth'
import { audit } from '../services/audit'
import { notify } from '../services/notify'
import { formatNaira } from '../lib/money'
import { creditsToKobo, creditWallet, kobotoCredits } from '../services/credits'
import { getReferralSettings, saveReferralSettings } from '../services/referrals'
import { serializeContent } from '../services/content'
import { toUserSummary } from '../lib/serializers'

export const adminRouter = Router()
adminRouter.use(requireAuth, requireRole('ADMIN'))

const reason = z.string().trim().min(5, 'A reason (5+ characters) is required').max(500)

adminRouter.get('/overview', wrap(async (_req, res) => {
  const [users, providers, pendingVerifications, openReports, priorityReports, pendingContent, tx, support, payouts] = await Promise.all([
    prisma.user.count({ where: { accountStatus: 'ACTIVE' } }),
    prisma.user.count({ where: { role: 'PROVIDER', accountStatus: 'ACTIVE' } }),
    prisma.verificationRequest.count({ where: { status: 'PENDING' } }),
    prisma.report.count({ where: { status: { in: ['OPEN', 'INVESTIGATING'] } } }),
    prisma.report.count({ where: { status: { in: ['OPEN', 'INVESTIGATING'] }, priority: true } }),
    prisma.mediaContent.count({ where: { moderationStatus: { in: ['PENDING', 'UNDER_REVIEW'] }, status: 'PUBLISHED' } }),
    prisma.transaction.aggregate({ where: { status: 'SUCCESS', transactionType: 'CONTENT_PURCHASE' }, _sum: { amount: true, platformFee: true }, _count: true }),
    prisma.supportRequest.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
    prisma.payout.count({ where: { status: 'REQUESTED' } }),
  ])
  res.json({
    users, providers, pendingVerifications, openReports, priorityReports, pendingContent, openSupport: support, pendingPayouts: payouts,
    transactions: { count: tx._count, gross: tx._sum.amount ?? 0, platformRevenue: tx._sum.platformFee ?? 0 },
  })
}))

// ─── Users ───
// ─── Referral programme: pause/resume and tune the reward ───
adminRouter.get('/referrals', wrap(async (_req, res) => {
  const [settings, total, given, recent] = await Promise.all([
    getReferralSettings(),
    prisma.referral.count(),
    prisma.referral.aggregate({ _sum: { rewardCredits: true } }),
    prisma.referral.findMany({ orderBy: { createdAt: 'desc' }, take: 50, include: { referrer: { select: { username: true } }, referredUser: { select: { username: true } } } }),
  ])
  res.json({
    settings,
    creditKobo: creditsToKobo(1),
    stats: { referrals: total, creditsGiven: given._sum.rewardCredits ?? 0 },
    recent: recent.map((r) => ({ id: r.id, referrer: r.referrer.username, referred: r.referredUser.username, credits: r.rewardCredits, createdAt: r.createdAt })),
  })
}))

adminRouter.put('/referrals/settings', wrap(async (req, res) => {
  const admin = me(req)
  const next = z.object({
    enabled: z.boolean(),
    rewardCredits: z.number().int().min(1).max(1000),
    maxRewardsPerClient: z.number().int().min(0).max(1000),
  }).parse(req.body)
  const before = await getReferralSettings()
  await saveReferralSettings(next)
  await audit(admin.id, next.enabled ? (before.enabled ? 'REFERRAL_SETTINGS_CHANGED' : 'REFERRALS_RESUMED') : 'REFERRALS_PAUSED', 'Setting', 'referrals', 'Referral programme settings updated', { before, after: next })
  res.json({ ok: true, settings: next })
}))

// ─── TEMPORARY: give a client free credits (remove this route and the "Give credits" button in the admin Users page when done) ───
adminRouter.post('/users/:id/credits', wrap(async (req, res) => {
  const admin = me(req)
  const { credits, reason: why } = z.object({ credits: z.number().int().min(1).max(1000), reason }).parse(req.body)
  const balance = await prisma.$transaction(async (db) => {
    const target = await db.user.findUnique({ where: { id: String(req.params.id) } })
    if (!target || target.role !== 'CLIENT' || target.accountStatus !== 'ACTIVE') throw notFound('Active client not found')
    const b = await creditWallet(db, target.id, credits, 'TOPUP', {})
    await audit(admin.id, 'CREDITS_GRANTED', 'User', target.id, why, { credits }, db)
    return b
  })
  await notify(String(req.params.id), 'PURCHASE_COMPLETED', 'Credits added', `${credits} credit${credits === 1 ? '' : 's'} were added to your wallet.`, '/app/credits').catch(() => {})
  res.json({ ok: true, balance })
}))

adminRouter.get('/users', wrap(async (req, res) => {
  const q = z.object({ q: z.string().trim().max(60).optional(), role: z.enum(['CLIENT', 'PROVIDER', 'ADMIN', 'UNASSIGNED']).optional(), status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']).optional() }).parse(req.query)
  const where: Prisma.UserWhereInput = {
    ...(q.role ? { role: q.role } : {}), ...(q.status ? { accountStatus: q.status } : {}),
    ...(q.q ? { OR: [{ username: { contains: q.q, mode: 'insensitive' } }, { displayName: { contains: q.q, mode: 'insensitive' } }, { email: { contains: q.q, mode: 'insensitive' } }] } : {}),
  }
  const rows = await prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100, include: { providerProfile: { select: { verificationStatus: true } } } })
  res.json({
    items: rows.map((u) => ({
      id: u.id, username: u.username, displayName: u.displayName, email: u.email, role: u.role, accountStatus: u.accountStatus,
      ageVerificationStatus: u.ageVerificationStatus, verificationStatus: u.providerProfile?.verificationStatus ?? null,
      suspendedReason: u.suspendedReason, createdAt: u.createdAt, isDemo: u.isDemo,
    })),
  })
}))

adminRouter.post('/users/:id/suspend', wrap(async (req, res) => {
  const admin = me(req)
  const { reason: why } = z.object({ reason }).parse(req.body)
  const target = await prisma.user.findUnique({ where: { id: String(req.params.id) } })
  if (!target) throw notFound('User not found')
  if (target.role === 'ADMIN') throw forbidden('Administrators cannot be suspended here')
  if (target.accountStatus === 'DELETED') throw conflict('Account already deleted')
  await prisma.$transaction([
    prisma.user.update({ where: { id: target.id }, data: { accountStatus: 'SUSPENDED', suspendedReason: why } }),
    audit(admin.id, 'USER_SUSPENDED', 'User', target.id, why) as any,
  ])
  res.json({ ok: true })
}))

adminRouter.post('/users/:id/reactivate', wrap(async (req, res) => {
  const admin = me(req)
  const { reason: why } = z.object({ reason }).parse(req.body)
  const target = await prisma.user.findUnique({ where: { id: String(req.params.id) } })
  if (!target || target.accountStatus !== 'SUSPENDED') throw notFound('Suspended user not found')
  await prisma.$transaction([
    prisma.user.update({ where: { id: target.id }, data: { accountStatus: 'ACTIVE', suspendedReason: null } }),
    audit(admin.id, 'USER_REACTIVATED', 'User', target.id, why) as any,
  ])
  res.json({ ok: true })
}))

// ─── Verifications ───
adminRouter.get('/verifications', wrap(async (req, res) => {
  const { status } = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING') }).parse(req.query)
  const rows = await prisma.verificationRequest.findMany({
    where: { status }, orderBy: { createdAt: 'asc' }, take: 100,
    include: { user: { include: { providerProfile: true } } },
  })
  res.json({
    items: await Promise.all(rows.map(async (r) => ({
      id: r.id, type: r.type, status: r.status, providerRef: r.providerRef, createdAt: r.createdAt, rejectionReason: r.rejectionReason,
      user: await toUserSummary(r.user),
      profile: r.user.providerProfile ? { biography: r.user.providerProfile.biography, city: r.user.providerProfile.city, displayAge: r.user.providerProfile.displayAge } : null,
    }))),
  })
}))

adminRouter.post('/verifications/:id/approve', wrap(async (req, res) => {
  const admin = me(req)
  const note = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {}).reason
  const r = await prisma.verificationRequest.findUnique({ where: { id: String(req.params.id) } })
  if (!r) throw notFound('Request not found')
  if (r.status !== 'PENDING') throw conflict('Already reviewed')
  await prisma.$transaction(async (db) => {
    await db.verificationRequest.update({ where: { id: r.id }, data: { status: 'APPROVED', reviewedById: admin.id, reviewedAt: new Date() } })
    await db.user.update({ where: { id: r.userId }, data: { ageVerificationStatus: 'VERIFIED' } })
    if (r.type === 'PROVIDER_IDENTITY') await db.providerProfile.update({ where: { userId: r.userId }, data: { verificationStatus: 'VERIFIED' } })
    await audit(admin.id, 'VERIFICATION_APPROVED', 'VerificationRequest', r.id, note, { type: r.type, userId: r.userId }, db)
  })
  await notify(r.userId, 'VERIFICATION', 'You are verified ✅', r.type === 'PROVIDER_IDENTITY' ? 'Your profile is now live.' : 'You can now message, book and purchase.')
  res.json({ ok: true })
}))

adminRouter.post('/verifications/:id/reject', wrap(async (req, res) => {
  const admin = me(req)
  const { reason: why } = z.object({ reason }).parse(req.body)
  const r = await prisma.verificationRequest.findUnique({ where: { id: String(req.params.id) } })
  if (!r) throw notFound('Request not found')
  if (r.status !== 'PENDING') throw conflict('Already reviewed')
  await prisma.$transaction(async (db) => {
    await db.verificationRequest.update({ where: { id: r.id }, data: { status: 'REJECTED', rejectionReason: why, reviewedById: admin.id, reviewedAt: new Date() } })
    await db.user.update({ where: { id: r.userId }, data: { ageVerificationStatus: 'REJECTED' } })
    if (r.type === 'PROVIDER_IDENTITY') await db.providerProfile.update({ where: { userId: r.userId }, data: { verificationStatus: 'REJECTED' } })
    await audit(admin.id, 'VERIFICATION_REJECTED', 'VerificationRequest', r.id, why, { type: r.type, userId: r.userId }, db)
  })
  await notify(r.userId, 'VERIFICATION', 'Verification not approved', why)
  res.json({ ok: true })
}))

// ─── Content moderation ───
adminRouter.get('/content', wrap(async (req, res) => {
  const { status } = z.object({ status: z.enum(['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'REMOVED']).default('PENDING') }).parse(req.query)
  const admin = me(req)
  const rows = await prisma.mediaContent.findMany({
    where: { moderationStatus: status, ...(status === 'PENDING' ? { status: 'PUBLISHED' } : {}) },
    orderBy: { createdAt: 'asc' }, take: 100,
    include: { provider: { select: { id: true, username: true, displayName: true } }, _count: { select: { reports: true } } },
  })
  res.json({ items: await Promise.all(rows.map(async (c) => ({ ...(await serializeContent(c, admin)), provider: c.provider, reportCount: c._count.reports }))) })
}))

adminRouter.post('/content/:id/moderate', wrap(async (req, res) => {
  const admin = me(req)
  const body = z.object({ action: z.enum(['approve', 'reject', 'remove']), reason: z.string().trim().max(500).optional() }).parse(req.body)
  if (body.action !== 'approve' && !body.reason) throw badRequest('A reason is required to reject or remove content')
  const c = await prisma.mediaContent.findUnique({ where: { id: String(req.params.id) } })
  if (!c) throw notFound('Content not found')
  const next = body.action === 'approve' ? 'APPROVED' : body.action === 'reject' ? 'REJECTED' : 'REMOVED'
  await prisma.$transaction([
    prisma.mediaContent.update({ where: { id: c.id }, data: { moderationStatus: next, moderationNote: body.reason ?? null } }),
    audit(admin.id, `CONTENT_${next}`, 'MediaContent', c.id, body.reason) as any,
  ])
  await notify(c.providerId, 'MODERATION', next === 'APPROVED' ? 'Content approved' : `Content ${next.toLowerCase()}`, `“${c.title}”${body.reason ? ` — ${body.reason}` : ''}`, '/provider/content')
  res.json({ ok: true, moderationStatus: next })
}))

// ─── Reports ───
adminRouter.get('/reports', wrap(async (req, res) => {
  const { status } = z.object({ status: z.enum(['OPEN', 'INVESTIGATING', 'RESOLVED', 'DISMISSED']).optional() }).parse(req.query)
  const rows = await prisma.report.findMany({
    where: status ? { status } : { status: { in: ['OPEN', 'INVESTIGATING'] } },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }], take: 100,
    include: {
      reporter: { select: { id: true, username: true } }, reportedUser: { select: { id: true, username: true, displayName: true, accountStatus: true } },
      reportedContent: { select: { id: true, title: true, moderationStatus: true } },
    },
  })
  res.json({ items: rows })
}))

adminRouter.post('/reports/:id/resolve', wrap(async (req, res) => {
  const admin = me(req)
  const body = z.object({ status: z.enum(['INVESTIGATING', 'RESOLVED', 'DISMISSED']), note: reason }).parse(req.body)
  const r = await prisma.report.findUnique({ where: { id: String(req.params.id) } })
  if (!r) throw notFound('Report not found')
  await prisma.$transaction([
    prisma.report.update({ where: { id: r.id }, data: { status: body.status, resolutionNote: body.note, resolvedAt: body.status === 'INVESTIGATING' ? null : new Date() } }),
    audit(admin.id, `REPORT_${body.status}`, 'Report', r.id, body.note, { category: r.category }) as any,
  ])
  if (body.status !== 'INVESTIGATING') await notify(r.reporterId, 'REPORT', 'Your report was reviewed', 'Thank you for helping keep JaraPlug safe.')
  res.json({ ok: true })
}))

// ─── Transactions, refunds, payouts ───
adminRouter.get('/transactions', wrap(async (_req, res) => {
  const rows = await prisma.transaction.findMany({
    orderBy: { createdAt: 'desc' }, take: 200,
    include: { user: { select: { username: true } }, payee: { select: { username: true } } },
  })
  res.json({ items: rows.map((t) => ({ id: t.id, reference: t.providerReference, buyer: t.user.username, provider: t.payee?.username ?? null, amount: t.amount, platformFee: t.platformFee, processingFee: t.processingFee, netAmount: t.netAmount, status: t.status, createdAt: t.createdAt, paidAt: t.paidAt })) })
}))

adminRouter.post('/transactions/:id/refund', wrap(async (req, res) => {
  const admin = me(req)
  const { reason: why } = z.object({ reason }).parse(req.body)
  await prisma.$transaction(async (db) => {
    const t = await db.transaction.findUnique({ where: { id: String(req.params.id) } })
    if (!t) throw notFound('Transaction not found')
    if (t.status !== 'SUCCESS') throw conflict('Only successful transactions can be refunded')
    if (t.transactionType === 'CREDIT_TOPUP') throw conflict('Credit top-ups are refunded through the payment provider, not here', 'TOPUP_NOT_REFUNDABLE')
    await db.transaction.update({ where: { id: t.id }, data: { status: 'REFUNDED', refundedAt: new Date() } })
    await db.contentPurchase.updateMany({ where: { transactionId: t.id }, data: { status: 'REFUNDED' } })
    // A purchase made with credits is refunded back into the buyer's wallet.
    if (t.provider === 'credits') {
      const credits = kobotoCredits(t.amount)
      if (credits) await creditWallet(db, t.userId, credits, 'REFUND', { transactionId: t.id, contentId: t.contentId ?? undefined })
    }
    await audit(admin.id, 'TRANSACTION_REFUNDED', 'Transaction', t.id, why, { amount: t.amount }, db)
  })
  res.json({ ok: true, note: 'Ledger updated and access revoked. Credit purchases are returned to the buyer\'s wallet automatically.' })
}))

adminRouter.get('/payouts', wrap(async (_req, res) => {
  const rows = await prisma.payout.findMany({ orderBy: { requestedAt: 'desc' }, take: 100, include: { provider: { select: { username: true } } } })
  res.json({ items: rows.map((p) => ({ id: p.id, provider: p.provider.username, amount: p.amount, status: p.status, reference: p.reference, bankName: p.bankName, accountNumber: p.accountNumber, accountName: p.accountName, requestedAt: p.requestedAt, paidAt: p.paidAt })) })
}))
adminRouter.post('/payouts/:id/decide', wrap(async (req, res) => {
  const admin = me(req)
  const body = z.object({ decision: z.enum(['paid', 'rejected']), reason }).parse(req.body)
  const p = await prisma.payout.findUnique({ where: { id: String(req.params.id) } })
  if (!p || p.status !== 'REQUESTED') throw notFound('Pending payout not found')
  await prisma.$transaction([
    prisma.payout.update({ where: { id: p.id }, data: { status: body.decision === 'paid' ? 'PAID' : 'REJECTED', paidAt: body.decision === 'paid' ? new Date() : null, note: body.reason } }),
    audit(admin.id, `PAYOUT_${body.decision.toUpperCase()}`, 'Payout', p.id, body.reason, { amount: p.amount }) as any,
  ])
  await notify(p.providerId, 'PAYOUT', body.decision === 'paid' ? 'Payout sent' : 'Payout rejected', body.reason, '/provider/earnings')
  res.json({ ok: true })
}))

// ─── Support ───
adminRouter.get('/support', wrap(async (_req, res) => {
  const rows = await prisma.supportRequest.findMany({ orderBy: [{ status: 'asc' }, { createdAt: 'asc' }], take: 100, include: { user: { select: { username: true } } } })
  res.json({ items: rows })
}))
adminRouter.post('/support/:id/respond', wrap(async (req, res) => {
  const admin = me(req)
  const body = z.object({ response: z.string().trim().min(2).max(2000), status: z.enum(['IN_PROGRESS', 'CLOSED']) }).parse(req.body)
  const s = await prisma.supportRequest.findUnique({ where: { id: String(req.params.id) } })
  if (!s) throw notFound('Request not found')
  await prisma.$transaction([
    prisma.supportRequest.update({ where: { id: s.id }, data: { adminResponse: body.response, status: body.status } }),
    audit(admin.id, 'SUPPORT_RESPONDED', 'SupportRequest', s.id, body.response.slice(0, 200)) as any,
  ])
  await notify(s.userId, 'SUPPORT', 'Support replied to your request', s.subject)
  res.json({ ok: true })
}))

adminRouter.get('/audit-logs', wrap(async (_req, res) => {
  const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 200, include: { administrator: { select: { username: true } } } })
  res.json({ items: rows.map((l) => ({ id: l.id, admin: l.administrator.username, action: l.action, targetType: l.targetType, targetId: l.targetId, reason: l.reason, createdAt: l.createdAt })) })
}))
