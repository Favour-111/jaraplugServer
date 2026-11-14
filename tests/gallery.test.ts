import { beforeEach, describe, expect, it } from 'vitest'
import { api, auth, makeClient, makeContent, makeProvider, prisma, resetAll } from './helpers'
import { shuffleFeed } from '../src/routes/gallery'

beforeEach(resetAll)

describe('gallery', () => {
  it('lists approved posts from listed providers and hides blocked providers', async () => {
    const c = await makeClient()
    const a = await makeProvider({ username: 'amara' })
    const b = await makeProvider({ username: 'bisi' })
    const older = await makeContent(a.id, { visibility: 'PUBLIC', price: 0, createdAt: new Date(Date.now() - 60_000) })
    const newer = await makeContent(b.id, { visibility: 'PUBLIC', price: 0 })
    await makeContent(a.id, { visibility: 'PUBLIC', price: 0, moderationStatus: 'PENDING' })
    // Premium and members-only posts never appear in the gallery.
    const paid = await makeContent(a.id, { visibility: 'PAID' })
    await makeContent(b.id, { visibility: 'FREE_MEMBERS', price: 0 })
    const r = await api().get('/api/gallery').set(auth(c)).expect(200)
    expect(r.body.items.map((i: any) => i.id).sort()).toEqual([newer.id, older.id].sort())
    expect(r.body.items.find((i: any) => i.id === newer.id)).toMatchObject({ provider: { username: 'bisi' }, likeCount: 0, liked: false, locked: false })

    await prisma.block.create({ data: { blockerId: c.id, blockedId: b.id } })
    const after = await api().get('/api/gallery').set(auth(c)).expect(200)
    expect(after.body.items.map((i: any) => i.id)).toEqual([older.id])
    await api().put(`/api/gallery/${paid.id}/like`).set(auth(c)).expect(404)
  })

  it('shuffles per session, keeps one session stable across pages, and spreads providers out', async () => {
    const c = await makeClient()
    const providers = await Promise.all(['amara', 'bisi', 'chi'].map((username) => makeProvider({ username })))
    for (const p of providers) for (let i = 0; i < 4; i++) await makeContent(p.id, { visibility: 'PUBLIC', price: 0 })
    const feed = async (seed: string) => {
      const ids: string[] = []
      const owners: string[] = []
      let cursor: string | null | undefined
      do {
        const r = await api().get('/api/gallery').query({ seed, limit: 5, ...(cursor ? { cursor } : {}) }).set(auth(c)).expect(200)
        for (const i of r.body.items) { ids.push(i.id); owners.push(i.provider.username) }
        cursor = r.body.nextCursor
      } while (cursor)
      return { ids, owners }
    }
    const a = await feed('one')
    expect(new Set(a.ids).size).toBe(12) // every post exactly once across pages
    expect(a.ids).toEqual((await feed('one')).ids) // same session → same order
    // The same person never appears twice in a row while others still have posts.
    for (let i = 1; i < a.owners.length; i++) expect(a.owners[i]).not.toBe(a.owners[i - 1])
    const orders = new Set<string>([a.ids.join()])
    for (const seed of ['two', 'three', 'four']) orders.add((await feed(seed)).ids.join())
    expect(orders.size).toBeGreaterThan(1) // new visits give new orders
  })

  it('shuffleFeed only repeats a provider back-to-back when nobody else is left', () => {
    const rows = [...Array(6)].map((_, i) => ({ id: `a${i}`, providerId: 'a' })).concat([{ id: 'b0', providerId: 'b' }])
    const out = shuffleFeed(rows, 'x')
    expect(out).toHaveLength(7)
    expect(new Set(out.map((r) => r.id)).size).toBe(7)
  })

  it('loves and un-loves a post', async () => {
    const c = await makeClient()
    const p = await makeProvider({ username: 'amara' })
    const item = await makeContent(p.id, { visibility: 'PUBLIC', price: 0 })
    expect((await api().put(`/api/gallery/${item.id}/like`).set(auth(c)).expect(200)).body).toEqual({ liked: true, likeCount: 1 })
    await api().put(`/api/gallery/${item.id}/like`).set(auth(c)).expect(200) // idempotent
    expect((await api().get('/api/gallery').set(auth(c))).body.items[0]).toMatchObject({ liked: true, likeCount: 1 })
    expect((await api().delete(`/api/gallery/${item.id}/like`).set(auth(c)).expect(200)).body).toEqual({ liked: false, likeCount: 0 })
  })

  it('is for clients only and never leaks unapproved posts', async () => {
    const p = await makeProvider({ username: 'amara' })
    const pending = await makeContent(p.id, { visibility: 'PUBLIC', price: 0, moderationStatus: 'PENDING' })
    await api().get('/api/gallery').set(auth(p)).expect(403)
    await api().put(`/api/gallery/${pending.id}/like`).set(auth(await makeClient())).expect(404)
  })
})
