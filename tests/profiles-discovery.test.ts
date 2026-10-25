import { beforeEach, describe, expect, it } from 'vitest'
import { api, auth, makeAdmin, makeClient, makeProvider, makeUser, png, prisma, resetAll } from './helpers'

beforeEach(resetAll)

describe('provider profile creation', () => {
  it('creates a provider profile through onboarding', async () => {
    const reg = await api().post('/api/dev/register').send({}).expect(201)
    const h = { Authorization: `Bearer ${reg.body.token}` }
    await api().post('/api/me/onboarding').set(h).send({ role: 'PROVIDER', username: 'newprov', displayName: 'New Prov', city: 'Lagos', acceptTerms: true }).expect(201)
    const profile = await api().get('/api/provider/profile').set(h).expect(200)
    expect(profile.body.verificationStatus).toBe('UNSUBMITTED')
    // not discoverable until verified
    const list = await api().get('/api/providers').expect(200)
    expect(list.body.items).toHaveLength(0)
  })

  it('rejects under-18 ages', async () => {
    const p = await makeProvider({}, { verificationStatus: 'UNSUBMITTED' })
    await api().put('/api/provider/profile').set(auth(p)).send({ displayAge: 17 }).expect(400)
    await api().put('/api/provider/profile').set(auth(p)).send({ displayAge: 25, biography: 'Updated bio' }).expect(200)
  })

  it('refuses to submit an incomplete profile, then submits a complete one for review', async () => {
    const p = await makeProvider({}, { verificationStatus: 'UNSUBMITTED', profileImage: null, biography: '', consentConfirmedAt: null })
    const bad = await api().post('/api/provider/profile/submit').set(auth(p)).expect(400)
    expect(bad.body.code).toBe('PROFILE_INCOMPLETE')

    await api().put('/api/provider/profile').set(auth(p)).send({ biography: 'A complete biography that is long enough.', consentConfirmed: true }).expect(200)
    await api().post('/api/provider/profile/photo').set(auth(p)).attach('file', await png(), { filename: 'me.png', contentType: 'image/png' }).expect(200)
    await api().post('/api/provider/profile/submit').set(auth(p)).expect(201)
    const row = await prisma.providerProfile.findUniqueOrThrow({ where: { userId: p.id } })
    expect(row.verificationStatus).toBe('PENDING')
    await api().post('/api/provider/profile/submit').set(auth(p)).expect(409)
  })

  it('goes live only after an administrator approves the verification', async () => {
    const p = await makeProvider({ ageVerificationStatus: 'PENDING' }, { verificationStatus: 'PENDING' })
    const admin = await makeAdmin()
    const req = await prisma.verificationRequest.create({ data: { userId: p.id, type: 'PROVIDER_IDENTITY' } })
    expect((await api().get('/api/providers')).body.items).toHaveLength(0)
    await api().post(`/api/admin/verifications/${req.id}/approve`).set(auth(admin)).send({}).expect(200)
    expect((await api().get('/api/providers')).body.items).toHaveLength(1)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: p.id } })).ageVerificationStatus).toBe('VERIFIED')
  })

  it('does not publicly expose a provider email or legal identity', async () => {
    await makeProvider({ username: 'discreet', email: 'real.name@example.test', displayName: 'Disco' })
    const r = await api().get('/api/providers/discreet').expect(200)
    const json = JSON.stringify(r.body)
    expect(json).not.toContain('real.name@example.test')
    expect(r.body).not.toHaveProperty('email')
  })

  it('lets providers hide individual profile fields', async () => {
    const p = await makeProvider({ username: 'private1' })
    await api().put('/api/provider/profile').set(auth(p)).send({ publicFields: { age: false, area: false } }).expect(200)
    const r = await api().get('/api/providers/private1').expect(200)
    expect(r.body.age).toBeNull()
    expect(r.body.area).toBeNull()
  })
})

describe('discovery & filtering', () => {
  beforeEach(async () => {
    await makeProvider({ username: 'amara', displayName: 'Amara' }, { city: 'Lagos', area: 'Lekki', availabilityStatus: 'AVAILABLE_NOW' })
    await makeProvider({ username: 'queenb', displayName: 'Queen B' }, { city: 'Abuja', area: 'Maitama', availabilityStatus: 'BY_APPOINTMENT' })
    await makeProvider({ username: 'hidden1' }, { visibility: 'HIDDEN' })
    await makeProvider({ username: 'unverified1' }, { verificationStatus: 'PENDING' })
    await makeProvider({ username: 'suspended1', accountStatus: 'SUSPENDED' })
    await makeProvider({ username: 'members1' }, { visibility: 'MEMBERS_ONLY' })
  })
  const names = (r: any) => r.body.items.map((i: any) => i.username).sort()

  it('lists only verified, active, public providers to anonymous visitors', async () => {
    expect(names(await api().get('/api/providers'))).toEqual(['amara', 'queenb'])
  })
  it('shows members-only profiles only to verified adults', async () => {
    const verified = await makeClient()
    const unverified = await makeClient({ ageVerificationStatus: 'NOT_STARTED' })
    expect(names(await api().get('/api/providers').set(auth(verified)))).toEqual(['amara', 'members1', 'queenb'])
    expect(names(await api().get('/api/providers').set(auth(unverified)))).toEqual(['amara', 'queenb'])
    await api().get('/api/providers/members1').expect(404)
    await api().get('/api/providers/members1').set(auth(verified)).expect(200)
  })
  it('filters by city, availability and keyword against real data', async () => {
    expect(names(await api().get('/api/providers?city=Abuja'))).toEqual(['queenb'])
    expect(names(await api().get('/api/providers?availability=AVAILABLE_NOW'))).toEqual(['amara'])
    expect(names(await api().get('/api/providers?q=lekki'))).toEqual(['amara'])
    expect(names(await api().get('/api/providers?q=queen'))).toEqual(['queenb'])
    expect(names(await api().get('/api/providers?q=nomatch'))).toEqual([])
  })
  it('hides hidden / unverified / suspended profile pages', async () => {
    for (const u of ['hidden1', 'unverified1', 'suspended1']) await api().get(`/api/providers/${u}`).expect(404)
  })
  it('supports favourites', async () => {
    const c = await makeClient()
    const amara = await prisma.user.findFirstOrThrow({ where: { username: 'amara' } })
    await api().put(`/api/favorites/${amara.id}`).set(auth(c)).expect(200)
    const list = await api().get('/api/favorites').set(auth(c))
    expect(list.body.items.map((i: any) => i.username)).toEqual(['amara'])
    expect((await api().get('/api/providers').set(auth(c))).body.items.find((i: any) => i.username === 'amara').isFavorite).toBe(true)
    await api().delete(`/api/favorites/${amara.id}`).set(auth(c)).expect(200)
    expect((await api().get('/api/favorites').set(auth(c))).body.items).toHaveLength(0)
  })
  void makeUser
})
