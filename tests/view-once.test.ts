import { beforeEach, describe, expect, it } from 'vitest'
import { api, auth, makeClient, makeProvider, png, prisma, resetAll } from './helpers'
import { purgeViewedMedia } from '../src/services/messaging'
import { resolveLocalPath } from '../src/storage'
import fs from 'node:fs'

beforeEach(resetAll)

const fakeMp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(200)])

async function setup() {
  const c = await makeClient()
  const p = await makeProvider({ username: 'amara' })
  const id = (await api().post('/api/conversations').set(auth(c)).send({ username: 'amara' }).expect(200)).body.id as string
  return { c, p, id }
}
const sendPhoto = async (as: any, id: string, viewOnce: boolean) =>
  (await api().post(`/api/conversations/${id}/attachments`).set(auth(as)).field('viewOnce', String(viewOnce)).attach('file', await png(), { filename: 'a.png', contentType: 'image/png' }).expect(201)).body
const path = (url: string) => new URL(url).pathname

describe('view-once photos and videos', () => {
  it('never exposes a link in the message list, to the sender or the recipient', async () => {
    const { c, p, id } = await setup()
    const m = await sendPhoto(c, id, true)
    expect(m.viewOnce).toBe(true)
    expect(m.attachmentUrl).toBeNull()
    for (const u of [c, p]) {
      const list = (await api().get(`/api/conversations/${id}/messages`).set(auth(u)).expect(200)).body.messages
      expect(list[0]).toMatchObject({ viewOnce: true, attachmentUrl: null, viewedAt: null })
    }
    const convs = (await api().get('/api/conversations').set(auth(p)).expect(200)).body.items
    expect(convs[0].lastMessage.body).toBe('🔒 View once photo')
  })

  it('lets the recipient open it exactly once, then it is gone', async () => {
    const { c, p, id } = await setup()
    const m = await sendPhoto(c, id, true)
    const first = await api().post(`/api/conversations/${id}/messages/${m.id}/view`).set(auth(p)).expect(200)
    expect(first.body.expiresInSeconds).toBeGreaterThan(0)
    await api().get(path(first.body.url)).expect(200)
    const again = await api().post(`/api/conversations/${id}/messages/${m.id}/view`).set(auth(p)).expect(410)
    expect(again.body.code).toBe('VIEW_ONCE_CONSUMED')
    const list = (await api().get(`/api/conversations/${id}/messages`).set(auth(c))).body.messages
    expect(list[0].viewedAt).toBeTruthy()
  })

  it('only one of two simultaneous opens succeeds', async () => {
    const { c, p, id } = await setup()
    const m = await sendPhoto(c, id, true)
    const results = await Promise.all([1, 2, 3].map(() => api().post(`/api/conversations/${id}/messages/${m.id}/view`).set(auth(p))))
    expect(results.map((r) => r.status).sort()).toEqual([200, 410, 410])
  })

  it('does not let the sender or an outsider open it', async () => {
    const { c, p, id } = await setup()
    const m = await sendPhoto(c, id, true)
    await api().post(`/api/conversations/${id}/messages/${m.id}/view`).set(auth(c)).expect(403)
    const stranger = await makeClient()
    await api().post(`/api/conversations/${id}/messages/${m.id}/view`).set(auth(stranger)).expect(404)
    await api().post(`/api/conversations/${id}/messages/${m.id}/view`).expect(401)
    // a failed attempt by the sender or a stranger must not use up the recipient's one view
    await api().post(`/api/conversations/${id}/messages/${m.id}/view`).set(auth(p)).expect(200)
  })

  it('deletes the stored file after it has been opened', async () => {
    const { c, p, id } = await setup()
    const m = await sendPhoto(c, id, true)
    const key = (await prisma.message.findUniqueOrThrow({ where: { id: m.id } })).attachmentKey!
    expect(fs.existsSync(resolveLocalPath(key))).toBe(true)
    expect(await purgeViewedMedia(0)).toBe(0) // not opened yet: untouched
    await api().post(`/api/conversations/${id}/messages/${m.id}/view`).set(auth(p)).expect(200)
    await new Promise((r) => setTimeout(r, 20))
    expect(await purgeViewedMedia(0)).toBe(1)
    expect(fs.existsSync(resolveLocalPath(key))).toBe(false)
    expect((await prisma.message.findUniqueOrThrow({ where: { id: m.id } })).attachmentKey).toBeNull()
  })

  it('keeps ordinary photos viewable as before and refuses to claim them', async () => {
    const { c, p, id } = await setup()
    const m = await sendPhoto(c, id, false)
    expect(m.viewOnce).toBe(false)
    expect(m.attachmentUrl).toBeTruthy()
    await api().post(`/api/conversations/${id}/messages/${m.id}/view`).set(auth(p)).expect(404)
  })

  it('supports video, including view-once video', async () => {
    const { c, p, id } = await setup()
    const v = (await api().post(`/api/conversations/${id}/attachments`).set(auth(c)).field('viewOnce', 'true').attach('file', fakeMp4(), { filename: 'a.mp4', contentType: 'video/mp4' }).expect(201)).body
    expect(v).toMatchObject({ messageType: 'VIDEO', viewOnce: true, attachmentUrl: null })
    const opened = await api().post(`/api/conversations/${id}/messages/${v.id}/view`).set(auth(p)).expect(200)
    expect(opened.body.messageType).toBe('VIDEO')
    await api().get(path(opened.body.url)).expect(200)
    const plain = (await api().post(`/api/conversations/${id}/attachments`).set(auth(c)).attach('file', fakeMp4(), { filename: 'b.mp4', contentType: 'video/mp4' }).expect(201)).body
    expect(plain).toMatchObject({ messageType: 'VIDEO', viewOnce: false })
    expect(plain.attachmentUrl).toBeTruthy()
  })
})
