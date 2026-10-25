import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PaystackProvider } from '../src/payments/provider'

const p = new PaystackProvider('sk_test_example')
const sign = (b: Buffer) => crypto.createHmac('sha512', 'sk_test_example').update(b).digest('hex')
const body = (o: unknown) => Buffer.from(JSON.stringify(o))

describe('Paystack driver', () => {
  it('accepts only a correct HMAC-SHA512 signature made with the secret key', () => {
    const b = body({ event: 'charge.success' })
    expect(p.verifyWebhookSignature(b, sign(b))).toBe(true)
    expect(p.verifyWebhookSignature(b, undefined)).toBe(false)
    expect(p.verifyWebhookSignature(b, 'deadbeef')).toBe(false)
    expect(p.verifyWebhookSignature(body({ event: 'charge.success', x: 1 }), sign(b))).toBe(false)
  })

  it('maps charge.success to a provider-neutral event with a stable id', () => {
    const e = p.parseWebhook(body({ event: 'charge.success', data: { id: 42, status: 'success', reference: 'jp_abc', amount: 500000, currency: 'NGN' } }))
    expect(e).toEqual({ id: 'charge.success:42', type: 'charge.success', data: { reference: 'jp_abc', amount: 500000, currency: 'NGN' } })
  })

  it('ignores other events, unsuccessful charges and garbage', () => {
    expect(p.parseWebhook(body({ event: 'transfer.success', data: { id: 1 } }))).toBeNull()
    expect(p.parseWebhook(body({ event: 'charge.success', data: { id: 1, status: 'failed', reference: 'r' } }))).toBeNull()
    expect(p.parseWebhook(Buffer.from('not json'))).toBeNull()
  })
})
