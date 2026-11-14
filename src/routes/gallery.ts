import crypto from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db'
import { notFound, wrap } from '../lib/errors'
import { me, requireAuth, requireRole } from '../auth'
import { toUserSummary } from '../lib/serializers'
import { serializeContent, isListable } from '../services/content'
import { blockedIdsFor } from '../services/blocks'

/** Gallery: a full-screen, shuffled feed of photos and videos from listed providers, with "loves". */
export const galleryRouter = Router()
galleryRouter.use(requireAuth, requireRole('CLIENT'))

// Same rule as Discover: only active, non-hidden providers appear (no review needed to go public).
const listedProvider = { accountStatus: 'ACTIVE' as const, role: 'PROVIDER' as const, providerProfile: { is: { visibility: { not: 'HIDDEN' as const } } } }

/** Deterministic PRNG (mulberry32) so one feed session gets the same order on every page. */
function rng(seed: string) {
  let a = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0)
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Shuffles the feed for one session and spreads providers out: every post is placed by a seeded random draw,
 * weighted by how many posts each provider has left, never picking the same provider twice in a row when another
 * one is available. A new seed (each visit to the gallery) gives a new order, so the feed doesn't always open on
 * the same picture or show one person's posts in a block.
 */
export function shuffleFeed<T extends { id: string; providerId: string }>(rows: T[], seed: string): T[] {
  const rand = rng(seed)
  const byProvider = new Map<string, T[]>()
  for (const r of rows) byProvider.set(r.providerId, [...(byProvider.get(r.providerId) ?? []), r])
  for (const list of byProvider.values()) {
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [list[i], list[j]] = [list[j], list[i]] }
  }
  const out: T[] = []
  let last: string | null = null
  while (out.length < rows.length) {
    const open: [string, T[]][] = [...byProvider.entries()].filter(([, l]) => l.length)
    const remaining = rows.length - out.length
    const biggest = open.reduce((a, b) => (b[1].length > a[1].length ? b : a))
    // If one provider has more posts left than everyone else combined, place theirs now or they'd end up in a block.
    const forced: boolean = biggest[0] !== last && biggest[1].length * 2 > remaining
    const choices: [string, T[]][] = forced ? [biggest] : open.length > 1 ? open.filter(([pid]) => pid !== last) : open
    let pick = rand() * choices.reduce((n: number, [, l]) => n + l.length, 0)
    const [pid, list]: [string, T[]] = choices.find(([, l]) => (pick -= l.length) < 0) ?? choices[choices.length - 1]
    out.push(list.shift()!)
    last = pid
  }
  return out
}

const FEED_POOL = 2000 // newest public posts considered for the shuffled feed

galleryRouter.get('/', wrap(async (req, res) => {
  const u = me(req)
  const q = z.object({
    // Random per gallery visit (sent by the app); without it the order still changes daily.
    seed: z.string().max(64).optional(),
    cursor: z.coerce.number().int().min(0).max(FEED_POOL).optional(),
    limit: z.coerce.number().int().min(1).max(20).default(8),
  }).parse(req.query)
  const blocked = await blockedIdsFor(u.id)
  // Public posts only: paid and members-only content stays on the provider's profile.
  const where = { visibility: 'PUBLIC' as const, status: 'PUBLISHED' as const, moderationStatus: 'APPROVED' as const, providerId: { notIn: blocked }, provider: listedProvider }
  const pool = await prisma.mediaContent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: FEED_POOL, select: { id: true, providerId: true } })
  const order = shuffleFeed(pool, `${u.id}:${q.seed ?? new Date().toISOString().slice(0, 10)}`)
  const offset = q.cursor ?? 0
  const ids = order.slice(offset, offset + q.limit).map((r) => r.id)
  const rows = await prisma.mediaContent.findMany({
    where: { id: { in: ids } },
    include: { provider: { include: { providerProfile: true } }, _count: { select: { likes: true } } },
  })
  const byId = new Map(rows.map((r) => [r.id, r]))
  const page = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r)
  const liked = new Set((await prisma.contentLike.findMany({ where: { userId: u.id, contentId: { in: ids } }, select: { contentId: true } })).map((l) => l.contentId))
  const items = await Promise.all(page.map(async ({ provider, _count, ...c }) => ({
    ...(await serializeContent(c, u)),
    provider: await toUserSummary(provider),
    likeCount: _count.likes,
    liked: liked.has(c.id),
  })))
  const next = offset + q.limit
  res.json({ items, nextCursor: next < order.length ? String(next) : null })
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
