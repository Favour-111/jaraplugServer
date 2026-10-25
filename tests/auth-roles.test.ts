import { beforeEach, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { api, auth, makeAdmin, makeClient, makeProvider, makeUser, prisma, resetAll } from './helpers'

beforeEach(resetAll)

describe('registration & login (auth)', () => {
  it('rejects requests without a token', async () => {
    await api().get('/api/me').expect(401)
  })
  it('rejects garbage and wrongly-signed tokens', async () => {
    await api().get('/api/me').set('Authorization', 'Bearer nonsense').expect(401)
    const forged = jwt.sign({ sub: 'someone' }, 'a-different-secret-entirely-xxxxxxxxxx')
    await api().get('/api/me').set('Authorization', `Bearer ${forged}`).expect(401)
  })
  it('creates a local account with an UNASSIGNED role on first sign-in', async () => {
    const reg = await api().post('/api/dev/register').send({ email: 'new@example.test' }).expect(201)
    const me = await api().get('/api/me').set('Authorization', `Bearer ${reg.body.token}`).expect(200)
    expect(me.body.role).toBe('UNASSIGNED')
    expect(me.body.onboarded).toBe(false)
  })
  it('blocks suspended accounts on the backend', async () => {
    const u = await makeClient({ accountStatus: 'SUSPENDED' })
    const r = await api().get('/api/me').set(auth(u)).expect(403)
    expect(r.body.code).toBe('ACCOUNT_SUSPENDED')
  })
})

describe('onboarding & role enforcement', () => {
  it('lets a new user choose CLIENT once, and never change it', async () => {
    const reg = await api().post('/api/dev/register').send({}).expect(201)
    const h = { Authorization: `Bearer ${reg.body.token}` }
    const body = { role: 'CLIENT', username: 'new_client', city: 'Lagos', acceptTerms: true }
    await api().post('/api/me/onboarding').set(h).send(body).expect(201)
    const again = await api().post('/api/me/onboarding').set(h).send({ ...body, role: 'PROVIDER', username: 'x_provider', displayName: 'Nope' }).expect(409)
    expect(again.body.code).toBe('ROLE_LOCKED')
  })
  it('cannot self-assign ADMIN during onboarding', async () => {
    const reg = await api().post('/api/dev/register').send({}).expect(201)
    const h = { Authorization: `Bearer ${reg.body.token}` }
    await api().post('/api/me/onboarding').set(h).send({ role: 'ADMIN', username: 'sneaky', city: 'Lagos', acceptTerms: true }).expect(400)
    const me = await api().get('/api/me').set(h)
    expect(me.body.role).toBe('UNASSIGNED')
  })
  it('requires terms acceptance and a valid unique username', async () => {
    const reg = await api().post('/api/dev/register').send({}).expect(201)
    const h = { Authorization: `Bearer ${reg.body.token}` }
    await api().post('/api/me/onboarding').set(h).send({ role: 'CLIENT', username: 'abc', city: 'Lagos', acceptTerms: false }).expect(400)
    await api().post('/api/me/onboarding').set(h).send({ role: 'CLIENT', username: 'bad name!', city: 'Lagos', acceptTerms: true }).expect(400)
    await makeClient({ username: 'taken_name' })
    const r = await api().post('/api/me/onboarding').set(h).send({ role: 'CLIENT', username: 'taken_name', city: 'Lagos', acceptTerms: true }).expect(409)
    expect(r.body.code).toBe('USERNAME_TAKEN')
  })
  it('ignores a role field smuggled into PATCH /me', async () => {
    const c = await makeClient()
    await api().patch('/api/me').set(auth(c)).send({ role: 'ADMIN', displayName: 'Still Client' }).expect(200)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: c.id } })).role).toBe('CLIENT')
  })
  it('enforces role permissions on the backend', async () => {
    const client = await makeClient()
    const provider = await makeProvider()
    const admin = await makeAdmin()
    // client → provider / admin APIs
    await api().get('/api/provider/profile').set(auth(client)).expect(403)
    await api().get('/api/provider/earnings').set(auth(client)).expect(403)
    await api().get('/api/admin/overview').set(auth(client)).expect(403)
    // provider → admin APIs, and client-only booking creation
    await api().get('/api/admin/users').set(auth(provider)).expect(403)
    await api().post('/api/bookings').set(auth(provider)).send({}).expect(403)
    // admin → ok
    await api().get('/api/admin/overview').set(auth(admin)).expect(200)
    // anonymous
    await api().get('/api/admin/overview').expect(401)
  })
  it('gives UNASSIGNED users no access to restricted areas', async () => {
    const u = await makeUser({ role: 'UNASSIGNED', onboardedAt: null, ageVerificationStatus: 'NOT_STARTED' })
    await api().get('/api/conversations').set(auth(u)).expect(200)
    await api().post('/api/purchases/unlock').set(auth(u)).send({ contentId: 'x' }).expect(403)
    await api().post('/api/credits/topup').set(auth(u)).send({ credits: 5 }).expect(403)
    await api().get('/api/provider/profile').set(auth(u)).expect(403)
  })
})
