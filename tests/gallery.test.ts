import { beforeEach, describe, expect, it } from 'vitest'
import { api, auth, makeClient, makeContent, makeProvider, prisma, resetAll } from './helpers'

beforeEach(resetAll)

describe('gallery', () => {
  it('lists approved posts from listed providers, newest first, and hides blocked providers', async () => {
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
    expect(r.body.items.map((i: any) => i.id)).toEqual([newer.id, older.id])
    expect(r.body.items[0]).toMatchObject({ provider: { username: 'bisi' }, likeCount: 0, liked: false, locked: false })

    await prisma.block.create({ data: { blockerId: c.id, blockedId: b.id } })
    const after = await api().get('/api/gallery').set(auth(c)).expect(200)
    expect(after.body.items.map((i: any) => i.id)).toEqual([older.id])
    await api().put(`/api/gallery/${paid.id}/like`).set(auth(c)).expect(404)
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
