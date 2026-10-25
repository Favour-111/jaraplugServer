import { beforeEach, describe, expect, it } from 'vitest'
import { api, auth, makeAdmin, makeClient, makeUser, prisma, resetAll } from './helpers'

beforeEach(resetAll)

const balance = async (u: { id: string }) => (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).creditBalance
const freshUser = () => makeUser({ role: 'UNASSIGNED', onboardedAt: null, ageVerificationStatus: 'NOT_STARTED', username: null as any, displayName: null as any })
let n = 0
const signUp = async (role: 'CLIENT' | 'PROVIDER', code?: string) => {
  const u = await freshUser()
  await api().post('/api/me/onboarding').set(auth(u)).send({ role, username: `friend${++n}`, displayName: 'Friend', city: 'Lagos', acceptTerms: true, referralCode: code }).expect(201)
  return u
}
const myCode = async (u: any) => (await api().get('/api/referrals/me').set(auth(u)).expect(200)).body.code as string

describe('referral code', () => {
  it('gives each client a stable code and shows the programme details', async () => {
    const c = await makeClient()
    const r = (await api().get('/api/referrals/me').set(auth(c)).expect(200)).body
    expect(r).toMatchObject({ enabled: true, rewardCredits: 20, rewardKobo: 2_000_00 * 5, referrals: 0, creditsEarned: 0, canStillEarn: true })
    expect(r.code).toMatch(/^[A-Z2-9]{8}$/)
    expect(await myCode(c)).toBe(r.code)
    await api().get('/api/referrals/me').expect(401)
  })
})

describe('earning the reward', () => {
  it('credits the referrer when a new client signs up with their code', async () => {
    const referrer = await makeClient()
    const code = await myCode(referrer)
    await signUp('CLIENT', code)
    expect(await balance(referrer)).toBe(20)
    expect(await prisma.referral.count()).toBe(1)
    expect(await prisma.creditLedger.findMany({ where: { userId: referrer.id } })).toMatchObject([{ type: 'REFERRAL', delta: 20 }])
    expect(await prisma.notification.count({ where: { userId: referrer.id, type: 'REFERRAL_REWARD' } })).toBe(1)
    expect((await api().get('/api/referrals/me').set(auth(referrer))).body).toMatchObject({ referrals: 1, creditsEarned: 20, canStillEarn: false })
  })

  it('lets a client earn only once by default, and the admin can raise that limit', async () => {
    const referrer = await makeClient()
    const admin = await makeAdmin()
    const code = await myCode(referrer)
    await signUp('CLIENT', code)
    await signUp('CLIENT', code) // second friend: no reward
    expect(await balance(referrer)).toBe(20)
    await api().put('/api/admin/referrals/settings').set(auth(admin)).send({ enabled: true, rewardCredits: 20, maxRewardsPerClient: 3 }).expect(200)
    await signUp('CLIENT', code)
    expect(await balance(referrer)).toBe(40)
  })

  it('pays nothing while the admin has paused the programme, and resumes afterwards', async () => {
    const referrer = await makeClient()
    const admin = await makeAdmin()
    const code = await myCode(referrer)
    await api().put('/api/admin/referrals/settings').set(auth(admin)).send({ enabled: false, rewardCredits: 20, maxRewardsPerClient: 1 }).expect(200)
    expect((await api().get('/api/referrals/me').set(auth(referrer))).body).toMatchObject({ enabled: false, code: null })
    await signUp('CLIENT', code)
    expect(await balance(referrer)).toBe(0)
    await api().put('/api/admin/referrals/settings').set(auth(admin)).send({ enabled: true, rewardCredits: 20, maxRewardsPerClient: 1 }).expect(200)
    await signUp('CLIENT', code)
    expect(await balance(referrer)).toBe(20)
    expect(await prisma.auditLog.count({ where: { action: { in: ['REFERRALS_PAUSED', 'REFERRALS_RESUMED'] } } })).toBe(2)
  })

  it('uses the reward amount the admin sets', async () => {
    const referrer = await makeClient()
    const admin = await makeAdmin()
    await api().put('/api/admin/referrals/settings').set(auth(admin)).send({ enabled: true, rewardCredits: 50, maxRewardsPerClient: 1 }).expect(200)
    await signUp('CLIENT', await myCode(referrer))
    expect(await balance(referrer)).toBe(50)
  })

  it('ignores bad codes, provider sign-ups and non-client referrers without blocking sign-up', async () => {
    const referrer = await makeClient()
    const code = await myCode(referrer)
    await signUp('CLIENT', 'NOPE1234')
    await signUp('CLIENT', undefined)
    await signUp('PROVIDER', code) // only clients are rewarded
    expect(await balance(referrer)).toBe(0)
    const suspended = await makeClient({ accountStatus: 'SUSPENDED' })
    await prisma.user.update({ where: { id: suspended.id }, data: { referralCode: 'SUSP2345' } })
    await signUp('CLIENT', 'SUSP2345')
    expect(await balance(suspended)).toBe(0)
    expect(await prisma.referral.count()).toBe(0)
  })

  it('treats codes case-insensitively and never rewards the same person twice', async () => {
    const referrer = await makeClient()
    const code = await myCode(referrer)
    const friend = await signUp('CLIENT', code.toLowerCase())
    expect(await balance(referrer)).toBe(20)
    await api().post('/api/me/onboarding').set(auth(friend)).send({ role: 'CLIENT', username: 'again1', city: 'Lagos', acceptTerms: true, referralCode: code }).expect(409)
    expect(await balance(referrer)).toBe(20)
    expect(await prisma.referral.count()).toBe(1)
  })
})

describe('admin referral controls', () => {
  it('is admin-only, validates input and lists recent referrals', async () => {
    const admin = await makeAdmin()
    const c = await makeClient()
    await api().get('/api/admin/referrals').set(auth(c)).expect(403)
    await api().put('/api/admin/referrals/settings').set(auth(c)).send({ enabled: false, rewardCredits: 20, maxRewardsPerClient: 1 }).expect(403)
    await api().put('/api/admin/referrals/settings').set(auth(admin)).send({ enabled: true, rewardCredits: 0, maxRewardsPerClient: 1 }).expect(400)
    await api().put('/api/admin/referrals/settings').set(auth(admin)).send({ enabled: true, rewardCredits: 20, maxRewardsPerClient: -1 }).expect(400)
    await signUp('CLIENT', await myCode(c))
    const r = (await api().get('/api/admin/referrals').set(auth(admin)).expect(200)).body
    expect(r.settings).toMatchObject({ enabled: true, rewardCredits: 20, maxRewardsPerClient: 1 })
    expect(r.stats).toMatchObject({ referrals: 1, creditsGiven: 20 })
    expect(r.recent[0]).toMatchObject({ credits: 20 })
  })
})
