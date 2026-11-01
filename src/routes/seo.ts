import { Router } from 'express'
import { prisma } from '../db'
import { env } from '../env'
import { wrap } from '../lib/errors'
import { searchIndexableProviderWhere } from '../services/seo'

export const seoRouter = Router()

const MAX_URLS = 50_000 // sitemap protocol limit per file

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/**
 * XML sitemap of creator profiles whose owners opted in to search engines. Served on the site's own domain as
 * /sitemap-profiles.xml through a Vercel rewrite (client/vercel.json), so every <loc> uses SITE_URL rather than this
 * API's host. The static public pages are listed in client/public/sitemap.xml.
 */
seoRouter.get('/sitemap-profiles.xml', wrap(async (_req, res) => {
  const site = env.SITE_URL.replace(/\/$/, '')
  const providers = await prisma.user.findMany({
    where: searchIndexableProviderWhere,
    select: { username: true, providerProfile: { select: { updatedAt: true } } },
    orderBy: { createdAt: 'asc' },
    take: MAX_URLS,
  })

  const urls = providers.map((p) => ({ loc: `${site}/profile/${encodeURIComponent(p.username!)}`, lastmod: p.providerProfile?.updatedAt.toISOString() }))
  // The sitemap schema requires at least one <url>; until a creator opts in, point at the profile directory instead.
  if (!urls.length) urls.push({ loc: `${site}/discover`, lastmod: undefined })
  const body = urls.map((u) => `  <url><loc>${xmlEscape(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n')

  res.set({ 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' })
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`)
}))
