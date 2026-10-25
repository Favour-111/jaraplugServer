import { beforeEach, describe, expect, it } from 'vitest'
import { api, auth, makeAdmin, makeClient, makeContent, makeProvider, prisma, resetAll } from './helpers'
import { outbox } from '../src/services/mailer'
import { env } from '../src/env'

beforeEach(async () => { await resetAll(); outbox.length = 0 })

const bank = { bankName: 'Zenith Bank', accountNumber: '0123456789', accountName: 'Amara Test' }

/** A provider with ₦4,000 released from the hold and ready to withdraw. */
async function richProvider(opts: { account?: boolean } = {}) {
  const provider = await makeProvider({ username: 'amara', email: 'amara@example.test' })
  const buyer = await makeClient({ creditBalance: 20 })
  const item = await makeContent(provider.id, { price: 500_000 })
  await api().post('/api/purchases/unlock').set(auth(buyer)).send({ contentId: item.id }).expect(201)
  await prisma.transaction.updateMany({ data: { paidAt: new Date(Date.now() - (env.PAYOUT_HOLD_DAYS + 1) * 86400_000) } })
  if (opts.account !== false) await api().put('/api/provider/payout-account').set(auth(provider)).send(bank).expect(200)
  return provider
}
const lastCode = () => /\n\s+(\d{6})\n/.exec(outbox[outbox.length - 1].text)![1]
const request = (p: any, amount = 400_000) => api().post('/api/provider/payouts/request').set(auth(p)).send({ amount })
const confirm = (p: any, otpId: string, code: string) => api().post('/api/provider/payouts/confirm').set(auth(p)).send({ otpId, code })

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

describe('email-confirmed withdrawals', () => {
  it('emails a code, creates the withdrawal only after the right code, and alerts the admin', async () => {
    const p = await richProvider()
    const admin = await makeAdmin()
    const r = (await request(p).expect(201)).body
    expect(outbox).toHaveLength(1)
    expect(outbox[0].to).toBe('amara@example.test')
    expect(await prisma.payout.count()).toBe(0) // nothing is created before confirmation

    const done = (await confirm(p, r.otpId, lastCode()).expect(201)).body
    expect(done).toMatchObject({ amount: 400_000, status: 'REQUESTED', arrivesWithinHours: 24 })
    const payout = await prisma.payout.findUniqueOrThrow({ where: { id: done.id } })
    expect(payout).toMatchObject({ bankName: 'Zenith Bank', accountNumber: '0123456789', accountName: 'Amara Test' })

    // the admin is emailed the bank details and gets an in-app alert; the provider gets a "within 24 hours" email
    await new Promise((res) => setTimeout(res, 50))
    const adminMail = outbox.find((m) => m.to === env.ADMIN_NOTIFY_EMAIL)!
    expect(adminMail.text).toContain('0123456789')
    expect(adminMail.text).toContain('Amara Test')
    expect(outbox.find((m) => m.to === 'amara@example.test' && /24 hours/.test(m.text))).toBeTruthy()
    expect(await prisma.notification.count({ where: { userId: admin.id, type: 'PAYOUT_REQUESTED' } })).toBe(1)

    // funds are reserved, and the earnings view only shows a masked account
    const e = (await api().get('/api/provider/earnings').set(auth(p)).expect(200)).body
    expect(e.summary.payableBalance).toBe(0)
    expect(JSON.stringify(e.payouts)).not.toContain('0123456789')
    expect(e.payouts[0]).toMatchObject({ status: 'REQUESTED', accountNumberMasked: '••••••6789' })
  })

  it('rejects wrong codes, locks after too many attempts, and a code works only once', async () => {
    const p = await richProvider()
    const r = (await request(p).expect(201)).body
    const good = lastCode()
    const bad = good === '000000' ? '111111' : '000000'
    expect((await confirm(p, r.otpId, bad).expect(400)).body.code).toBe('BAD_CODE')
    for (let i = 0; i < 4; i++) await confirm(p, r.otpId, bad).expect(400)
    expect((await confirm(p, r.otpId, good).expect(429)).body.code).toBe('TOO_MANY_ATTEMPTS') // even the right code is refused now
    expect(await prisma.payout.count()).toBe(0)

    const r2 = (await request(p).expect(201)).body
    const code2 = lastCode()
    await confirm(p, r2.otpId, code2).expect(201)
    await confirm(p, r2.otpId, code2).expect(400) // already used
    expect(await prisma.payout.count()).toBe(1)
  })

  it('refuses an expired code and another user\'s code', async () => {
    const p = await richProvider()
    const other = await makeProvider({ username: 'other1' })
    const r = (await request(p).expect(201)).body
    await confirm(other, r.otpId, lastCode()).expect(400)
    await prisma.payoutOtp.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } })
    expect((await confirm(p, r.otpId, lastCode()).expect(400)).body.code).toBe('CODE_EXPIRED')
  })

  it('needs a bank account, enough balance, the minimum amount and a valid email', async () => {
    const noAccount = await richProvider({ account: false })
    expect((await request(noAccount).expect(400)).body.code).toBe('NO_PAYOUT_ACCOUNT')
    await api().put('/api/provider/payout-account').set(auth(noAccount)).send(bank).expect(200)
    expect((await request(noAccount, 900_000_00).expect(409)).body.code).toBe('INSUFFICIENT_BALANCE')
    expect((await request(noAccount, 100).expect(400)).body.code).toBe('BELOW_MINIMUM')
    await prisma.user.update({ where: { id: noAccount.id }, data: { email: 'amara@demo.jaraplug.invalid' } })
    expect((await request(noAccount).expect(400)).body.code).toBe('EMAIL_REQUIRED')
    expect(outbox).toHaveLength(0)
  })

  it('never lets two confirmed withdrawals draw the same money', async () => {
    const p = await richProvider()
    const a = (await request(p).expect(201)).body
    const codeA = lastCode()
    const b = (await request(p).expect(201)).body // replaces the first code
    const codeB = lastCode()
    await confirm(p, a.otpId, codeA).expect(400) // first code was invalidated
    await confirm(p, b.otpId, codeB).expect(201)
    // balance is now zero: a new request is refused
    expect((await request(p).expect(409)).body.code).toBe('INSUFFICIENT_BALANCE')
  })

  it('lets the admin mark it paid and emails the provider', async () => {
    const p = await richProvider()
    const admin = await makeAdmin()
    const r = (await request(p).expect(201)).body
    const { id } = (await confirm(p, r.otpId, lastCode()).expect(201)).body
    const list = (await api().get('/api/admin/payouts').set(auth(admin)).expect(200)).body.items
    expect(list[0]).toMatchObject({ bankName: 'Zenith Bank', accountNumber: '0123456789', accountName: 'Amara Test', status: 'REQUESTED' })
    outbox.length = 0
    await api().post(`/api/admin/payouts/${id}/decide`).set(auth(admin)).send({ decision: 'paid', reason: 'Sent via bank transfer' }).expect(200)
    await new Promise((res) => setTimeout(res, 50))
    expect(outbox.find((m) => m.to === 'amara@example.test' && /sent/i.test(m.subject))).toBeTruthy()
    expect((await prisma.payout.findUniqueOrThrow({ where: { id } })).status).toBe('PAID')
  })
})
