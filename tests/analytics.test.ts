import { beforeEach, describe, expect, it } from 'vitest'
import { api, auth, makeAdmin, makeClient, prisma, resetAll } from './helpers'

beforeEach(resetAll)

const browser = (ua: string, ip: string) => ({ 'User-Agent': ua, 'X-Forwarded-For': ip })

describe('visitor counter', () => {
  it('counts each visitor once per day, adds up page views, and ignores bots', async () => {
    const a = browser('Mozilla/5.0 Chrome A', '1.1.1.1')
    await api().post('/api/track').set(a).send({}).expect(204)
    await api().post('/api/track').set(a).send({}).expect(204)
    await api().post('/api/track').set(browser('Mozilla/5.0 Safari B', '2.2.2.2')).send({}).expect(204)
    await api().post('/api/track').set(browser('Googlebot/2.1', '3.3.3.3')).send({}).expect(204)

    const rows = await prisma.dailyVisitor.findMany()
    expect(rows).toHaveLength(2)
    expect(rows.reduce((n, r) => n + r.views, 0)).toBe(3)

    const admin = await makeAdmin()
    const s = (await api().get('/api/admin/visitors').set(auth(admin)).expect(200)).body
    expect(s.today).toBe(2)
    expect(s.last30).toBe(2)
    expect(s.viewsToday).toBe(3)
    expect(s.series).toHaveLength(30)
  })

  it('stores no IP address or readable identifier', async () => {
    await api().post('/api/track').set(browser('Mozilla/5.0 Chrome A', '9.8.7.6')).send({}).expect(204)
    const [row] = await prisma.dailyVisitor.findMany()
    expect(JSON.stringify(row)).not.toContain('9.8.7.6')
    expect(row.visitorHash).toMatch(/^[0-9a-f]{32}$/)
  })

  it('shows visitor numbers to admins only', async () => {
    await api().get('/api/admin/visitors').expect(401)
    const c = await makeClient()
    await api().get('/api/admin/visitors').set(auth(c)).expect(403)
  })
})
