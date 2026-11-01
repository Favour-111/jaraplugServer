import { Router } from 'express'
import { prisma } from '../db'
import { env } from '../env'
import { wrap } from '../lib/errors'
import { searchIndexableProviderWhere } from '../services/seo'

export const seoRouter = Router()

// Public, indexable pages of the web app. `lastmod` only where we actually know when the page changed.
const STATIC_PAGES: { path: string; lastmod?: string }[] = [
  { path: '/' },
  { path: '/discover' },
  { path: '/terms', lastmod: '2026-10-25' },
  { path: '/privacy', lastmod: '2026-10-25' },
  { path: '/community-guidelines', lastmod: '2026-10-25' },
]

const MAX_URLS = 45_000 // the sitemap protocol allows 50,000 per file

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/**
 * XML sitemap for the web app. Served on the site's own domain through a Vercel rewrite (client/vercel.json),
 * so every <loc> uses SITE_URL rather than this API's host.
 */
seoRouter.get('/sitemap.xml', wrap(async (_req, res) => {
  const site = env.SITE_URL.replace(/\/$/, '')
  const providers = await prisma.user.findMany({
    where: searchIndexableProviderWhere,
    select: { username: true, providerProfile: { select: { updatedAt: true } } },
    orderBy: { createdAt: 'asc' },
    take: MAX_URLS - STATIC_PAGES.length,
  })

  const urls = [
    ...STATIC_PAGES.map((p) => ({ loc: site + p.path, lastmod: p.lastmod })),
    ...providers.map((p) => ({
      loc: `${site}/profile/${encodeURIComponent(p.username!)}`,
      lastmod: p.providerProfile?.updatedAt.toISOString(),
    })),
  ]
  const body = urls.map((u) => `  <url><loc>${xmlEscape(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n')

  res.set({ 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' })
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`)
}))
