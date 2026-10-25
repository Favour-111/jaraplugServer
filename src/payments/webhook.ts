import { Prisma } from '@prisma/client'
import { prisma } from '../db'
import { env } from '../env'
import { HttpError } from '../lib/errors'
import { splitAmount } from '../lib/money'
import { notify } from '../services/notify'
import { creditWallet, kobotoCredits } from '../services/credits'
import { paymentProvider, type PaymentEvent } from './provider'

export type WebhookResult = { status: 'processed' | 'duplicate' | 'ignored'; reference?: string }

/**
 * Processes a payment-provider webhook. Safe to call any number of times with the same event:
 *  1. the signature is verified over the raw body;
 *  2. the event id is inserted under a UNIQUE constraint (replays become no-ops);
 *  3. the transaction row is locked and only moves PENDING → SUCCESS/FAILED once;
 *  4. the amount/currency in the event must equal what WE stored — the event's numbers are never trusted;
 *  5. the entitlement row has UNIQUE(buyerId, contentId).
 * All of it happens inside one DB transaction, so a crash can never leave a paid-but-not-entitled state.
 */
export async function processPaymentWebhook(rawBody: Buffer, signature: string | undefined): Promise<WebhookResult> {
  if (!paymentProvider.verifyWebhookSignature(rawBody, signature)) {
    throw new HttpError(401, 'Invalid webhook signature', 'BAD_SIGNATURE')
  }
  const event = paymentProvider.parseWebhook(rawBody)
  if (!event) return { status: 'ignored' }
  return applyPaymentEvent(event)
}

/** Applies an already-authenticated payment event (from a verified webhook or a direct provider status lookup). */
export async function applyPaymentEvent(event: PaymentEvent): Promise<WebhookResult> {
  try {
    return await prisma.$transaction(async (db) => {
      await db.webhookEvent.create({
        data: { provider: paymentProvider.name, eventId: event.id, eventType: event.type, payload: event as unknown as Prisma.InputJsonValue },
      })

      const rows = await db.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Transaction" WHERE "providerReference" = ${event.data.reference} FOR UPDATE`
      if (rows.length === 0) return { status: 'ignored' as const, reference: event.data.reference }
      const tx = await db.transaction.findUniqueOrThrow({ where: { id: rows[0].id } })

      if (tx.status !== 'PENDING') return { status: 'ignored' as const, reference: tx.providerReference }

      if (event.data.amount !== tx.amount || event.data.currency !== tx.currency) {
        await db.transaction.update({ where: { id: tx.id }, data: { status: 'FAILED' } })
        await db.webhookEvent.updateMany({ where: { provider: paymentProvider.name, eventId: event.id }, data: { processedAt: new Date() } })
        console.error(`Webhook amount mismatch for ${tx.providerReference}: expected ${tx.amount}, got ${event.data.amount}`)
        return { status: 'ignored' as const, reference: tx.providerReference }
      }

      if (tx.transactionType === 'CREDIT_TOPUP') {
        const credits = kobotoCredits(tx.amount)
        if (credits === null) {
          await db.transaction.update({ where: { id: tx.id }, data: { status: 'FAILED' } })
          return { status: 'ignored' as const, reference: tx.providerReference }
        }
        await db.transaction.update({ where: { id: tx.id }, data: { status: 'SUCCESS', paidAt: new Date() } })
        await creditWallet(db, tx.userId, credits, 'TOPUP', { transactionId: tx.id })
        await db.webhookEvent.updateMany({ where: { provider: paymentProvider.name, eventId: event.id }, data: { processedAt: new Date() } })
        return { status: 'processed' as const, reference: tx.providerReference }
      }

      const content = tx.contentId ? await db.mediaContent.findUnique({ where: { id: tx.contentId } }) : null
      if (!content) {
        await db.transaction.update({ where: { id: tx.id }, data: { status: 'FAILED' } })
        return { status: 'ignored' as const, reference: tx.providerReference }
      }

      const { platformFee, processingFee, netAmount } = splitAmount(tx.amount, env.PLATFORM_COMMISSION_BPS, 0)
      await db.transaction.update({
        where: { id: tx.id },
        data: { status: 'SUCCESS', paidAt: new Date(), platformFee, processingFee, netAmount },
      })
      await db.contentPurchase.upsert({
        where: { buyerId_contentId: { buyerId: tx.userId, contentId: content.id } },
        update: { status: 'COMPLETED', transactionId: tx.id },
        create: { buyerId: tx.userId, contentId: content.id, transactionId: tx.id, amount: tx.amount, status: 'COMPLETED' },
      })
      await db.webhookEvent.updateMany({ where: { provider: paymentProvider.name, eventId: event.id }, data: { processedAt: new Date() } })
      return { status: 'processed' as const, reference: tx.providerReference }
    })
      .then(async (result) => {
        if (result.status === 'processed') await afterSuccess(result.reference!)
        return result
      })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return { status: 'duplicate' }
    }
    throw e
  }
}

export async function notifyPurchase(reference: string) {
  const tx = await prisma.transaction.findUnique({ where: { providerReference: reference } })
  if (!tx || tx.status !== 'SUCCESS' || tx.transactionType !== 'CONTENT_PURCHASE') return
  const content = tx.contentId ? await prisma.mediaContent.findUnique({ where: { id: tx.contentId } }) : null
  await notify(tx.userId, 'PURCHASE_COMPLETED', 'Purchase complete', content ? `You unlocked “${content.title}”.` : '', '/app/purchases').catch(() => {})
  if (tx.payeeId) await notify(tx.payeeId, 'CONTENT_SOLD', 'New content purchase', content ? `“${content.title}” was purchased.` : '', '/provider/earnings').catch(() => {})
}

async function afterSuccess(reference: string) {
  const tx = await prisma.transaction.findUnique({ where: { providerReference: reference } })
  if (tx?.transactionType === 'CREDIT_TOPUP') {
    const credits = kobotoCredits(tx.amount)
    await notify(tx.userId, 'PURCHASE_COMPLETED', 'Credits added', `${credits} credit${credits === 1 ? '' : 's'} added to your wallet.`, '/app/credits').catch(() => {})
    return
  }
  await notifyPurchase(reference)
}
