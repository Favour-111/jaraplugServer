import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db'
import { AUTO_HIDE_REPORT_CATEGORIES, PRIORITY_REPORT_CATEGORIES } from '../config/constants'
import { badRequest, notFound, wrap } from '../lib/errors'
import { me, requireAuth } from '../auth'
import { toProviderCard, toUserSummary } from '../lib/serializers'
import { notifyAdmins } from '../services/notify'

export const socialRouter = Router()
socialRouter.use(requireAuth)

// ─── Favourites ───
socialRouter.get('/favorites', wrap(async (req, res) => {
  const u = me(req)
  const rows = await prisma.favorite.findMany({
    where: { userId: u.id, provider: { accountStatus: 'ACTIVE', providerProfile: { is: { verificationStatus: 'VERIFIED', visibility: { not: 'HIDDEN' } } } } },
    orderBy: { createdAt: 'desc' },
    include: { provider: { include: { providerProfile: true } } },
  })
  const blocks = new Set((await prisma.block.findMany({ where: { OR: [{ blockerId: u.id }, { blockedId: u.id }] } })).flatMap((b) => [b.blockerId, b.blockedId]))
  const items = await Promise.all(rows.filter((r) => !blocks.has(r.providerId)).map((r) => toProviderCard(r.provider, r.provider.providerProfile!, { isFavorite: true })))
  res.json({ items })
}))

socialRouter.put('/favorites/:providerId', wrap(async (req, res) => {
  const u = me(req)
  const providerId = String(req.params.providerId)
  const p = await prisma.user.findFirst({ where: { id: providerId, role: 'PROVIDER', accountStatus: 'ACTIVE' } })
  if (!p) throw notFound('Provider not found')
  await prisma.favorite.upsert({ where: { userId_providerId: { userId: u.id, providerId } }, update: {}, create: { userId: u.id, providerId } })
  res.json({ ok: true })
}))
socialRouter.delete('/favorites/:providerId', wrap(async (req, res) => {
  await prisma.favorite.deleteMany({ where: { userId: me(req).id, providerId: String(req.params.providerId) } })
  res.json({ ok: true })
}))

// ─── Blocking ───
socialRouter.get('/blocks', wrap(async (req, res) => {
  const rows = await prisma.block.findMany({ where: { blockerId: me(req).id }, include: { blocked: { include: { providerProfile: true } } }, orderBy: { createdAt: 'desc' } })
  res.json({ items: await Promise.all(rows.map((r) => toUserSummary(r.blocked))) })
}))
socialRouter.post('/blocks', wrap(async (req, res) => {
  const u = me(req)
  const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body)
  if (userId === u.id) throw badRequest('You cannot block yourself')
  const target = await prisma.user.findUnique({ where: { id: userId } })
  if (!target || target.role === 'ADMIN') throw notFound('User not found')
  await prisma.$transaction([
    prisma.block.upsert({ where: { blockerId_blockedId: { blockerId: u.id, blockedId: userId } }, update: {}, create: { blockerId: u.id, blockedId: userId } }),
    prisma.favorite.deleteMany({ where: { OR: [{ userId: u.id, providerId: userId }, { userId, providerId: u.id }] } }),
    // Pending requests between the two users are withdrawn.
    prisma.booking.updateMany({
      where: { status: 'PENDING', OR: [{ clientId: u.id, providerId: userId }, { clientId: userId, providerId: u.id }] },
      data: { status: 'CANCELLED', declineReason: 'Blocked' },
    }),
  ])
  res.status(201).json({ ok: true })
}))
socialRouter.delete('/blocks/:userId', wrap(async (req, res) => {
  await prisma.block.deleteMany({ where: { blockerId: me(req).id, blockedId: String(req.params.userId) } })
  res.json({ ok: true })
}))

// ─── Reports ───
const reportSchema = z.object({
  reportedUserId: z.string().optional(),
  reportedContentId: z.string().optional(),
  category: z.enum(['NON_CONSENSUAL_IMAGERY', 'UNDERAGE', 'EXPLOITATION', 'IMPERSONATION', 'HARASSMENT', 'SPAM_OR_SCAM', 'OTHER']),
  description: z.string().trim().max(1000).default(''),
})
socialRouter.post('/reports', wrap(async (req, res) => {
  const u = me(req)
  const body = reportSchema.parse(req.body)
  if (!body.reportedUserId && !body.reportedContentId) throw badRequest('Say who or what you are reporting')
  let reportedUserId = body.reportedUserId
  if (body.reportedContentId) {
    const c = await prisma.mediaContent.findUnique({ where: { id: body.reportedContentId } })
    if (!c) throw notFound('Content not found')
    reportedUserId = reportedUserId ?? c.providerId
  }
  if (reportedUserId === u.id) throw badRequest('You cannot report yourself')
  if (reportedUserId && !(await prisma.user.findUnique({ where: { id: reportedUserId } }))) throw notFound('User not found')

  const priority = (PRIORITY_REPORT_CATEGORIES as readonly string[]).includes(body.category)
  const hide = (AUTO_HIDE_REPORT_CATEGORIES as readonly string[]).includes(body.category)
  const report = await prisma.$transaction(async (db) => {
    const r = await db.report.create({ data: { reporterId: u.id, reportedUserId, reportedContentId: body.reportedContentId, category: body.category, description: body.description, priority } })
    // Suspected non-consensual / underage / exploitative media is pulled from view immediately, pending human review.
    if (hide && body.reportedContentId) {
      await db.mediaContent.updateMany({ where: { id: body.reportedContentId, moderationStatus: { not: 'REMOVED' } }, data: { moderationStatus: 'UNDER_REVIEW', moderationNote: 'Hidden pending review of a safety report' } })
    }
    return r
  })
  await notifyAdmins('REPORT', priority ? '🚨 Priority safety report' : 'New user report', body.category.replaceAll('_', ' ').toLowerCase(), '/admin/reports')
  res.status(201).json({ id: report.id, status: report.status })
}))

// ─── Notifications ───
socialRouter.get('/notifications', wrap(async (req, res) => {
  const items = await prisma.notification.findMany({ where: { userId: me(req).id }, orderBy: { createdAt: 'desc' }, take: 50 })
  res.json({ items, unread: items.filter((n) => !n.readAt).length })
}))
socialRouter.post('/notifications/read', wrap(async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.string()).optional() }).parse(req.body ?? {})
  await prisma.notification.updateMany({ where: { userId: me(req).id, readAt: null, ...(ids ? { id: { in: ids } } : {}) }, data: { readAt: new Date() } })
  res.json({ ok: true })
}))

// ─── Support (disputes, privacy & consent complaints) ───
socialRouter.get('/support', wrap(async (req, res) => {
  res.json({ items: await prisma.supportRequest.findMany({ where: { userId: me(req).id }, orderBy: { createdAt: 'desc' }, take: 50 }) })
}))
socialRouter.post('/support', wrap(async (req, res) => {
  const u = me(req)
  const body = z.object({ subject: z.string().trim().min(3).max(120), body: z.string().trim().min(10).max(2000), relatedTransactionId: z.string().optional() }).parse(req.body)
  if (body.relatedTransactionId) {
    const tx = await prisma.transaction.findUnique({ where: { id: body.relatedTransactionId } })
    if (!tx || (tx.userId !== u.id && tx.payeeId !== u.id)) throw notFound('Transaction not found')
  }
  const r = await prisma.supportRequest.create({ data: { userId: u.id, ...body } })
  await notifyAdmins('SUPPORT', 'New support request', body.subject, '/admin/support')
  res.status(201).json(r)
}))
