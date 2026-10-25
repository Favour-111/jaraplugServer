import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db'
import { BOOKING_DURATION_MINS, LAGOS_OFFSET } from '../config/constants'
import { badRequest, conflict, forbidden, notFound, wrap } from '../lib/errors'
import { me, requireAuth, requireRole, requireVerifiedAdult } from '../auth'
import { isBlockedEitherWay } from '../services/blocks'
import { computeSlots } from './public'
import { notify } from '../services/notify'
import { toUserSummary } from '../lib/serializers'
import type { Booking } from '@prisma/client'

export const bookingsRouter = Router()
bookingsRouter.use(requireAuth)

async function serialize(b: Booking, viewerId: string) {
  const otherId = b.clientId === viewerId ? b.providerId : b.clientId
  const other = await prisma.user.findUnique({ where: { id: otherId }, include: { providerProfile: true } })
  return {
    id: b.id, scheduledAt: b.scheduledAt, durationMins: b.durationMins,
    status: b.status, message: b.message, declineReason: b.declineReason, createdAt: b.createdAt, requestedAt: b.requestedAt,
    role: b.clientId === viewerId ? 'client' : 'provider',
    other: other ? await toUserSummary(other) : null,
  }
}

bookingsRouter.get('/', wrap(async (req, res) => {
  const u = me(req)
  const { status } = z.object({ status: z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'COMPLETED']).optional() }).parse(req.query)
  const rows = await prisma.booking.findMany({
    where: { OR: [{ clientId: u.id }, { providerId: u.id }], ...(status ? { status } : {}) },
    orderBy: { scheduledAt: 'asc' },
    take: 200,
  })
  res.json({ items: await Promise.all(rows.map((b) => serialize(b, u.id))) })
}))

const createSchema = z.object({
  providerUsername: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  message: z.string().trim().max(500).optional(),
})

bookingsRouter.post('/', requireRole('CLIENT'), requireVerifiedAdult, wrap(async (req, res) => {
  const u = me(req)
  const body = createSchema.parse(req.body)
  const provider = await prisma.user.findFirst({
    where: { username: { equals: body.providerUsername, mode: 'insensitive' }, role: 'PROVIDER', accountStatus: 'ACTIVE' },
    include: { providerProfile: true },
  })
  const profile = provider?.providerProfile
  if (!provider || !profile || profile.verificationStatus !== 'VERIFIED' || profile.visibility === 'HIDDEN') throw notFound('Provider not found')
  if (await isBlockedEitherWay(u.id, provider.id)) throw notFound('Provider not found')

  const slots = await computeSlots(provider.id, body.date)
  if (!slots.includes(body.time)) throw conflict('That time is not available', 'SLOT_UNAVAILABLE')
  const scheduledAt = new Date(`${body.date}T${body.time}:00${LAGOS_OFFSET}`)

  const pendingCount = await prisma.booking.count({ where: { clientId: u.id, status: 'PENDING' } })
  if (pendingCount >= 10) throw conflict('You have too many pending requests', 'TOO_MANY_PENDING')
  const dup = await prisma.booking.findFirst({ where: { clientId: u.id, providerId: provider.id, scheduledAt, status: { in: ['PENDING', 'ACCEPTED'] } } })
  if (dup) throw conflict('You already have a request for this time', 'DUPLICATE_REQUEST')

  const booking = await prisma.booking.create({
    data: { clientId: u.id, providerId: provider.id, category: 'appointment', scheduledAt, durationMins: BOOKING_DURATION_MINS, message: body.message },
  })
  await notify(provider.id, 'BOOKING_REQUEST', 'New booking request', `${u.displayName ?? 'A client'} requested an appointment`, '/provider/bookings')
  res.status(201).json(await serialize(booking, u.id))
}))

const transitionSchema = z.object({
  status: z.enum(['ACCEPTED', 'DECLINED', 'CANCELLED', 'COMPLETED']),
  reason: z.string().trim().max(300).optional(),
})

bookingsRouter.patch('/:id/status', wrap(async (req, res) => {
  const u = me(req)
  const { status, reason } = transitionSchema.parse(req.body)
  const updated = await prisma.$transaction(async (db) => {
    const b = await db.booking.findUnique({ where: { id: String(req.params.id) } })
    // 404 (not 403) so booking ids can't be probed.
    if (!b || (b.clientId !== u.id && b.providerId !== u.id)) throw notFound('Booking not found')
    const isProvider = b.providerId === u.id

    const allowed: Record<string, { by: 'provider' | 'client' | 'either'; from: string[] }> = {
      ACCEPTED: { by: 'provider', from: ['PENDING'] },
      DECLINED: { by: 'provider', from: ['PENDING'] },
      COMPLETED: { by: 'provider', from: ['ACCEPTED'] },
      CANCELLED: { by: 'either', from: ['PENDING', 'ACCEPTED'] },
    }
    const rule = allowed[status]
    if (rule.by === 'provider' && !isProvider) throw forbidden('Only the provider can do that')
    if (!rule.from.includes(b.status)) throw conflict(`A ${b.status.toLowerCase()} booking cannot be ${status.toLowerCase()}`, 'INVALID_TRANSITION')
    if (status === 'COMPLETED' && b.scheduledAt.getTime() > Date.now()) throw conflict('A booking can only be completed after its scheduled time', 'TOO_EARLY')

    if (status === 'ACCEPTED') {
      // Serialise acceptances per provider so two overlapping requests can't both be confirmed.
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'booking:' + b.providerId}))`
      const end = new Date(b.scheduledAt.getTime() + b.durationMins * 60_000)
      const clash = await db.booking.findFirst({
        where: {
          providerId: b.providerId, status: 'ACCEPTED', id: { not: b.id },
          scheduledAt: { lt: end, gt: new Date(b.scheduledAt.getTime() - 24 * 3600_000) },
        },
      })
      if (clash && clash.scheduledAt.getTime() + clash.durationMins * 60_000 > b.scheduledAt.getTime())
        throw conflict('This overlaps with a booking you already accepted', 'BOOKING_CONFLICT')
    }
    return db.booking.update({
      where: { id: b.id },
      data: { status, declineReason: status === 'DECLINED' || status === 'CANCELLED' ? reason ?? null : undefined },
    })
  })
  const otherId = updated.clientId === u.id ? updated.providerId : updated.clientId
  await notify(otherId, 'BOOKING_UPDATE', `Booking ${updated.status.toLowerCase()}`, 'Appointment', updated.clientId === otherId ? '/app/bookings' : '/provider/bookings')
  res.json(await serialize(updated, u.id))
}))
