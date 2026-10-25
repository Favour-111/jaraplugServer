import { beforeEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { api, auth, makeAdmin, makeClient, makeContent, makeProvider, pathOf, png, prisma, resetAll } from './helpers'
import { env } from '../src/env'

beforeEach(resetAll)

const upload = (as: any, buf: Buffer, fields: Record<string, string>, filename = 'x.png', contentType = 'image/png') => {
  let r = api().post('/api/content').set(auth(as))
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v)
  return r.attach('file', buf, { filename, contentType })
}
const base = { title: 'My set', visibility: 'PAID', price: '5000', publish: 'true', consentConfirmed: 'true' }

describe('content upload validation', () => {
  it('rejects files whose real type is not an allowed image/video, whatever the extension says', async () => {
    const p = await makeProvider()
    const r = await upload(p, Buffer.from('#!/bin/sh\nrm -rf /\n'), base, 'photo.jpg', 'image/jpeg').expect(400)
    expect(r.body.code).toBe('BAD_FILE_TYPE')
    await upload(p, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), base, 'a.png', 'image/png').expect(400)
  })
  it('enforces image size limits server-side', async () => {
    const p = await makeProvider()
    const big = Buffer.concat([await png(), Buffer.alloc((env.MAX_IMAGE_MB + 1) * 1024 * 1024)])
    const r = await upload(p, big, base).expect(400)
    expect(r.body.code).toBe('FILE_TOO_LARGE')
  })
  it('requires a file, a title, and consent confirmation to publish', async () => {
    const p = await makeProvider()
    await api().post('/api/content').set(auth(p)).field('title', 'x1').expect(400)
    await upload(p, await png(), { ...base, title: '' }).expect(400)
    const r = await upload(p, await png(), { ...base, consentConfirmed: 'false' }).expect(400)
    expect(r.body.code).toBe('CONSENT_REQUIRED')
  })
  it('validates pricing rules', async () => {
    const p = await makeProvider()
    expect((await upload(p, await png(), { ...base, price: '10' }).expect(400)).body.code).toBe('BAD_PRICE')
    expect((await upload(p, await png(), { ...base, visibility: 'PUBLIC', price: '5000' }).expect(400)).body.code).toBe('BAD_PRICE')
  })
  it('blocks unverified providers from publishing but allows drafts', async () => {
    const p = await makeProvider({}, { verificationStatus: 'PENDING' })
    const r = await upload(p, await png(), base).expect(403)
    expect(r.body.code).toBe('PROVIDER_NOT_VERIFIED')
    await upload(p, await png(), { ...base, publish: 'false', consentConfirmed: 'false' }).expect(201)
  })
  it('only providers can upload', async () => {
    const c = await makeClient()
    await upload(c, await png(), base).expect(403)
    await api().post('/api/content').attach('file', await png(), 'a.png').expect(401)
  })
  it('stores a valid upload privately with a server-side blurred thumbnail and publishes it immediately (post-moderation)', async () => {
    const p = await makeProvider()
    const r = await upload(p, await png(200, 300), base).expect(201)
    expect(r.body.moderationStatus).toBe('APPROVED')
    const row = await prisma.mediaContent.findUniqueOrThrow({ where: { id: r.body.id } })
    expect(row.price).toBe(500_000) // ₦5,000 → kobo
    expect(row.thumbnailKey).toBeTruthy()
    expect(row.storageKey).not.toBe(row.thumbnailKey)
    // Visible without admin approval
    const c = await makeClient()
    await api().get(`/api/content/${row.id}`).set(auth(c)).expect(200)
  })
})

describe('unauthorised media access', () => {
  it('never returns a media url for locked content in listings', async () => {
    const p = await makeProvider({ username: 'amara' })
    await makeContent(p.id, { visibility: 'PAID', title: 'Paid' })
    await makeContent(p.id, { visibility: 'PUBLIC', price: 0, title: 'Free' })
    const c = await makeClient()
    for (const h of [{}, auth(c)]) {
      const r = await api().get('/api/providers/amara').set(h).expect(200)
      const paid = r.body.content.find((x: any) => x.title === 'Paid')
      const free = r.body.content.find((x: any) => x.title === 'Free')
      expect(paid.locked).toBe(true)
      expect(paid.url).toBeNull()
      expect(JSON.stringify(paid)).not.toContain('content/') // no storage key leakage
      expect(free.url).toContain('/api/media/f/')
    }
  })
  it('refuses signed-url minting for paid content without a purchase', async () => {
    const p = await makeProvider(); const c = await makeClient(); const other = await makeClient()
    const item = await makeContent(p.id)
    expect((await api().post(`/api/content/${item.id}/access`).expect(403)).body.code).toBe('PURCHASE_REQUIRED')
    expect((await api().post(`/api/content/${item.id}/access`).set(auth(c)).expect(403)).body.code).toBe('PURCHASE_REQUIRED')
    expect((await api().post(`/api/content/${item.id}/access`).set(auth(other)).expect(403)).body.code).toBe('PURCHASE_REQUIRED')
  })
  it('requires verified-adult status for members-only media', async () => {
    const p = await makeProvider()
    const item = await makeContent(p.id, { visibility: 'FREE_MEMBERS', price: 0 })
    const unverified = await makeClient({ ageVerificationStatus: 'NOT_STARTED' })
    const verified = await makeClient()
    await api().post(`/api/content/${item.id}/access`).expect(403)
    await api().post(`/api/content/${item.id}/access`).set(auth(unverified)).expect(403)
    await api().post(`/api/content/${item.id}/access`).set(auth(verified)).expect(200)
  })
  it('lets the owner and administrators in, and a blocked user out', async () => {
    const p = await makeProvider(); const admin = await makeAdmin(); const c = await makeClient()
    const item = await makeContent(p.id)
    await api().post(`/api/content/${item.id}/access`).set(auth(p)).expect(200)
    await api().post(`/api/content/${item.id}/access`).set(auth(admin)).expect(200)
    const pub = await makeContent(p.id, { visibility: 'PUBLIC', price: 0 })
    await api().post(`/api/content/${pub.id}/access`).set(auth(c)).expect(200)
    await prisma.block.create({ data: { blockerId: p.id, blockedId: c.id } })
    await api().post(`/api/content/${pub.id}/access`).set(auth(c)).expect(404)
  })
  it('hides unapproved, draft and removed content from everyone but the owner/admin', async () => {
    const p = await makeProvider(); const c = await makeClient()
    for (const over of [{ moderationStatus: 'PENDING' }, { moderationStatus: 'REMOVED' }, { moderationStatus: 'UNDER_REVIEW' }, { status: 'DRAFT' }] as const) {
      const item = await makeContent(p.id, { visibility: 'PUBLIC', price: 0, ...over })
      await api().post(`/api/content/${item.id}/access`).set(auth(c)).expect(404)
      await api().get(`/api/content/${item.id}`).set(auth(c)).expect(404)
    }
  })
  it('serves files only for valid, unexpired, untampered signed urls', async () => {
    const p = await makeProvider(); const c = await makeClient()
    const item = await makeContent(p.id, { visibility: 'PUBLIC', price: 0 })
    const { url } = (await api().post(`/api/content/${item.id}/access`).set(auth(c)).expect(200)).body
    const ok = await api().get(pathOf(url)).expect(200)
    expect(ok.headers['cache-control']).toContain('no-store')
    expect(ok.headers['x-content-type-options']).toBe('nosniff')
    // tampered signature / payload
    await api().get(pathOf(url).slice(0, -3) + 'abc').expect(403)
    const [payload, sig] = pathOf(url).split('/').pop()!.split('.')
    const evil = Buffer.from(JSON.stringify({ k: '../../../etc/passwd', e: 9999999999 })).toString('base64url')
    await api().get(`/api/media/f/${evil}.${sig}`).expect(403)
    // correctly signed but expired
    const expired = Buffer.from(JSON.stringify({ k: item.storageKey, e: Math.floor(Date.now() / 1000) - 5 })).toString('base64url')
    const goodSig = crypto.createHmac('sha256', env.MEDIA_SIGNING_SECRET).update(expired).digest('base64url')
    await api().get(`/api/media/f/${expired}.${goodSig}`).expect(403)
    // path traversal with a validly-signed token cannot escape the storage root
    const trav = Buffer.from(JSON.stringify({ k: '../../package.json', e: Math.floor(Date.now() / 1000) + 60 })).toString('base64url')
    const travSig = crypto.createHmac('sha256', env.MEDIA_SIGNING_SECRET).update(trav).digest('base64url')
    const r = await api().get(`/api/media/f/${trav}.${travSig}`)
    expect(r.status).toBeGreaterThanOrEqual(400)
    void payload
  })
  it('does not allow editing or deleting other providers’ content', async () => {
    const a = await makeProvider(); const b = await makeProvider()
    const item = await makeContent(a.id)
    await api().patch(`/api/content/${item.id}`).set(auth(b)).send({ title: 'hijack' }).expect(404)
    await api().delete(`/api/content/${item.id}`).set(auth(b)).expect(404)
  })
})
