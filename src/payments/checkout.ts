import type { User } from '@prisma/client'
import { prisma } from '../db'
import { clientOrigins, isDev } from '../env'
import { badRequest } from '../lib/errors'
import { paymentProvider } from './provider'

/** Paystack rejects missing and reserved-TLD (.invalid) addresses, which seeded/dev accounts have. */
export const billingEmail = (u: Pick<User, 'id' | 'email'>) =>
  u.email && !/\.invalid$/i.test(u.email) ? u.email : `buyer-${u.id}@example.com`

/** Creates the provider's hosted checkout for a pending transaction and remembers its URL. */
export async function startCheckout(tx: { id: string; providerReference: string; amount: number; currency: string; checkoutUrl: string | null }, user: Pick<User, 'id' | 'email'>) {
  if (tx.checkoutUrl) return tx.checkoutUrl
  try {
    const { checkoutUrl } = await paymentProvider.createCheckout({
      reference: tx.providerReference, amount: tx.amount, currency: tx.currency,
      email: billingEmail(user), callbackUrl: `${clientOrigins[0]}/checkout/result/${tx.providerReference}`,
    })
    await prisma.transaction.update({ where: { id: tx.id }, data: { checkoutUrl } })
    return checkoutUrl
  } catch (e) {
    console.error('Payment checkout creation failed:', e)
    await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'FAILED' } })
    throw badRequest(`Could not start the payment. Please try again.${isDev ? ` (${e instanceof Error ? e.message : e})` : ''}`, 'CHECKOUT_FAILED')
  }
}
