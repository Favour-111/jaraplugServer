import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db'
import { notFound, wrap } from '../lib/errors'
import { me, requireAuth, requireRole } from '../auth'
import { toUserSummary } from '../lib/serializers'
import { serializeContent, isListable } from '../services/content'
import { blockedIdsFor } from '../services/blocks'

/** Gallery: a full-screen, newest-first feed of photos and videos from listed providers, with "loves". */
export const galleryRouter = Router()
galleryRouter.use(requireAuth, requireRole('CLIENT'))

// Same rule as Discover: only active, verified, non-hidden providers appear.
const listedProvider = { accountStatus: 'ACTIVE' as const, role: 'PROVIDER' as const, providerProfile: { is: { verificationStatus: 'VERIFIED' as const, visibility: { not: 'HIDDEN' as const } } } }

galleryRouter.get('/', wrap(async (req, res) => {
  const u = me(req)
  const q = z.object({ cursor: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(20).default(8) }).parse(req.query)
  const blocked = await blockedIdsFor(u.id)
  const rows = await prisma.mediaContent.findMany({
    // Public posts only: paid and members-only content stays on the provider's profile.
    where: { visibility: 'PUBLIC', status: 'PUBLISHED', moderationStatus: 'APPROVED', providerId: { notIn: blocked }, provider: listedProvider },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    include: { provider: { include: { providerProfile: true } }, _count: { select: { likes: true } } },
  })
  const page = rows.slice(0, q.limit)
  const liked = new Set((await prisma.contentLike.findMany({ where: { userId: u.id, contentId: { in: page.map((c) => c.id) } }, select: { contentId: true } })).map((l) => l.contentId))
  const items = await Promise.all(page.map(async ({ provider, _count, ...c }) => ({
    ...(await serializeContent(c, u)),
    provider: await toUserSummary(provider),
    likeCount: _count.likes,
    liked: liked.has(c.id),
  })))
  res.json({ items, nextCursor: rows.length > q.limit ? page[page.length - 1].id : null })
}))

/** Loads an item the viewer may see in the gallery, or 404s (also for blocked pairs). */
async function galleryItem(userId: string, id: string) {
  const c = await prisma.mediaContent.findFirst({ where: { id, visibility: 'PUBLIC', provider: listedProvider } })
  if (!c || !isListable(c) || (await blockedIdsFor(userId)).includes(c.providerId)) throw notFound('Post not found')
  return c
}
const likeCount = (contentId: string) => prisma.contentLike.count({ where: { contentId } })

galleryRouter.put('/:id/like', wrap(async (req, res) => {
  const u = me(req)
  const c = await galleryItem(u.id, String(req.params.id))
  await prisma.contentLike.upsert({ where: { userId_contentId: { userId: u.id, contentId: c.id } }, update: {}, create: { userId: u.id, contentId: c.id } })
  res.json({ liked: true, likeCount: await likeCount(c.id) })
}))

galleryRouter.delete('/:id/like', wrap(async (req, res) => {
  const u = me(req)
  const c = await galleryItem(u.id, String(req.params.id))
  await prisma.contentLike.deleteMany({ where: { userId: u.id, contentId: c.id } })
  res.json({ liked: false, likeCount: await likeCount(c.id) })
}))
