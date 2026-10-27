import crypto from 'node:crypto'
import type { Request } from 'express'
import { prisma } from '../db'
import { env } from '../env'

const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|monitor|uptime|curl|wget|python-requests/i

/** YYYY-MM-DD in Lagos time, `daysAgo` days back. */
export function lagosDay(daysAgo = 0, now = Date.now()) {
  return new Date(now + 3_600_000 - daysAgo * 86_400_000).toISOString().slice(0, 10) // Africa/Lagos is UTC+1, no DST
}

/**
 * Counts one page view for an anonymous visitor. Never throws: analytics must not break the site.
 * Returns false when the request was ignored (bots, missing user agent).
 */
export async function recordVisit(req: Request): Promise<boolean> {
  const ua = String(req.headers['user-agent'] ?? '')
  if (!ua || BOT.test(ua)) return false
  const day = lagosDay()
  const visitorHash = crypto.createHmac('sha256', env.MEDIA_SIGNING_SECRET).update(`${day}|${req.ip ?? ''}|${ua}`).digest('hex').slice(0, 32)
  try {
    await prisma.dailyVisitor.upsert({
      where: { day_visitorHash: { day, visitorHash } },
      create: { day, visitorHash },
      update: { views: { increment: 1 } },
    })
    return true
  } catch (e) {
    console.error('visit tracking failed', e)
    return false
  }
}

export async function visitorStats(days = 30) {
  const since = lagosDay(days - 1)
  const rows = await prisma.dailyVisitor.groupBy({ by: ['day'], where: { day: { gte: since } }, _count: { _all: true }, _sum: { views: true } })
  const byDay = new Map(rows.map((r) => [r.day, { visitors: r._count._all, views: r._sum.views ?? 0 }]))
  const series = Array.from({ length: days }, (_, i) => {
    const day = lagosDay(days - 1 - i)
    return { day, visitors: byDay.get(day)?.visitors ?? 0, views: byDay.get(day)?.views ?? 0 }
  })
  const sum = (n: number, k: 'visitors' | 'views') => series.slice(-n).reduce((a, d) => a + d[k], 0)
  return {
    today: series[series.length - 1]?.visitors ?? 0,
    yesterday: series[series.length - 2]?.visitors ?? 0,
    last7: sum(7, 'visitors'),
    last30: sum(days, 'visitors'),
    viewsToday: series[series.length - 1]?.views ?? 0,
    views30: sum(days, 'views'),
    series,
  }
}
