import { beforeEach, describe, expect, it } from 'vitest'
import { api, auth, makeAdmin, makeClient, makeContent, makeProvider, prisma, resetAll } from './helpers'

beforeEach(resetAll)

describe('blocking', () => {
  it('hides blocked users from each other and stops messaging', async () => {
    const c = await makeClient(); const p = await makeProvider({ username: 'amara' })
    const conv = (await api().post('/api/conversations').set(auth(c)).send({ username: 'amara' })).body.id
    await api().post('/api/blocks').set(auth(c)).send({ userId: p.id }).expect(201)
    expect((await api().get('/api/providers').set(auth(c))).body.items).toHaveLength(0)
    await api().get('/api/providers/amara').set(auth(c)).expect(404)
    // the blocked party cannot find the blocker either
    const r = await api().post(`/api/conversations/${conv}/messages`).set(auth(p)).send({ body: 'hi' }).expect(403)
    expect(r.body.code).toBe('BLOCKED')
    await api().post('/api/conversations').set(auth(c)).send({ username: 'amara' }).expect(403)
    // unblocking restores access
    await api().delete(`/api/blocks/${p.id}`).set(auth(c)).expect(200)
    await api().get('/api/providers/amara').set(auth(c)).expect(200)
  })
  it('withdraws pending bookings and favourites when blocking; cannot block yourself or admins', async () => {
    const c = await makeClient(); const p = await makeProvider(); const admin = await makeAdmin()
    await prisma.booking.create({ data: { clientId: c.id, providerId: p.id, category: 'dinner_date', scheduledAt: new Date(Date.now() + 86400_000 * 3) } })
    await prisma.favorite.create({ data: { userId: c.id, providerId: p.id } })
    await api().post('/api/blocks').set(auth(c)).send({ userId: p.id }).expect(201)
    expect((await prisma.booking.findFirstOrThrow()).status).toBe('CANCELLED')
    expect(await prisma.favorite.count()).toBe(0)
    await api().post('/api/blocks').set(auth(c)).send({ userId: c.id }).expect(400)
    await api().post('/api/blocks').set(auth(c)).send({ userId: admin.id }).expect(404)
  })
})

describe('reporting', () => {
  it('files a report and flags serious categories as priority', async () => {
    const c = await makeClient(); const p = await makeProvider()
    const r = await api().post('/api/reports').set(auth(c)).send({ reportedUserId: p.id, category: 'IMPERSONATION', description: 'Using my photos' }).expect(201)
    expect((await prisma.report.findUniqueOrThrow({ where: { id: r.body.id } })).priority).toBe(true)
    const spam = await api().post('/api/reports').set(auth(c)).send({ reportedUserId: p.id, category: 'SPAM_OR_SCAM' }).expect(201)
    expect((await prisma.report.findUniqueOrThrow({ where: { id: spam.body.id } })).priority).toBe(false)
  })
  it('requires a target, rejects self-reports, and requires login', async () => {
    const c = await makeClient()
    await api().post('/api/reports').set(auth(c)).send({ category: 'OTHER' }).expect(400)
    await api().post('/api/reports').set(auth(c)).send({ reportedUserId: c.id, category: 'OTHER' }).expect(400)
    await api().post('/api/reports').send({ reportedUserId: 'x', category: 'OTHER' }).expect(401)
  })
  it('immediately hides content reported as non-consensual / underage / exploitative pending human review', async () => {
    const c = await makeClient(); const p = await makeProvider({ username: 'amara' })
    const item = await makeContent(p.id, { visibility: 'PUBLIC', price: 0 })
    await api().post(`/api/content/${item.id}/access`).set(auth(c)).expect(200)
    await api().post('/api/reports').set(auth(c)).send({ reportedContentId: item.id, category: 'NON_CONSENSUAL_IMAGERY', description: 'This is me and I did not consent' }).expect(201)
    expect((await prisma.mediaContent.findUniqueOrThrow({ where: { id: item.id } })).moderationStatus).toBe('UNDER_REVIEW')
    await api().post(`/api/content/${item.id}/access`).set(auth(c)).expect(404)
    expect((await api().get('/api/providers/amara')).body.content).toHaveLength(0)
    // priority reports notify administrators
    const admin = await makeAdmin()
    await api().post('/api/reports').set(auth(c)).send({ reportedUserId: p.id, category: 'UNDERAGE' }).expect(201)
    expect((await api().get('/api/notifications').set(auth(admin))).body.items.some((n: any) => n.title.includes('Priority'))).toBe(true)
  })
})

describe('administration', () => {
  const adminEndpoints = ['/overview', '/users', '/verifications', '/content', '/reports', '/transactions', '/payouts', '/support', '/audit-logs']

  it('denies every admin endpoint to anonymous users, clients and providers', async () => {
    const c = await makeClient(); const p = await makeProvider()
    for (const e of adminEndpoints) {
      await api().get(`/api/admin${e}`).expect(401)
      await api().get(`/api/admin${e}`).set(auth(c)).expect(403)
      await api().get(`/api/admin${e}`).set(auth(p)).expect(403)
    }
  })
  it('lets administrators reach every admin endpoint', async () => {
    const admin = await makeAdmin()
    for (const e of adminEndpoints) await api().get(`/api/admin${e}`).set(auth(admin)).expect(200)
  })
  it('requires a reason for suspension, records it in the audit log, and locks the user out immediately', async () => {
    const admin = await makeAdmin(); const c = await makeClient()
    await api().post(`/api/admin/users/${c.id}/suspend`).set(auth(admin)).send({}).expect(400)
    await api().post(`/api/admin/users/${c.id}/suspend`).set(auth(admin)).send({ reason: 'Harassment of providers' }).expect(200)
    expect((await api().get('/api/me').set(auth(c))).status).toBe(403)
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'USER_SUSPENDED' } })
    expect(log).toMatchObject({ administratorId: admin.id, targetId: c.id, reason: 'Harassment of providers' })
    await api().post(`/api/admin/users/${c.id}/reactivate`).set(auth(admin)).send({ reason: 'Appeal upheld after review' }).expect(200)
    await api().get('/api/me').set(auth(c)).expect(200)
    expect(await prisma.auditLog.count()).toBe(2)
  })
  it('refuses to suspend another administrator, and suspended providers vanish from discovery', async () => {
    const admin = await makeAdmin(); const other = await makeAdmin(); const p = await makeProvider({ username: 'amara' })
    await api().post(`/api/admin/users/${other.id}/suspend`).set(auth(admin)).send({ reason: 'Not allowed here' }).expect(403)
    expect((await api().get('/api/providers')).body.items).toHaveLength(1)
    await api().post(`/api/admin/users/${p.id}/suspend`).set(auth(admin)).send({ reason: 'Impersonation confirmed' }).expect(200)
    expect((await api().get('/api/providers')).body.items).toHaveLength(0)
  })
  it('moderates content with reasons, audit trail and notification', async () => {
    const admin = await makeAdmin(); const p = await makeProvider({ username: 'amara' })
    const item = await makeContent(p.id, { visibility: 'PUBLIC', price: 0, moderationStatus: 'PENDING' })
    expect((await api().get('/api/admin/content?status=PENDING').set(auth(admin))).body.items).toHaveLength(1)
    await api().post(`/api/admin/content/${item.id}/moderate`).set(auth(admin)).send({ action: 'reject' }).expect(400) // reason required
    await api().post(`/api/admin/content/${item.id}/moderate`).set(auth(admin)).send({ action: 'approve' }).expect(200)
    expect((await api().get('/api/providers/amara')).body.content).toHaveLength(1)
    await api().post(`/api/admin/content/${item.id}/moderate`).set(auth(admin)).send({ action: 'remove', reason: 'Violates guidelines' }).expect(200)
    expect((await api().get('/api/providers/amara')).body.content).toHaveLength(0)
    expect(await prisma.auditLog.count({ where: { targetId: item.id } })).toBe(2)
    expect(await prisma.notification.count({ where: { userId: p.id, type: 'MODERATION' } })).toBe(2)
  })
  it('processes reports and verification rejections with recorded reasons', async () => {
    const admin = await makeAdmin(); const c = await makeClient(); const p = await makeProvider({ ageVerificationStatus: 'PENDING' }, { verificationStatus: 'PENDING' })
    const rep = (await api().post('/api/reports').set(auth(c)).send({ reportedUserId: p.id, category: 'HARASSMENT' })).body
    await api().post(`/api/admin/reports/${rep.id}/resolve`).set(auth(admin)).send({ status: 'RESOLVED' }).expect(400)
    await api().post(`/api/admin/reports/${rep.id}/resolve`).set(auth(admin)).send({ status: 'RESOLVED', note: 'Warned the user' }).expect(200)
    const v = await prisma.verificationRequest.create({ data: { userId: p.id, type: 'PROVIDER_IDENTITY' } })
    await api().post(`/api/admin/verifications/${v.id}/reject`).set(auth(admin)).send({ reason: 'Photo does not match ID' }).expect(200)
    expect((await prisma.providerProfile.findUniqueOrThrow({ where: { userId: p.id } })).verificationStatus).toBe('REJECTED')
    await api().post(`/api/admin/verifications/${v.id}/approve`).set(auth(admin)).send({}).expect(409) // already reviewed
  })
  it('handles support / dispute requests end to end', async () => {
    const admin = await makeAdmin(); const c = await makeClient()
    const r = await api().post('/api/support').set(auth(c)).send({ subject: 'Charged twice', body: 'I was charged but cannot see the video' }).expect(201)
    expect((await api().get('/api/admin/support').set(auth(admin))).body.items).toHaveLength(1)
    await api().post(`/api/admin/support/${r.body.id}/respond`).set(auth(admin)).send({ response: 'We have refunded you', status: 'CLOSED' }).expect(200)
    expect((await api().get('/api/support').set(auth(c))).body.items[0]).toMatchObject({ status: 'CLOSED', adminResponse: 'We have refunded you' })
    // can't attach someone else's transaction
    const other = await makeClient()
    const tx = await prisma.transaction.create({ data: { userId: other.id, transactionType: 'CONTENT_PURCHASE', provider: 'credits', providerReference: 'jp_x', amount: 1 } })
    await api().post('/api/support').set(auth(c)).send({ subject: 'Not mine', body: 'about another users payment', relatedTransactionId: tx.id }).expect(404)
  })
})
