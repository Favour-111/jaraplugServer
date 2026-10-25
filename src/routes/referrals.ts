import { Router } from 'express'
import { prisma } from '../db'
import { wrap } from '../lib/errors'
import { me, requireAuth, requireRole } from '../auth'
import { creditsToKobo } from '../services/credits'
import { ensureReferralCode, getReferralSettings } from '../services/referrals'

export const referralsRouter = Router()
referralsRouter.use(requireAuth, requireRole('CLIENT'))

/** What the "invite a friend" popup and card need. When the programme is paused, `enabled` is false and no code is exposed. */
referralsRouter.get('/me', wrap(async (req, res) => {
  const u = me(req)
  const settings = await getReferralSettings()
  const [made, earned] = await Promise.all([
    prisma.referral.count({ where: { referrerId: u.id } }),
    prisma.referral.aggregate({ where: { referrerId: u.id }, _sum: { rewardCredits: true } }),
  ])
  const max = settings.maxRewardsPerClient
  res.json({
    enabled: settings.enabled,
    code: settings.enabled ? await ensureReferralCode(u) : null,
    rewardCredits: settings.rewardCredits,
    rewardKobo: creditsToKobo(settings.rewardCredits),
    maxRewards: max,
    referrals: made,
    creditsEarned: earned._sum.rewardCredits ?? 0,
    canStillEarn: settings.enabled && (max === 0 || made < max),
  })
}))
