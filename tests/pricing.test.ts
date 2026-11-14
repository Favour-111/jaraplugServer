import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api, auth, makeClient, makeUser, postWebhook, prisma, resetAll, signedEvent } from './helpers'
import { env } from '../src/env'
import { creditPriceIn, currencyFor, pricingFor } from '../src/config/pricing'

beforeEach(resetAll)

const topup = (u: any, credits: number) => api().post('/api/credits/topup').set(auth(u)).send({ credits })
const balance = async (u: { id: string }) => (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).creditBalance

describe('location-based credit pricing', () => {
  it('maps countries to a currency Paystack can charge in', () => {
    expect(currencyFor('NG')).toBe('NGN')
    expect(currencyFor(null)).toBe('NGN') // accounts created before countries existed keep paying in naira
    expect(currencyFor('GB')).toBe('USD')
    expect(currencyFor('US')).toBe('USD')
    expect(pricingFor('NG').creditPrice).toBe(env.CREDIT_PRICE_KOBO)
  })

  it('sells credits to a buyer abroad in USD and credits the wallet when the USD payment is confirmed', async () => {
    const buyer = await makeClient({ country: 'GB' })
    const w = await api().get('/api/credits').set(auth(buyer)).expect(200)
    const usd = creditPriceIn('USD')
    expect(w.body).toMatchObject({ country: 'GB', countryName: 'United Kingdom', currency: 'USD', creditPrice: usd })

    const credits = Math.max(50, w.body.minTopup)
    const r = await topup(buyer, credits).expect(201)
    expect(r.body).toMatchObject({ credits, currency: 'USD', amount: credits * usd })
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { providerReference: r.body.reference } })
    expect(tx).toMatchObject({ currency: 'USD', amount: credits * usd, credits })

    // A webhook claiming naira for a USD transaction is rejected.
    await postWebhook(signedEvent(r.body.reference, credits * usd, { currency: 'NGN' })).expect(200)
    expect(await balance(buyer)).toBe(0)

    const r2 = await topup(buyer, credits).expect(201)
    await postWebhook(signedEvent(r2.body.reference, credits * usd, { currency: 'USD' })).expect(200)
    expect(await balance(buyer)).toBe(credits)
    const v = await api().get(`/api/purchases/verify/${r2.body.reference}`).set(auth(buyer)).expect(200)
    expect(v.body).toMatchObject({ status: 'SUCCESS', credits })
  })

  it('enforces the smallest charge Paystack accepts in the buyer currency', async () => {
    const buyer = await makeClient({ country: 'US' })
    const { minTopup } = pricingFor('US')
    if (minTopup > 1) await topup(buyer, minTopup - 1).expect(400)
    await topup(buyer, minTopup).expect(201)
  })

  describe('when Paystack refuses the foreign currency', () => {
    const original = globalThis.fetch
    afterEach(() => { globalThis.fetch = original })

    it('charges the same credits in NGN instead', async () => {
      globalThis.fetch = (async (input: any, init?: any) => {
        if (String(input).includes('/transaction/initialize') && JSON.parse(init.body).currency !== 'NGN')
          return new Response(JSON.stringify({ status: false, message: 'Currency not supported by merchant' }), { status: 400 })
        return original(input, init)
      }) as typeof fetch
      const buyer = await makeClient({ country: 'GB' })
      const credits = pricingFor('GB').minTopup
      const r = await topup(buyer, credits).expect(201)
      const tx = await prisma.transaction.findUniqueOrThrow({ where: { providerReference: r.body.reference } })
      expect(tx).toMatchObject({ currency: 'NGN', amount: credits * env.CREDIT_PRICE_KOBO, credits, status: 'PENDING' })
      await postWebhook(signedEvent(r.body.reference, credits * env.CREDIT_PRICE_KOBO)).expect(200)
      expect(await balance(buyer)).toBe(credits)
    })
  })

  it('saves the country at onboarding and lets the user change it, rejecting made-up codes', async () => {
    const u = await makeUser({ role: 'UNASSIGNED', onboardedAt: null, username: null })
    const body = { role: 'CLIENT', username: 'abroad_buyer', city: 'London', acceptTerms: true }
    await api().post('/api/me/onboarding').set(auth(u)).send({ ...body, country: 'XX' }).expect(400)
    const r = await api().post('/api/me/onboarding').set(auth(u)).send({ ...body, country: 'gb' }).expect(201)
    expect(r.body.country).toBe('GB')
    await api().patch('/api/me').set(auth(u)).send({ country: 'Nigeria' }).expect(400)
    const p = await api().patch('/api/me').set(auth(u)).send({ country: 'NG' }).expect(200)
    expect(p.body.country).toBe('NG')
  })
})
