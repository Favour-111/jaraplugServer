import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { api, makeUser, auth, makeAdmin, makeClient, makeContent, makeProvider, prisma, resetAll } from './helpers'
import { resolveLocalPath } from '../src/storage'
import { env } from '../src/env'

beforeEach(resetAll)

describe('privacy & account deletion', () => {
  it('requires explicit confirmation to delete', async () => {
    const c = await makeClient()
    await api().delete('/api/me').set(auth(c)).send({}).expect(400)
    await api().delete('/api/me').set(auth(c)).send({ confirm: 'yes' }).expect(400)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: c.id } })).accountStatus).toBe('ACTIVE')
  })

  it('anonymises a client: removes PII, favourites, blocks and message text, and ends the session', async () => {
    const c = await makeClient({ username: 'goner', email: 'goner@example.test', displayName: 'Goner' })
    const p = await makeProvider({ username: 'amara' })
    const conv = (await api().post('/api/conversations').set(auth(c)).send({ username: 'amara' })).body.id
    await api().post(`/api/conversations/${conv}/messages`).set(auth(c)).send({ body: 'private words' })
    await prisma.favorite.create({ data: { userId: c.id, providerId: p.id } })
    await prisma.booking.create({ data: { clientId: c.id, providerId: p.id, category: 'dinner_date', scheduledAt: new Date(Date.now() + 5 * 86400_000) } })
    await api().delete('/api/me').set(auth(c)).send({ confirm: 'DELETE' }).expect(200)

    const u = await prisma.user.findUniqueOrThrow({ where: { id: c.id } })
    expect(u).toMatchObject({ accountStatus: 'DELETED', username: null, email: null, displayName: 'Deleted user' })
    expect(await prisma.favorite.count()).toBe(0)
    expect((await prisma.message.findFirstOrThrow()).body).toBe('')
    expect((await prisma.booking.findFirstOrThrow()).status).toBe('CANCELLED')
    await api().get('/api/me').set(auth(c)).expect(401) // session is dead
    // The freed username can be reused
    await makeClient({ username: 'goner' })
  })

  it('erases a provider’s profile, media files and listings, keeping only purchase tombstones', async () => {
    const p = await makeProvider({ username: 'amara' })
    const buyer = await makeClient()
    const free = await makeContent(p.id, { visibility: 'PUBLIC', price: 0 })
    const sold = await makeContent(p.id, { title: 'Sold item' })
    const tx = await prisma.transaction.create({ data: { userId: buyer.id, payeeId: p.id, contentId: sold.id, transactionType: 'CONTENT_PURCHASE', provider: 'credits', providerReference: 'jp_1', amount: 500000, status: 'SUCCESS', paidAt: new Date(), platformFee: 100000, netAmount: 400000 } })
    await prisma.contentPurchase.create({ data: { buyerId: buyer.id, contentId: sold.id, transactionId: tx.id, amount: 500000 } })
    const files = [free.storageKey, free.thumbnailKey!, sold.storageKey]
    files.forEach((k) => expect(fs.existsSync(resolveLocalPath(k))).toBe(true))

    await api().delete('/api/me').set(auth(p)).send({ confirm: 'DELETE' }).expect(200)

    files.forEach((k) => expect(fs.existsSync(resolveLocalPath(k))).toBe(false))
    expect(await prisma.providerProfile.count()).toBe(0)
    expect(await prisma.mediaContent.findUnique({ where: { id: free.id } })).toBeNull()
    expect((await prisma.mediaContent.findUniqueOrThrow({ where: { id: sold.id } })).moderationStatus).toBe('REMOVED')
    expect((await api().get('/api/providers')).body.items).toHaveLength(0)
    await api().get('/api/providers/amara').expect(404)
    expect(await prisma.transaction.count()).toBe(1) // financial record retained
  })

  it('blocks deletion while a payout is in progress', async () => {
    const p = await makeProvider()
    await prisma.payout.create({ data: { providerId: p.id, amount: 1000, reference: 'po_1' } })
    expect((await api().delete('/api/me').set(auth(p)).send({ confirm: 'DELETE' }).expect(409)).body.code).toBe('PAYOUT_PENDING')
  })

  it('refuses to delete administrator accounts through self-service', async () => {
    const a = await makeAdmin()
    await api().delete('/api/me').set(auth(a)).send({ confirm: 'DELETE' }).expect(403)
  })

  it('exports only the requesting user’s own data', async () => {
    const a = await makeClient({ username: 'alice' }); const b = await makeClient({ username: 'bob' })
    await prisma.notification.create({ data: { userId: a.id, type: 'X', title: 'for alice' } })
    await prisma.notification.create({ data: { userId: b.id, type: 'X', title: 'for bob' } })
    const r = await api().get('/api/me/export').set(auth(a)).expect(200)
    const json = JSON.stringify(r.body)
    expect(json).toContain('for alice')
    expect(json).not.toContain('for bob')
    expect(r.headers['content-disposition']).toContain('attachment')
  })

  it('keeps age-verification state server-side (cannot be self-set)', async () => {
    const c = await makeClient({ ageVerificationStatus: 'NOT_STARTED' })
    await api().patch('/api/me').set(auth(c)).send({ ageVerificationStatus: 'VERIFIED' }).expect(200)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: c.id } })).ageVerificationStatus).toBe('NOT_STARTED')
    // only the explicit age confirmation changes it, and it needs `confirmed: true`
    await api().post('/api/verification/age/confirm').set(auth(c)).send({ confirmed: false }).expect(400)
    await api().post('/api/verification/age/confirm').set(auth(c)).send({}).expect(400)
    await api().post('/api/verification/age/confirm').send({ confirmed: true }).expect(401)
    await api().post('/api/verification/age/confirm').set(auth(c)).send({ confirmed: true }).expect(200)
    await api().post('/api/verification/age/confirm').set(auth(c)).send({ confirmed: true }).expect(200) // idempotent
    expect((await prisma.user.findUniqueOrThrow({ where: { id: c.id } })).ageVerificationStatus).toBe('VERIFIED')
    expect(await prisma.verificationRequest.count({ where: { userId: c.id, type: 'AGE', providerRef: 'self-declared' } })).toBe(1)
    // an account that has not finished onboarding cannot declare
    const fresh = await makeUser({ role: 'UNASSIGNED', onboardedAt: null, ageVerificationStatus: 'NOT_STARTED' })
    await api().post('/api/verification/age/confirm').set(auth(fresh)).send({ confirmed: true }).expect(403)
  })
})

describe('DEMO_AUTO_VERIFY (testing switch)', () => {
  it('is off by default in the test environment, so verification is enforced', async () => {
    expect(env.DEMO_AUTO_VERIFY).toBe(false)
  })
})
