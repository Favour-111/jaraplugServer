import type { Prisma } from '@prisma/client'
import { env } from '../env'
import { HttpError } from '../lib/errors'

type Db = Prisma.TransactionClient
type Ref = { transactionId?: string; contentId?: string }

/** Whole credits that an amount in kobo is worth, or null when it is not an exact multiple of the credit price. */
export const kobotoCredits = (kobo: number) => (kobo > 0 && kobo % env.CREDIT_PRICE_KOBO === 0 ? kobo / env.CREDIT_PRICE_KOBO : null)
export const creditsToKobo = (credits: number) => credits * env.CREDIT_PRICE_KOBO

/** Adds credits to a wallet and records it. Must run inside a DB transaction. */
export async function creditWallet(db: Db, userId: string, credits: number, type: 'TOPUP' | 'REFUND' | 'REFERRAL', ref: Ref) {
  const u = await db.user.update({ where: { id: userId }, data: { creditBalance: { increment: credits } }, select: { creditBalance: true } })
  await db.creditLedger.create({ data: { userId, type, delta: credits, balanceAfter: u.creditBalance, ...ref } })
  return u.creditBalance
}

/** Removes credits atomically; the balance can never go below zero. Must run inside a DB transaction. */
export async function debitWallet(db: Db, userId: string, credits: number, ref: Ref) {
  const r = await db.user.updateMany({ where: { id: userId, creditBalance: { gte: credits } }, data: { creditBalance: { decrement: credits } } })
  if (r.count !== 1) throw new HttpError(402, 'You do not have enough credits. Buy more credits to unlock this.', 'INSUFFICIENT_CREDITS')
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { creditBalance: true } })
  await db.creditLedger.create({ data: { userId, type: 'PURCHASE', delta: -credits, balanceAfter: u.creditBalance, ...ref } })
  return u.creditBalance
}
