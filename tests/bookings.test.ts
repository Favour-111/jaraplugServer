import { beforeEach, describe, expect, it } from 'vitest'
import { api, auth, lagosDate, makeClient, makeProvider, openAvailability, prisma, resetAll } from './helpers'

beforeEach(resetAll)

async function setup() {
  const provider = await makeProvider({ username: 'amara' })
  await openAvailability(provider.id)
  const client = await makeClient()
  return { provider, client, date: lagosDate(3) }
}
const request = (client: any, over: Record<string, unknown> = {}, date = lagosDate(3)) =>
  api().post('/api/bookings').set(auth(client)).send({ providerUsername: 'amara', date, time: '14:00', message: 'Dinner?', ...over })

describe('booking requests', () => {
  it('exposes bookable slots derived from provider availability', async () => {
    const { date } = await setup()
    const r = await api().get(`/api/providers/amara/slots?date=${date}`).expect(200)
    expect(r.body.slots).toContain('14:00')
    expect(r.body.slots).not.toContain('07:00')
    expect(r.body.slots).not.toContain('22:00')
    const past = await api().get(`/api/providers/amara/slots?date=${lagosDate(-2)}`).expect(200)
    expect(past.body.slots).toEqual([])
  })

  it('creates a pending request for a free slot', async () => {
    const { client, provider } = await setup()
    const r = await request(client).expect(201)
    expect(r.body).toMatchObject({ status: 'PENDING', role: 'client' })
    expect((await api().get('/api/bookings').set(auth(provider))).body.items).toHaveLength(1)
    expect((await api().get('/api/notifications').set(auth(provider))).body.items[0].type).toBe('BOOKING_REQUEST')
  })

  it('refuses unknown providers, unavailable times, and unverified clients', async () => {
    const { client } = await setup()
    await request(client, { providerUsername: 'nobody' }).expect(404)
    expect((await request(client, { time: '03:00' }).expect(409)).body.code).toBe('SLOT_UNAVAILABLE')
    await request(client, {}, lagosDate(-1)).expect(409)
    await request(client, {}, lagosDate(90)).expect(409)
    const unverified = await makeClient({ ageVerificationStatus: 'NOT_STARTED' })
    expect((await request(unverified).expect(403)).body.code).toBe('AGE_VERIFICATION_REQUIRED')
  })

  it('refuses duplicate requests and caps pending requests', async () => {
    const { client } = await setup()
    await request(client).expect(201)
    expect((await request(client).expect(409)).body.code).toBe('DUPLICATE_REQUEST')
  })
})

describe('booking status changes', () => {
  async function pending() {
    const ctx = await setup()
    const b = (await request(ctx.client).expect(201)).body
    return { ...ctx, id: b.id as string }
  }
  const patch = (u: any, id: string, status: string, reason?: string) => api().patch(`/api/bookings/${id}/status`).set(auth(u)).send({ status, reason })

  it('lets the provider accept, and prevents clients from accepting their own requests', async () => {
    const { client, provider, id } = await pending()
    await patch(client, id, 'ACCEPTED').expect(403)
    await patch(provider, id, 'ACCEPTED').expect(200)
    expect((await prisma.booking.findUniqueOrThrow({ where: { id } })).status).toBe('ACCEPTED')
    expect((await api().get('/api/notifications').set(auth(client))).body.items.some((n: any) => n.type === 'BOOKING_UPDATE')).toBe(true)
  })

  it('prevents conflicting confirmed appointments', async () => {
    const { client, provider, id, date } = await pending()
    const client2 = await makeClient()
    const id2 = (await request(client2, { time: '14:00' }, date).expect(201)).body.id
    await patch(provider, id, 'ACCEPTED').expect(200)
    const r = await patch(provider, id2, 'ACCEPTED').expect(409)
    expect(r.body.code).toBe('BOOKING_CONFLICT')
    // slot disappears from availability once confirmed
    expect((await api().get(`/api/providers/amara/slots?date=${date}`)).body.slots).not.toContain('14:00')
    void client
  })

  it('serialises concurrent acceptances so only one overlapping booking is confirmed', async () => {
    const { provider, id, date } = await pending()
    const others = await Promise.all([makeClient(), makeClient(), makeClient()])
    const ids = [id, ...(await Promise.all(others.map(async (c) => (await request(c, {}, date)).body.id)))]
    const results = await Promise.all(ids.map((i) => patch(provider, i, 'ACCEPTED')))
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    expect(await prisma.booking.count({ where: { status: 'ACCEPTED' } })).toBe(1)
  })

  it('supports decline with a reason, and cancellation by the client', async () => {
    const { client, provider, id, date } = await pending()
    await patch(provider, id, 'DECLINED', 'Not available').expect(200)
    expect((await prisma.booking.findUniqueOrThrow({ where: { id } })).declineReason).toBe('Not available')
    await patch(client, id, 'CANCELLED').expect(409) // already declined: invalid transition
    const id2 = (await request(client, { time: '16:00' }, date).expect(201)).body.id
    await patch(client, id2, 'CANCELLED').expect(200)
  })

  it('rejects invalid transitions and early completion', async () => {
    const { provider, id } = await pending()
    expect((await patch(provider, id, 'COMPLETED').expect(409)).body.code).toBe('INVALID_TRANSITION') // pending → completed
    await patch(provider, id, 'ACCEPTED').expect(200)
    expect((await patch(provider, id, 'COMPLETED').expect(409)).body.code).toBe('TOO_EARLY')
    await prisma.booking.update({ where: { id }, data: { scheduledAt: new Date(Date.now() - 3600_000) } })
    await patch(provider, id, 'COMPLETED').expect(200)
    await patch(provider, id, 'CANCELLED').expect(409)
  })

  it('hides bookings from non-participants', async () => {
    const { id } = await pending()
    const outsider = await makeClient()
    await patch(outsider, id, 'CANCELLED').expect(404)
    expect((await api().get('/api/bookings').set(auth(outsider))).body.items).toHaveLength(0)
  })

  it('lets providers manage weekly availability', async () => {
    const p = await makeProvider()
    await api().put('/api/provider/availability').set(auth(p)).send({ windows: [{ dayOfWeek: 1, startMinute: 600, endMinute: 1080 }] }).expect(200)
    expect((await api().get('/api/provider/availability').set(auth(p))).body.windows).toHaveLength(1)
    await api().put('/api/provider/availability').set(auth(p)).send({ windows: [{ dayOfWeek: 1, startMinute: 600, endMinute: 630 }] }).expect(400)
  })
})
