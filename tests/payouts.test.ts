import { beforeEach, describe, expect, it } from 'vitest'
import { api, auth, makeAdmin, makeClient, makeContent, makeProvider, prisma, resetAll } from './helpers'
import { env } from '../src/env'

beforeEach(resetAll)

const bank = { bankName: 'Zenith Bank', accountNumber: '0123456789', accountName: 'Amara Test' }

/** A provider with ₦4,000 earned and ready to withdraw. */
async function richProvider(opts: { account?: boolean } = {}) {
  const provider = await makeProvider({ username: 'amara' })
  const buyer = await makeClient({ creditBalance: 20 })
  const item = await makeContent(provider.id, { price: 500_000 })
  await api().post('/api/purchases/unlock').set(auth(buyer)).send({ contentId: item.id }).expect(201)
  await prisma.transaction.updateMany({ data: { paidAt: new Date(Date.now() - (env.PAYOUT_HOLD_DAYS + 1) * 86400_000) } })
  if (opts.account !== false) await api().put('/api/provider/payout-account').set(auth(provider)).send(bank).expect(200)
  return provider
}
const withdraw = (p: any, amount = 400_000) => api().post('/api/provider/payouts').set(auth(p)).send({ amount })

describe('payout account', () => {
  it('saves a bank account, never returns the full number and validates input', async () => {
    const p = await makeProvider({ username: 'amara' })
    expect((await api().get('/api/provider/payout-account').set(auth(p)).expect(200)).body.account).toBeNull()
    await api().put('/api/provider/payout-account').set(auth(p)).send({ ...bank, accountNumber: '123' }).expect(400)
    await api().put('/api/provider/payout-account').set(auth(p)).send({ ...bank, bankName: 'Fake Bank' }).expect(400)
    await api().put('/api/provider/payout-account').set(auth(p)).send(bank).expect(200)
    const got = (await api().get('/api/provider/payout-account').set(auth(p)).expect(200)).body
    expect(got.account).toMatchObject({ bankName: 'Zenith Bank', accountName: 'Amara Test' })
    expect(JSON.stringify(got)).not.toContain('0123456789')
    await api().put('/api/provider/payout-account').set(auth(await makeClient())).send(bank).expect(403)
  })
})

describe('withdrawals', () => {
  it('creates a payout request with the bank details and alerts the admin', async () => {
    const p = await richProvider()
    const admin = await makeAdmin()
    const done = (await withdraw(p).expect(201)).body
    expect(done).toMatchObject({ amount: 400_000, status: 'REQUESTED', arrivesWithinHours: 24 })
    const payout = await prisma.payout.findUniqueOrThrow({ where: { id: done.id } })
    expect(payout).toMatchObject({ bankName: 'Zenith Bank', accountNumber: '0123456789', accountName: 'Amara Test' })
    expect(await prisma.notification.count({ where: { userId: admin.id, type: 'PAYOUT_REQUESTED' } })).toBe(1)

    // funds are reserved, and the earnings view only shows a masked account
    const e = (await api().get('/api/provider/earnings').set(auth(p)).expect(200)).body
    expect(e.summary.payableBalance).toBe(0)
    expect(JSON.stringify(e.payouts)).not.toContain('0123456789')
    expect(e.payouts[0]).toMatchObject({ status: 'REQUESTED', accountNumberMasked: '••••••6789' })
  })

  it('needs a bank account, enough balance, the minimum amount and a verified provider', async () => {
    const p = await richProvider({ account: false })
    expect((await withdraw(p).expect(400)).body.code).toBe('NO_PAYOUT_ACCOUNT')
    await api().put('/api/provider/payout-account').set(auth(p)).send(bank).expect(200)
    expect((await withdraw(p, 900_000_00).expect(409)).body.code).toBe('INSUFFICIENT_BALANCE')
    expect((await withdraw(p, 100).expect(400)).body.code).toBe('BELOW_MINIMUM')
    await api().post('/api/provider/payouts').send({ amount: 400_000 }).expect(401)
    await withdraw(await makeClient()).expect(403)
    expect(await prisma.payout.count()).toBe(0)
  })

  it('never lets simultaneous requests draw the same money', async () => {
    const p = await richProvider()
    const results = await Promise.all([1, 2, 3, 4].map(() => withdraw(p)))
    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    expect(results.filter((r) => r.status === 409)).toHaveLength(3)
    expect(await prisma.payout.count()).toBe(1)
    expect((await withdraw(p).expect(409)).body.code).toBe('INSUFFICIENT_BALANCE')
  })

  it('lets the admin see the bank details, mark it paid, or reject it and free the balance', async () => {
    const p = await richProvider()
    const admin = await makeAdmin()
    const { id } = (await withdraw(p).expect(201)).body
    const list = (await api().get('/api/admin/payouts').set(auth(admin)).expect(200)).body.items
    expect(list[0]).toMatchObject({ bankName: 'Zenith Bank', accountNumber: '0123456789', accountName: 'Amara Test', status: 'REQUESTED' })

    await api().post(`/api/admin/payouts/${id}/decide`).set(auth(admin)).send({ decision: 'rejected', reason: 'Name does not match' }).expect(200)
    expect((await api().get('/api/provider/earnings').set(auth(p))).body.summary.payableBalance).toBe(400_000)
    expect(await prisma.notification.count({ where: { userId: p.id, type: 'PAYOUT' } })).toBeGreaterThan(0)

    const second = (await withdraw(p).expect(201)).body.id
    await api().post(`/api/admin/payouts/${second}/decide`).set(auth(admin)).send({ decision: 'paid', reason: 'Sent via bank transfer' }).expect(200)
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: second } })).status).toBe('PAID')
  })
})
