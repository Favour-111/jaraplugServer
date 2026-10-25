import type { Request, RequestHandler } from 'express'
import jwt from 'jsonwebtoken'
import type { User } from '@prisma/client'
import { prisma } from '../db'
import { env } from '../env'
import { forbidden, unauthorized, wrap } from '../lib/errors'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User
    }
  }
}

/** DEMO_AUTO_VERIFY (non-production only): treats every onboarded user as verified so the whole app can be tested end to end. */
async function applyDemoAutoVerify(user: User): Promise<User> {
  if (!env.DEMO_AUTO_VERIFY || !user.onboardedAt || user.ageVerificationStatus === 'VERIFIED') return user
  await prisma.providerProfile.updateMany({ where: { userId: user.id, verificationStatus: { not: 'VERIFIED' } }, data: { verificationStatus: 'VERIFIED' } })
  return prisma.user.update({ where: { id: user.id }, data: { ageVerificationStatus: 'VERIFIED' } })
}

export const signDevToken = (authProviderId: string) =>
  jwt.sign({ sub: authProviderId, dev: true }, env.DEV_AUTH_SECRET, { expiresIn: '30d' })

/** Verify a bearer token with the configured auth provider and return the provider's subject id. */
async function verifyBearer(token: string): Promise<{ sub: string; email?: string } | null> {
  try {
    if (env.AUTH_MODE === 'dev') {
      if (env.NODE_ENV === 'production') return null
      const p = jwt.verify(token, env.DEV_AUTH_SECRET) as jwt.JwtPayload
      return typeof p.sub === 'string' ? { sub: p.sub } : null
    }
    const { verifyToken } = await import('@clerk/backend')
    // The public verifyToken returns the claims directly and throws on an invalid/expired token.
    const claims = (await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY! })) as { sub?: string } | undefined
    return claims?.sub ? { sub: claims.sub } : null
  } catch (e) {
    if (env.NODE_ENV !== 'production') console.warn('Token verification threw:', e instanceof Error ? e.message : e)
    return null
  }
}

async function loadOrCreateUser(sub: string): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { authProviderId: sub } })
  if (existing) return existing
  // First request from a brand-new Clerk identity: create the local record. The role starts as
  // UNASSIGNED and is only ever set through the server-side onboarding endpoint.
  let email: string | undefined
  let displayName: string | undefined
  if (env.AUTH_MODE === 'clerk') {
    try {
      const { createClerkClient } = await import('@clerk/backend')
      const cu = await createClerkClient({ secretKey: env.CLERK_SECRET_KEY! }).users.getUser(sub)
      email = cu.primaryEmailAddress?.emailAddress
      displayName = [cu.firstName, cu.lastName].filter(Boolean).join(' ') || undefined
    } catch (e) {
      console.warn('Could not fetch Clerk profile for new user', e)
    }
  }
  return prisma.user.upsert({
    where: { authProviderId: sub },
    update: {},
    create: { authProviderId: sub, email, displayName },
  })
}

export async function resolveUserFromToken(token: string | undefined | null): Promise<User | null> {
  if (!token) return null
  const v = await verifyBearer(token)
  if (!v) return null
  const user = await applyDemoAutoVerify(await loadOrCreateUser(v.sub))
  if (user.accountStatus !== 'ACTIVE') return null
  return user
}

const bearer = (req: Request) => {
  const h = req.headers.authorization
  return h?.startsWith('Bearer ') ? h.slice(7) : null
}

const touchLastSeen = (u: User) => {
  if (!u.lastSeenAt || Date.now() - u.lastSeenAt.getTime() > 60_000) {
    prisma.user.update({ where: { id: u.id }, data: { lastSeenAt: new Date() } }).catch(() => {})
  }
}

/** Requires a valid session. Suspended or deleted accounts are rejected on the backend. */
export const requireAuth: RequestHandler = wrap(async (req, _res, next) => {
  const token = bearer(req)
  if (!token) throw unauthorized()
  const v = await verifyBearer(token)
  if (!v) throw unauthorized('Invalid or expired session')
  const user = await applyDemoAutoVerify(await loadOrCreateUser(v.sub))
  if (user.accountStatus === 'SUSPENDED') throw forbidden('This account has been suspended', 'ACCOUNT_SUSPENDED')
  if (user.accountStatus === 'DELETED') throw unauthorized('Account no longer exists')
  req.user = user
  touchLastSeen(user)
  next()
})

/** Attaches the user if a valid token is present, otherwise continues anonymously. */
export const optionalAuth: RequestHandler = wrap(async (req, _res, next) => {
  const token = bearer(req)
  if (token) {
    const user = await resolveUserFromToken(token)
    if (user) req.user = user
  }
  next()
})

export const requireRole = (...roles: User['role'][]): RequestHandler => (req, _res, next) => {
  if (!req.user) return next(unauthorized())
  if (!roles.includes(req.user.role)) return next(forbidden('Your account type cannot access this resource', 'WRONG_ROLE'))
  next()
}

/** Restricted areas (messaging, bookings, purchases, members-only media) need a verified adult. */
export const requireVerifiedAdult: RequestHandler = (req, _res, next) => {
  const u = req.user
  if (!u) return next(unauthorized())
  if (u.role === 'ADMIN' || u.ageVerificationStatus === 'VERIFIED') return next()
  next(forbidden('Age verification is required before you can do that', 'AGE_VERIFICATION_REQUIRED'))
}

export const me = (req: Request): User => {
  if (!req.user) throw unauthorized()
  return req.user
}
