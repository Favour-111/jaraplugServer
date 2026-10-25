import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { io as ioc, type Socket } from 'socket.io-client'
import { api, app, auth, makeClient, makeProvider, png, prisma, resetAll, tokenFor } from './helpers'
import { attachRealtime } from '../src/services/realtime'

beforeEach(resetAll)

async function open(clientUser: { id: string }, providerUser: { username: string | null }, as: any) {
  const r = await api().post('/api/conversations').set(auth(as)).send({ username: providerUser.username }).expect(200)
  return r.body.id as string
}

describe('private messaging – authorization', () => {
  it('lets a verified client start a conversation with a listed provider and exchange messages', async () => {
    const c = await makeClient()
    const p = await makeProvider({ username: 'amara' })
    const id = await open(c, p, c)
    await api().post(`/api/conversations/${id}/messages`).set(auth(c)).send({ body: 'Hello!' }).expect(201)
    await api().post(`/api/conversations/${id}/messages`).set(auth(p)).send({ body: 'Hi 👋' }).expect(201)
    const hist = await api().get(`/api/conversations/${id}/messages`).set(auth(c)).expect(200)
    expect(hist.body.messages.map((m: any) => m.body)).toEqual(['Hello!', 'Hi 👋'])
    const list = await api().get('/api/conversations').set(auth(p)).expect(200)
    expect(list.body.items[0].unread).toBe(1)
    await api().post(`/api/conversations/${id}/read`).set(auth(p)).expect(200)
    expect((await api().get('/api/conversations').set(auth(p))).body.items[0].unread).toBe(0)
  })

  it('never lets a third party read, send to or mark-read someone else’s conversation (even knowing the id)', async () => {
    const c = await makeClient()
    const p = await makeProvider({ username: 'amara' })
    const intruder = await makeClient()
    const id = await open(c, p, c)
    await api().post(`/api/conversations/${id}/messages`).set(auth(c)).send({ body: 'secret' }).expect(201)
    await api().get(`/api/conversations/${id}/messages`).set(auth(intruder)).expect(404)
    await api().post(`/api/conversations/${id}/messages`).set(auth(intruder)).send({ body: 'hi' }).expect(404)
    await api().post(`/api/conversations/${id}/read`).set(auth(intruder)).expect(404)
    await api().get(`/api/conversations/${id}/messages`).expect(401)
    expect((await api().get('/api/conversations').set(auth(intruder))).body.items).toHaveLength(0)
  })

  it('requires age verification before messaging', async () => {
    const c = await makeClient({ ageVerificationStatus: 'NOT_STARTED' })
    await makeProvider({ username: 'amara' })
    const r = await api().post('/api/conversations').set(auth(c)).send({ username: 'amara' }).expect(403)
    expect(r.body.code).toBe('AGE_VERIFICATION_REQUIRED')
  })

  it('does not let providers cold-contact clients, nor clients contact unlisted providers', async () => {
    const c = await makeClient({ username: 'cl' })
    const p = await makeProvider({ username: 'amara' })
    const hidden = await makeProvider({ username: 'hiddenp' }, { visibility: 'HIDDEN' })
    const r = await api().post('/api/conversations').set(auth(p)).send({ username: 'cl' }).expect(403)
    expect(r.body.code).toBe('PROVIDER_CANNOT_INITIATE')
    await api().post('/api/conversations').set(auth(c)).send({ username: hidden.username }).expect(404)
  })

  it('validates message length and emptiness', async () => {
    const c = await makeClient(); const p = await makeProvider({ username: 'amara' })
    const id = await open(c, p, c)
    await api().post(`/api/conversations/${id}/messages`).set(auth(c)).send({ body: '   ' }).expect(400)
    await api().post(`/api/conversations/${id}/messages`).set(auth(c)).send({ body: 'x'.repeat(2001) }).expect(400)
  })

  it('rate-limits message floods', async () => {
    const c = await makeClient(); const p = await makeProvider({ username: 'amara' })
    const id = await open(c, p, c)
    let limited = 0
    for (let i = 0; i < 35; i++) {
      const r = await api().post(`/api/conversations/${id}/messages`).set(auth(c)).send({ body: `m${i}` })
      if (r.status === 429) limited++
    }
    expect(limited).toBeGreaterThan(0)
  })

  it('paginates history with a cursor', async () => {
    const c = await makeClient(); const p = await makeProvider({ username: 'amara' })
    const id = await open(c, p, c)
    for (let i = 0; i < 5; i++) await prisma.message.create({ data: { conversationId: id, senderId: c.id, body: `m${i}`, createdAt: new Date(Date.now() - (10 - i) * 1000) } })
    const page1 = await api().get(`/api/conversations/${id}/messages?limit=3`).set(auth(c)).expect(200)
    expect(page1.body.messages.map((m: any) => m.body)).toEqual(['m2', 'm3', 'm4'])
    const page2 = await api().get(`/api/conversations/${id}/messages?limit=3&cursor=${page1.body.nextCursor}`).set(auth(c)).expect(200)
    expect(page2.body.messages.map((m: any) => m.body)).toEqual(['m0', 'm1'])
    expect(page2.body.nextCursor).toBeNull()
  })

  it('accepts real images as chat attachments and rejects disguised files', async () => {
    const c = await makeClient(); const p = await makeProvider({ username: 'amara' })
    const id = await open(c, p, c)
    const ok = await api().post(`/api/conversations/${id}/attachments`).set(auth(c)).attach('file', await png(), { filename: 'a.png', contentType: 'image/png' }).expect(201)
    expect(ok.body.messageType).toBe('IMAGE')
    expect(ok.body.attachmentUrl).toContain('/api/media/f/')
    await api().post(`/api/conversations/${id}/attachments`).set(auth(c)).attach('file', Buffer.from('<?php echo 1; ?>'), { filename: 'a.png', contentType: 'image/png' }).expect(400)
  })
})

describe('private messaging – real-time (Socket.IO)', () => {
  let server: http.Server; let url: string
  beforeAll(async () => {
    server = http.createServer(app); attachRealtime(server)
    await new Promise<void>((r) => server.listen(0, r)); url = `http://localhost:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => { server.close() })

  const connect = (token: string) => new Promise<Socket>((resolve, reject) => {
    const s = ioc(url, { auth: { token }, transports: ['websocket'], reconnection: false })
    s.on('connect', () => resolve(s)); s.on('connect_error', reject)
  })

  it('rejects unauthenticated sockets', async () => {
    await expect(connect('bad')).rejects.toThrow()
  })

  it('delivers messages in real time and persists them', async () => {
    const c = await makeClient(); const p = await makeProvider({ username: 'amara' })
    const id = await open(c, p, c)
    const sc = await connect(tokenFor(c)); const sp = await connect(tokenFor(p))
    const got = new Promise<any>((resolve) => sp.on('message:new', resolve))
    const ack = await new Promise<any>((resolve) => sc.emit('message:send', { conversationId: id, body: 'live!' }, resolve))
    expect(ack.ok).toBe(true)
    const msg = await got
    expect(msg.body).toBe('live!')
    expect(msg.deliveredAt).not.toBeNull() // recipient was online
    expect(await prisma.message.count({ where: { conversationId: id } })).toBe(1)
    sc.close(); sp.close()
  })

  it('refuses socket sends into conversations the user does not belong to', async () => {
    const c = await makeClient(); const p = await makeProvider({ username: 'amara' }); const evil = await makeClient()
    const id = await open(c, p, c)
    const se = await connect(tokenFor(evil))
    const ack = await new Promise<any>((resolve) => se.emit('message:send', { conversationId: id, body: 'let me in' }, resolve))
    expect(ack.ok).toBe(false)
    expect(await prisma.message.count()).toBe(0)
    se.close()
  })
})
