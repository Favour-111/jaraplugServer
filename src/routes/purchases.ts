import { Router, raw } from 'express'
import crypto from 'node:crypto'
import { z } from 'zod'
import { prisma } from '../db'
import { env } from '../env'
import { conflict, forbidden, notFound, wrap, badRequest } from '../lib/errors'
import { me, requireAuth, requireVerifiedAdult } from '../auth'
import { isBlockedEitherWay } from '../services/blocks'
import { isListable } from '../services/content'
import { paymentProvider } from '../payments/provider'
import { applyPaymentEvent, notifyPurchase, processPaymentWebhook } from '../payments/webhook'
import { splitAmount } from '../lib/money'
import { debitWallet, kobotoCredits } from '../services/credits'

/** Mounted BEFORE the JSON body parser: signature verification needs the raw bytes. */
export const webhookRouter = Router()
webhookRouter.post('/payments', raw({ type: '*/*', limit: '256kb' }), wrap(async (req, res) => {
  const sig = (req.headers[paymentProvider.signatureHeader] as string | undefined) ?? undefined
  const result = await processPaymentWebhook(req.body as Buffer, sig)
  res.json({ received: true, ...result })
}))

export const purchasesRouter = Router()
purchasesRouter.use(requireAuth)

/**
 * Unlock paid content with in-app credits. Everything happens in ONE database transaction under a lock on the buyer's row,
 * so two simultaneous taps can never spend credits twice or create two entitlements.
 */
purchasesRouter.post('/unlock', requireVerifiedAdult, wrap(async (req, res) => {
  const u = me(req)
  const { contentId } = z.object({ contentId: z.string().min(1) }).parse(req.body)
  const content = await prisma.mediaContent.findUnique({ where: { id: contentId } })
  if (!content || !isListable(content) || content.visibility !== 'PAID') throw notFound('Content not found')
  if (content.providerId === u.id) throw forbidden('You cannot buy your own content')
  const seller = await prisma.user.findUnique({ where: { id: content.providerId } })
  if (!seller || seller.accountStatus !== 'ACTIVE' || (await isBlockedEitherWay(u.id, seller.id))) throw notFound('Content not found')
  // Price comes from OUR database, never from the request.
  const credits = kobotoCredits(content.price)
  if (credits === null) throw badRequest('This item is not priced in credits yet', 'NOT_PRICED_IN_CREDITS')

  const result = await prisma.$transaction(async (db) => {
    await db.$queryRaw`SELECT id FROM "User" WHERE id = ${u.id} FOR UPDATE`
    const owned = await db.contentPurchase.findUnique({ where: { buyerId_contentId: { buyerId: u.id, contentId } } })
    if (owned?.status === 'COMPLETED') throw conflict('You already own this content', 'ALREADY_OWNED')

    const { platformFee, processingFee, netAmount } = splitAmount(content.price, env.PLATFORM_COMMISSION_BPS, 0)
    const tx = await db.transaction.create({
      data: {
        userId: u.id, payeeId: content.providerId, contentId, transactionType: 'CONTENT_PURCHASE', provider: 'credits',
        providerReference: `jp_${crypto.randomBytes(12).toString('hex')}`,
        amount: content.price, currency: 'NGN', status: 'SUCCESS', paidAt: new Date(), platformFee, processingFee, netAmount,
      },
    })
    const balance = await debitWallet(db, u.id, credits, { transactionId: tx.id, contentId })
    await db.contentPurchase.upsert({
      where: { buyerId_contentId: { buyerId: u.id, contentId } },
      update: { status: 'COMPLETED', transactionId: tx.id, amount: tx.amount },
      create: { buyerId: u.id, contentId, transactionId: tx.id, amount: tx.amount, status: 'COMPLETED' },
    })
    return { reference: tx.providerReference, balance }
  })
  await notifyPurchase(result.reference)
  res.status(201).json({ ok: true, credits, balance: result.balance, contentId, reference: result.reference })
}))

/** Read-only status lookup. The frontend "success" page uses this; it can never grant access by itself. */
purchasesRouter.get('/verify/:reference', wrap(async (req, res) => {
  const u = me(req)
  const tx = await prisma.transaction.findUnique({ where: { providerReference: String(req.params.reference) } })
  if (!tx || tx.userId !== u.id) throw notFound('Transaction not found')
  // Webhooks can lag (or be unreachable in local dev), so for a pending real-provider payment ask the provider directly.
  // The event comes from the provider's authenticated API and goes through the same idempotent path as a webhook.
  if (tx.status === 'PENDING' && paymentProvider.fetchPaymentEvent) {
    const event = await paymentProvider.fetchPaymentEvent(tx.providerReference).catch(() => null)
    if (event) await applyPaymentEvent(event)
  }
  const [fresh, purchase] = await Promise.all([
    prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } }),
    prisma.contentPurchase.findUnique({ where: { transactionId: tx.id } }),
  ])
  res.json({ reference: fresh.providerReference, type: fresh.transactionType, status: fresh.status, contentId: fresh.contentId, credits: fresh.transactionType === 'CREDIT_TOPUP' ? kobotoCredits(fresh.amount) : null, entitled: purchase?.status === 'COMPLETED' })
}))
