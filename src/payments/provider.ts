import crypto from 'node:crypto'
import { env } from '../env'
import { HttpError } from '../lib/errors'

/** A confirmed payment, translated from the provider's webhook / status payload. */
export type PaymentEvent = {
  id: string
  type: 'charge.success'
  data: { reference: string; amount: number; currency: string }
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

type PaystackTx = { id: number; status: string; reference: string; amount: number; currency: string }

/**
 * Paystack (https://paystack.com/docs). Amounts are in kobo, which is what we store.
 * Webhooks are signed with HMAC-SHA512 of the raw body using the SECRET KEY, in `x-paystack-signature`.
 * An unpaid or abandoned checkout simply stays PENDING.
 */
export class PaystackProvider {
  name = 'paystack'
  signatureHeader = 'x-paystack-signature'
  constructor(private secretKey: string) {}

  get configured() { return !!this.secretKey }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.secretKey) throw new HttpError(503, 'Payments are not set up yet (PAYSTACK_SECRET_KEY is missing)', 'PAYMENTS_NOT_CONFIGURED')
    const res = await fetch(`https://api.paystack.co${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    const json = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: T } | null
    if (!res.ok || !json?.status || !json.data) throw new Error(`Paystack ${path} failed: ${json?.message ?? res.status}`)
    return json.data
  }

  async createCheckout(tx: { reference: string; amount: number; currency: string; email: string; callbackUrl: string }) {
    const data = await this.call<{ authorization_url: string }>('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({ email: tx.email, amount: tx.amount, currency: tx.currency, reference: tx.reference, callback_url: tx.callbackUrl }),
    })
    return { checkoutUrl: data.authorization_url }
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined) {
    if (!signature) return false
    return safeEqual(crypto.createHmac('sha512', this.secretKey).update(rawBody).digest('hex'), signature)
  }

  private toEvent(t: PaystackTx): PaymentEvent {
    // Same id for the webhook and the status lookup, so whichever arrives second is a harmless duplicate.
    return { id: `charge.success:${t.id}`, type: 'charge.success', data: { reference: t.reference, amount: t.amount, currency: t.currency } }
  }

  parseWebhook(rawBody: Buffer) {
    try {
      const e = JSON.parse(rawBody.toString('utf8')) as { event?: string; data?: PaystackTx }
      if (e.event !== 'charge.success' || e.data?.status !== 'success' || !e.data.reference) return null
      return this.toEvent(e.data)
    } catch {
      return null
    }
  }

  async fetchPaymentEvent(reference: string) {
    const t = await this.call<PaystackTx>(`/transaction/verify/${encodeURIComponent(reference)}`)
    return t.status === 'success' ? this.toEvent(t) : null
  }
}

export const paymentProvider = new PaystackProvider(env.PAYSTACK_SECRET_KEY ?? '')
