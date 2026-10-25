import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db'
import { forbidden, wrap } from '../lib/errors'
import { me, requireAuth } from '../auth'

export const verificationRouter = Router()
verificationRouter.use(requireAuth)

verificationRouter.get('/', wrap(async (req, res) => {
  const u = me(req)
  const requests = await prisma.verificationRequest.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'desc' }, take: 10 })
  res.json({
    ageVerificationStatus: u.ageVerificationStatus,
    requests: requests.map((r) => ({ id: r.id, type: r.type, status: r.status, rejectionReason: r.rejectionReason, createdAt: r.createdAt })),
  })
}))

/**
 * Age check by self-declaration: ticking "I am 18 or older" marks the account as age-verified straight away.
 * The declaration is recorded as an approved AGE request (providerRef "self-declared") so there is an audit trail.
 */
verificationRouter.post('/age/confirm', wrap(async (req, res) => {
  const u = me(req)
  z.object({ confirmed: z.literal(true) }).parse(req.body)
  if (u.role === 'UNASSIGNED' || !u.onboardedAt) throw forbidden('Finish onboarding first')
  if (u.ageVerificationStatus !== 'VERIFIED') {
    await prisma.$transaction([
      prisma.verificationRequest.create({ data: { userId: u.id, type: 'AGE', status: 'APPROVED', providerRef: 'self-declared', reviewedAt: new Date() } }),
      prisma.user.update({ where: { id: u.id }, data: { ageVerificationStatus: 'VERIFIED' } }),
    ])
  }
  res.json({ status: 'VERIFIED' })
}))
