import { beforeEach, describe, expect, it } from 'vitest'
import { api, auth, makeAdmin, makeClient, makeContent, makeProvider, pathOf, paystackTx, postWebhook, prisma, resetAll, signedEvent } from './helpers'
import { env } from '../src/env'

beforeEach(resetAll)

async function setup(credits = 20) {
  const provider = await makeProvider({ username: 'amara' })
  const buyer = await makeClient({ creditBalance: credits })
  const item = await makeContent(provider.id, { price: 500_000 }) // ₦5,000 = 10 credits
  return { provider, buyer, item }
}
const unlock = (buyer: any, contentId: string) => api().post('/api/purchases/unlock').set(auth(buyer)).send({ contentId })
const topup = (buyer: any, credits: number) => api().post('/api/credits/topup').set(auth(buyer)).send({ credits })
const balance = async (u: { id: string }) => (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).creditBalance

describe('unlocking content with credits', () => {
  it('charges the price from the database in credits and grants access to that one item', async () => {
    const { buyer, item, provider } = await setup()
    const other = await makeContent(provider.id, { title: 'Other paid item' })
    const r = await api().post('/api/purchases/unlock').set(auth(buyer)).send({ contentId: item.id, amount: 1, credits: 1, price: 1 }).expect(201)
    expect(r.body).toMatchObject({ ok: true, credits: 10, balance: 10 })
    expect(await balance(buyer)).toBe(10)

    const tx = await prisma.transaction.findUniqueOrThrow({ where: { providerReference: r.body.reference } })
    expect(tx).toMatchObject({ status: 'SUCCESS', provider: 'credits', amount: 500_000, transactionType: 'CONTENT_PURCHASE' })
    expect(tx.platformFee).toBe(Math.round(500_000 * env.PLATFORM_COMMISSION_BPS / 10_000))
    expect(tx.netAmount).toBe(500_000 - tx.platformFee - tx.processingFee)
    expect(await prisma.creditLedger.findMany({ where: { userId: buyer.id } })).toMatchObject([{ type: 'PURCHASE', delta: -10, balanceAfter: 10 }])

    const access = await api().post(`/api/content/${item.id}/access`).set(auth(buyer)).expect(200)
    await api().get(pathOf(access.body.url)).expect(200)
    await api().post(`/api/content/${other.id}/access`).set(auth(buyer)).expect(403) // only the purchased item
    const lib = await api().get('/api/me/purchases').set(auth(buyer)).expect(200)
    expect(lib.body.items.map((i: any) => i.content.id)).toEqual([item.id])
    expect((await api().get('/api/providers/amara').set(auth(buyer))).body.content.find((c: any) => c.id === item.id).url).toBeTruthy()
    await api().post(`/api/content/${item.id}/access`).set(auth(await makeClient())).expect(403)
    await unlock(buyer, item.id).expect(409) // already owned, not charged twice
    expect(await balance(buyer)).toBe(10)
  })

  it('refuses when the wallet is short and changes nothing', async () => {
    const { buyer, item } = await setup(9)
    const r = await unlock(buyer, item.id).expect(402)
    expect(r.body.code).toBe('INSUFFICIENT_CREDITS')
    expect(await balance(buyer)).toBe(9)
    expect(await prisma.contentPurchase.count()).toBe(0)
    expect(await prisma.transaction.count()).toBe(0)
    await api().post(`/api/content/${item.id}/access`).set(auth(buyer)).expect(403)
  })

  it('spends the credits only once when the same unlock is sent concurrently', async () => {
    const { buyer, item } = await setup(30)
    const results = await Promise.all(Array.from({ length: 6 }, () => unlock(buyer, item.id)))
    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    expect(results.filter((r) => r.status === 409)).toHaveLength(5)
    expect(await balance(buyer)).toBe(20)
    expect(await prisma.contentPurchase.count()).toBe(1)
    expect(await prisma.transaction.count()).toBe(1)
    expect(await prisma.notification.count({ where: { type: 'CONTENT_SOLD' } })).toBe(1)
  })

  it('rejects unverified buyers, own content, unpublished content, and free content', async () => {
    const { provider, item } = await setup()
    const unverified = await makeClient({ ageVerificationStatus: 'NOT_STARTED', creditBalance: 50 })
    expect((await unlock(unverified, item.id).expect(403)).body.code).toBe('AGE_VERIFICATION_REQUIRED')
    await unlock(provider, item.id).expect(403)
    const buyer = await makeClient({ creditBalance: 50 })
    const pending = await makeContent(provider.id, { moderationStatus: 'PENDING' })
    await unlock(buyer, pending.id).expect(404)
    const free = await makeContent(provider.id, { visibility: 'PUBLIC', price: 0 })
    await unlock(buyer, free.id).expect(404)
    expect(await balance(buyer)).toBe(50)
  })

  it('refuses an item whose price is not a whole number of credits', async () => {
    const { provider } = await setup()
    const buyer = await makeClient({ creditBalance: 50 })
    const odd = await makeContent(provider.id, { price: 123_400 })
    expect((await unlock(buyer, odd.id).expect(400)).body.code).toBe('NOT_PRICED_IN_CREDITS')
    expect(await balance(buyer)).toBe(50)
  })
})

describe('buying credits', () => {
  it('creates a pending top-up priced from configuration and adds nothing until payment is confirmed', async () => {
    const { buyer } = await setup(0)
    const r = await api().post('/api/credits/topup').set(auth(buyer)).send({ credits: 5, amount: 1 }).expect(201)
    expect(r.body).toMatchObject({ credits: 5, amount: 250_000 }) // 5 × ₦500
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { providerReference: r.body.reference } })
    expect(tx).toMatchObject({ status: 'PENDING', transactionType: 'CREDIT_TOPUP', payeeId: null })
    expect(await balance(buyer)).toBe(0)
    const v = await api().get(`/api/purchases/verify/${r.body.reference}`).set(auth(buyer)).expect(200)
    expect(v.body).toMatchObject({ status: 'PENDING', type: 'CREDIT_TOPUP', credits: 5 })
  })

  it('validates the quantity and requires a verified adult', async () => {
    const { buyer } = await setup(0)
    await topup(buyer, 0).expect(400)
    await topup(buyer, 2001).expect(400)
    await topup(buyer, 1.5).expect(400)
    await topup(await makeClient({ ageVerificationStatus: 'NOT_STARTED' }), 5).expect(403)
    await api().post('/api/credits/topup').send({ credits: 5 }).expect(401)
    expect(await prisma.transaction.count()).toBe(0)
  })

  it('adds the credits when the signed webhook confirms the payment, exactly once', async () => {
    const { buyer } = await setup(0)
    const co = (await topup(buyer, 5)).body
    const e = signedEvent(co.reference, co.amount)
    expect((await postWebhook(e).expect(200)).body.status).toBe('processed')
    expect(await balance(buyer)).toBe(5)
    expect((await postWebhook(e).expect(200)).body.status).toBe('duplicate')
    expect((await postWebhook(signedEvent(co.reference, co.amount)).expect(200)).body.status).toBe('ignored')
    expect(await balance(buyer)).toBe(5)
    expect(await prisma.creditLedger.findMany({ where: { userId: buyer.id } })).toMatchObject([{ type: 'TOPUP', delta: 5, balanceAfter: 5 }])
    expect((await api().get('/api/credits').set(auth(buyer))).body).toMatchObject({ balance: 5, creditPriceKobo: env.CREDIT_PRICE_KOBO })
  })

  it('credits once when the same webhook arrives concurrently', async () => {
    const { buyer } = await setup(0)
    const co = (await topup(buyer, 5)).body
    const e = signedEvent(co.reference, co.amount)
    const results = await Promise.all(Array.from({ length: 6 }, () => postWebhook(e)))
    expect(results.every((r) => r.status === 200)).toBe(true)
    expect(results.filter((r) => r.body.status === 'processed')).toHaveLength(1)
    expect(await balance(buyer)).toBe(5)
  })

  it('rejects bad signatures, never trusts the webhook amount, and ignores failed charges', async () => {
    const { buyer } = await setup(0)
    const co = (await topup(buyer, 5)).body
    const e = signedEvent(co.reference, co.amount)
    await api().post('/api/webhooks/payments').set('content-type', 'application/json').send(e.body.toString()).expect(401)
    await postWebhook({ body: e.body, signature: 'deadbeef' }).expect(401)
    expect(await balance(buyer)).toBe(0)
    await postWebhook(signedEvent(co.reference, 100)).expect(200) // amount mismatch
    expect((await prisma.transaction.findFirstOrThrow()).status).toBe('FAILED')
    const co2 = (await topup(buyer, 2)).body
    await postWebhook(signedEvent(co2.reference, co2.amount, { event: 'charge.failed' })).expect(200)
    expect(await balance(buyer)).toBe(0)
    expect((await postWebhook(signedEvent('jp_unknown', 1)).expect(200)).body.status).toBe('ignored')
  })

  it('only lets the buyer look up a transaction, and settles a late webhook by asking Paystack directly', async () => {
    const { buyer } = await setup(0)
    const intruder = await makeClient()
    const co = (await topup(buyer, 5)).body
    expect(co.checkoutUrl).toContain('checkout.paystack.com')
    await api().get(`/api/purchases/verify/${co.reference}`).set(auth(intruder)).expect(404)
    await api().get(`/api/purchases/verify/${co.reference}`).expect(401)

    // Unpaid: Paystack reports "abandoned", so nothing is credited.
    expect((await api().get(`/api/purchases/verify/${co.reference}`).set(auth(buyer)).expect(200)).body.status).toBe('PENDING')
    expect(await balance(buyer)).toBe(0)

    // Paid but the webhook has not arrived yet: the status lookup settles it, once.
    paystackTx.set(co.reference, { id: 777, status: 'success', amount: co.amount, currency: 'NGN' })
    const v = (await api().get(`/api/purchases/verify/${co.reference}`).set(auth(buyer)).expect(200)).body
    expect(v).toMatchObject({ status: 'SUCCESS', type: 'CREDIT_TOPUP', credits: 5 })
    expect(await balance(buyer)).toBe(5)
    await api().get(`/api/purchases/verify/${co.reference}`).set(auth(buyer)).expect(200)
    // ... and the real webhook for the same Paystack transaction is then a harmless duplicate.
    expect((await postWebhook(signedEvent(co.reference, co.amount, { id: 777 })).expect(200)).body.status).toBe('duplicate')
    expect(await balance(buyer)).toBe(5)
  })
})

describe('refunds, earnings & payouts', () => {
  async function paid() {
    const ctx = await setup()
    const co = (await unlock(ctx.buyer, ctx.item.id).expect(201)).body
    return { ...ctx, co }
  }
  it('computes provider earnings from verified transactions only', async () => {
    const { provider, buyer, item } = await paid()
    await topup(buyer, 5).expect(201) // a pending top-up has no payee and must not count
    const r = await api().get('/api/provider/earnings').set(auth(provider)).expect(200)
    expect(r.body.summary).toMatchObject({ grossAmount: 500_000, platformFees: 100_000, netEarnings: 400_000, salesCount: 1, pendingBalance: 400_000, payableBalance: 0 })
    // buyers are not identified to the provider
    expect(JSON.stringify(r.body)).not.toContain(buyer.username as string)
    void item
  })
  it('does not allow a provider to edit earnings or request more than the payable balance', async () => {
    const { provider } = await paid()
    await prisma.payoutAccount.create({ data: { userId: provider.id, bankName: 'Zenith Bank', accountNumber: '0123456789', accountName: 'Amara Test' } })
    await api().put('/api/provider/earnings').set(auth(provider)).send({ netEarnings: 999999 }).expect(404)
    const r = await api().post('/api/provider/payouts').set(auth(provider)).send({ amount: 400_000 }).expect(409) // still inside the hold window
    expect(r.body.code).toBe('INSUFFICIENT_BALANCE')
    await api().post('/api/provider/payouts').set(auth(provider)).send({ amount: 100 }).expect(400)
  })
  it('lets an admin refund a purchase, which revokes access, returns the credits and removes the amount from earnings', async () => {
    const { provider, buyer, item, co } = await paid()
    const admin = await makeAdmin()
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { providerReference: co.reference } })
    await api().post(`/api/admin/transactions/${tx.id}/refund`).set(auth(buyer)).send({ reason: 'nope nope' }).expect(403)
    await api().post(`/api/admin/transactions/${tx.id}/refund`).set(auth(admin)).send({ reason: 'x' }).expect(400)
    await api().post(`/api/admin/transactions/${tx.id}/refund`).set(auth(admin)).send({ reason: 'Disputed purchase upheld' }).expect(200)
    await api().post(`/api/content/${item.id}/access`).set(auth(buyer)).expect(403)
    const e = (await api().get('/api/provider/earnings').set(auth(provider))).body.summary
    expect(e).toMatchObject({ netEarnings: 0, refundedAmount: 500_000, refundCount: 1 })
    // the credits go back into the buyer's wallet (20 - 10 + 10), once
    expect(await balance(buyer)).toBe(20)
    await api().post(`/api/admin/transactions/${tx.id}/refund`).set(auth(admin)).send({ reason: 'Second attempt' }).expect(409)
    expect(await balance(buyer)).toBe(20)
    expect(await prisma.auditLog.count({ where: { action: 'TRANSACTION_REFUNDED' } })).toBe(1)
  })
})

describe('credit top-ups cannot be refunded as purchases', () => {
  it('returns 409 for an admin refund attempt on a paid top-up', async () => {
    const { buyer } = await setup(0)
    const admin = await makeAdmin()
    const co = (await topup(buyer, 5)).body
    await postWebhook(signedEvent(co.reference, co.amount)).expect(200)
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { providerReference: co.reference } })
    expect((await api().post(`/api/admin/transactions/${tx.id}/refund`).set(auth(admin)).send({ reason: 'Customer asked nicely' }).expect(409)).body.code).toBe('TOPUP_NOT_REFUNDABLE')
    expect(await balance(buyer)).toBe(5)
  })
})

describe('temporary admin credit gift', () => {
  it('lets only an admin add credits to an active client, with an audit record', async () => {
    const buyer = await makeClient()
    const admin = await makeAdmin()
    const provider = await makeProvider({ username: 'gift_pro' })
    await api().post(`/api/admin/users/${buyer.id}/credits`).set(auth(buyer)).send({ credits: 5, reason: 'give me credits' }).expect(403)
    await api().post(`/api/admin/users/${buyer.id}/credits`).set(auth(admin)).send({ credits: 5, reason: 'x' }).expect(400)
    await api().post(`/api/admin/users/${buyer.id}/credits`).set(auth(admin)).send({ credits: 0, reason: 'Launch gift' }).expect(400)
    await api().post(`/api/admin/users/${provider.id}/credits`).set(auth(admin)).send({ credits: 5, reason: 'Launch gift' }).expect(404) // not a client
    const r = await api().post(`/api/admin/users/${buyer.id}/credits`).set(auth(admin)).send({ credits: 5, reason: 'Launch gift' }).expect(200)
    expect(r.body.balance).toBe(5)
    expect(await balance(buyer)).toBe(5)
    expect(await prisma.auditLog.count({ where: { action: 'CREDITS_GRANTED' } })).toBe(1)
  })
})
