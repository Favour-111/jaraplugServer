import type { User } from '@prisma/client'
import { prisma } from '../db'
import { clientOrigins, isDev } from '../env'
import { badRequest } from '../lib/errors'
import { paymentProvider } from './provider'
import { amountFor, creditPriceIn } from '../config/pricing'

/** Paystack rejects missing and reserved-TLD (.invalid) addresses, which seeded/dev accounts have. */
export const billingEmail = (u: Pick<User, 'id' | 'email'>) =>
  u.email && !/\.invalid$/i.test(u.email) ? u.email : `buyer-${u.id}@example.com`

/** Creates the provider's hosted checkout for a pending transaction and remembers its URL. */
type PendingTx = { id: string; providerReference: string; amount: number; currency: string; credits?: number | null; checkoutUrl: string | null }

export async function startCheckout(tx: PendingTx, user: Pick<User, 'id' | 'email'>): Promise<string> {
  if (tx.checkoutUrl) return tx.checkoutUrl
  const create = (t: PendingTx) => paymentProvider.createCheckout({
    reference: t.providerReference, amount: t.amount, currency: t.currency,
    email: billingEmail(user), callbackUrl: `${clientOrigins[0]}/checkout/result/${t.providerReference}`,
  })
  try {
    let { amount, currency } = tx
    let checkoutUrl: string
    try {
      ({ checkoutUrl } = await create(tx))
    } catch (e) {
      // A foreign currency that isn't switched on for the Paystack account: charge the same credits in NGN instead.
      // Paystack still accepts international cards for NGN payments; the card issuer does the conversion.
      if (tx.currency === 'NGN' || !tx.credits) throw e
      console.warn(`Paystack refused ${tx.currency} for ${tx.providerReference}, retrying in NGN:`, e instanceof Error ? e.message : e)
      amount = amountFor(tx.credits, await creditPriceIn('NGN'))
      currency = 'NGN'
      ;({ checkoutUrl } = await create({ ...tx, amount, currency }))
    }
    await prisma.transaction.update({ where: { id: tx.id }, data: { checkoutUrl, amount, currency } })
    return checkoutUrl
  } catch (e) {
    console.error('Payment checkout creation failed:', e)
    await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'FAILED' } })
    throw badRequest(`Could not start the payment. Please try again.${isDev ? ` (${e instanceof Error ? e.message : e})` : ''}`, 'CHECKOUT_FAILED')
  }
}
