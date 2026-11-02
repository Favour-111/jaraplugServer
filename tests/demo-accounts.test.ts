import { beforeEach, describe, expect, it } from 'vitest'
import { api, auth, makeAdmin, makeClient, makeProvider, prisma, resetAll } from './helpers'

beforeEach(resetAll)

const create = (admin: any, over: Record<string, unknown> = {}) =>
  api().post('/api/admin/demo-accounts').set(auth(admin)).send({ username: 'demo_amaka', displayName: 'Amaka', city: 'London', ...over })

describe('admin demo accounts (DEMO_ACCOUNTS=true)', () => {
  it('creates a verified, public demo provider and lists it', async () => {
    const admin = await makeAdmin()
    const r = await create(admin).expect(201)
    const u = await prisma.user.findUniqueOrThrow({ where: { id: r.body.id }, include: { providerProfile: true } })
    expect(u).toMatchObject({ role: 'PROVIDER', isDemo: true, ageVerificationStatus: 'VERIFIED' })
    expect(u.providerProfile).toMatchObject({ city: 'London', verificationStatus: 'VERIFIED', visibility: 'PUBLIC' })
    const list = await api().get('/api/admin/demo-accounts').set(auth(admin)).expect(200)
    expect(list.body.items.map((a: any) => a.username)).toEqual(['demo_amaka'])
    await create(admin).expect(409)
  })

  it('lets the admin act as the demo provider with X-Act-As', async () => {
    const admin = await makeAdmin()
    const { body } = await create(admin)
    await api().post(`/api/admin/demo-accounts/${body.id}/act`).set(auth(admin)).expect(200)
    const me = await api().get('/api/me').set(auth(admin)).set('X-Act-As', body.id).expect(200)
    expect(me.body).toMatchObject({ username: 'demo_amaka', role: 'PROVIDER' })
    await api().get('/api/provider/profile').set(auth(admin)).set('X-Act-As', body.id).expect(200)
    // While acting, the request has the demo provider's permissions, not the admin's.
    await api().get('/api/admin/overview').set(auth(admin)).set('X-Act-As', body.id).expect(403)
    expect(await prisma.auditLog.count({ where: { action: 'DEMO_ACCOUNT_ACT_AS', targetId: body.id } })).toBe(1)
  })

  it('refuses to act as real accounts, or for non-admins', async () => {
    const admin = await makeAdmin()
    const real = await makeProvider({ username: 'realone' })
    await api().get('/api/me').set(auth(admin)).set('X-Act-As', real.id).expect(403)
    await api().post(`/api/admin/demo-accounts/${real.id}/act`).set(auth(admin)).expect(404)
    const { body } = await create(admin)
    const client = await makeClient()
    await api().get('/api/me').set(auth(client)).set('X-Act-As', body.id).expect(403)
    await api().post('/api/admin/demo-accounts').set(auth(client)).send({ username: 'x_demo', displayName: 'X', city: 'Paris' }).expect(403)
  })

  it('deleting a demo account hides it and ends acting as it', async () => {
    const admin = await makeAdmin()
    const { body } = await create(admin)
    await api().delete(`/api/admin/demo-accounts/${body.id}`).set(auth(admin)).expect(200)
    const res = await api().get('/api/me').set(auth(admin)).set('X-Act-As', body.id).expect(403)
    expect(res.body.code).toBe('ACT_AS_INVALID')
    expect((await api().get('/api/admin/demo-accounts').set(auth(admin))).body.items).toEqual([])
  })
})
