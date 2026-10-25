import { Router } from 'express'
import crypto from 'node:crypto'
import { z } from 'zod'
import { prisma } from '../db'
import { env } from '../env'
import { wrap } from '../lib/errors'
import { me, requireAuth, requireVerifiedAdult } from '../auth'
import { CREDIT_PACKAGES, MAX_TOPUP_CREDITS, MIN_TOPUP_CREDITS } from '../config/constants'
import { creditsToKobo } from '../services/credits'
import { paymentProvider } from '../payments/provider'
import { startCheckout } from '../payments/checkout'

export const creditsRouter = Router()
creditsRouter.use(requireAuth)

/** Balance, price and recent wallet activity. */
creditsRouter.get('/', wrap(async (req, res) => {
  const u = me(req)
  const [fresh, entries] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: u.id }, select: { creditBalance: true } }),
    prisma.creditLedger.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ])
  const contentIds = entries.map((e) => e.contentId).filter((x): x is string => !!x)
  const titles = new Map((await prisma.mediaContent.findMany({ where: { id: { in: contentIds } }, select: { id: true, title: true } })).map((c) => [c.id, c.title]))
  res.json({
    balance: fresh.creditBalance,
    creditPriceKobo: env.CREDIT_PRICE_KOBO,
    packages: CREDIT_PACKAGES,
    minTopup: MIN_TOPUP_CREDITS,
    maxTopup: MAX_TOPUP_CREDITS,
    entries: entries.map((e) => ({ id: e.id, type: e.type, delta: e.delta, balanceAfter: e.balanceAfter, title: e.contentId ? titles.get(e.contentId) ?? null : null, createdAt: e.createdAt })),
  })
}))

/** Starts a Paystack checkout to buy credits. Credits are added only when the verified payment confirmation arrives. */
creditsRouter.post('/topup', requireVerifiedAdult, wrap(async (req, res) => {
  const u = me(req)
  const { credits } = z.object({ credits: z.number().int().min(MIN_TOPUP_CREDITS).max(MAX_TOPUP_CREDITS) }).parse(req.body)
  const tx = await prisma.transaction.create({
    data: {
      userId: u.id, transactionType: 'CREDIT_TOPUP', provider: paymentProvider.name,
      providerReference: `jp_${crypto.randomBytes(12).toString('hex')}`,
      // The price comes from OUR configuration, never from the request.
      amount: creditsToKobo(credits), currency: 'NGN', status: 'PENDING',
    },
  })
  const checkoutUrl = await startCheckout(tx, u)
  res.status(201).json({ reference: tx.providerReference, credits, amount: tx.amount, currency: tx.currency, checkoutUrl })
}))
