import crypto from 'node:crypto'
import type { Prisma, User } from '@prisma/client'
import { prisma } from '../db'
import { creditWallet } from './credits'
import { notify } from './notify'

const KEY = 'referrals'
export type ReferralSettings = {
  /** Master switch: when false, nobody earns rewards and the popup is hidden. */
  enabled: boolean
  /** Reward for the referrer, in credits (20 credits = ₦2,000 at ₦100 per credit). */
  rewardCredits: number
  /** How many rewards one client can earn in total. 0 = unlimited. */
  maxRewardsPerClient: number
}
export const DEFAULT_REFERRAL_SETTINGS: ReferralSettings = { enabled: true, rewardCredits: 20, maxRewardsPerClient: 1 }

export async function getReferralSettings(db: Pick<Prisma.TransactionClient, 'setting'> = prisma): Promise<ReferralSettings> {
  const row = await db.setting.findUnique({ where: { key: KEY } })
  return { ...DEFAULT_REFERRAL_SETTINGS, ...((row?.value as Partial<ReferralSettings> | null) ?? {}) }
}
export async function saveReferralSettings(next: ReferralSettings) {
  await prisma.setting.upsert({ where: { key: KEY }, update: { value: next }, create: { key: KEY, value: next } })
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I to avoid mix-ups
const newCode = () => Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('')
export const normaliseCode = (c: unknown) => (typeof c === 'string' ? c.trim().toUpperCase() : '')

/** The user's personal referral code, created on first use. */
export async function ensureReferralCode(user: Pick<User, 'id' | 'referralCode'>): Promise<string> {
  if (user.referralCode) return user.referralCode
  for (let i = 0; i < 5; i++) {
    try {
      const u = await prisma.user.update({ where: { id: user.id }, data: { referralCode: newCode() }, select: { referralCode: true } })
      return u.referralCode!
    } catch (e: any) {
      if (e?.code !== 'P2002') throw e // only retry on a code collision
    }
  }
  throw new Error('Could not create a referral code')
}

/**
 * Called once, when a brand-new CLIENT finishes sign-up with a referral code.
 * Never throws: a bad or ineligible code simply earns nothing and must not block sign-up.
 * Rules: programme enabled, referrer is an active client, nobody refers themselves,
 * a person can only be referred once, and each client has a lifetime cap on rewards.
 */
export async function applyReferral(referred: Pick<User, 'id' | 'username' | 'role'>, rawCode: unknown): Promise<{ credited: boolean }> {
  try {
    const code = normaliseCode(rawCode)
    if (!code || referred.role !== 'CLIENT') return { credited: false }
    const result = await prisma.$transaction(async (db) => {
      const settings = await getReferralSettings(db)
      if (!settings.enabled || settings.rewardCredits < 1) return null
      const referrer = await db.user.findUnique({ where: { referralCode: code } })
      if (!referrer || referrer.id === referred.id || referrer.role !== 'CLIENT' || referrer.accountStatus !== 'ACTIVE') return null
      // Serialise per referrer so two simultaneous sign-ups cannot both slip past the cap.
      await db.$queryRaw`SELECT id FROM "User" WHERE id = ${referrer.id} FOR UPDATE`
      if (settings.maxRewardsPerClient > 0 && (await db.referral.count({ where: { referrerId: referrer.id } })) >= settings.maxRewardsPerClient) return null
      await db.referral.create({ data: { referrerId: referrer.id, referredUserId: referred.id, rewardCredits: settings.rewardCredits } })
      await creditWallet(db, referrer.id, settings.rewardCredits, 'REFERRAL', {})
      return { referrerId: referrer.id, credits: settings.rewardCredits }
    })
    if (!result) return { credited: false }
    await notify(result.referrerId, 'REFERRAL_REWARD', 'Referral reward!', `A friend joined with your link. ${result.credits} credits were added to your wallet.`, '/app/credits').catch(() => {})
    return { credited: true }
  } catch (e) {
    console.error('Referral could not be applied:', e instanceof Error ? e.message : e)
    return { credited: false }
  }
}
