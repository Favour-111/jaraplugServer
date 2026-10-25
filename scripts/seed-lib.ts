import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { prisma } from '../src/db'
import { env } from '../src/env'
import { storage, localRoot } from '../src/storage'
import { demoPortrait, demoVideoFile } from './demo-assets'
import { probeVideo } from '../src/lib/video'

/** Seed data is for local development ONLY and is flagged isDemo. It contains no transactions. */
export function assertNotProduction() {
  if (env.NODE_ENV === 'production') throw new Error('Refusing to seed or reset: NODE_ENV=production')
}

export async function wipeDatabase() {
  assertNotProduction()
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`
  if (tables.length) await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`)
}

export async function wipeStorage() {
  assertNotProduction()
  if (env.STORAGE_DRIVER === 'local') await fs.promises.rm(localRoot(), { recursive: true, force: true })
}

const providers = [
  { username: 'amara', name: 'Amara', age: 24, city: 'Lagos', area: 'Lekki', hue: 345, avail: 'AVAILABLE_NOW', bio: 'Sweet, fun and adventurous. Discreet and professional. Let’s make it memorable. (Demo profile — fictional.)' },
  { username: 'tiana', name: 'Tiana', age: 27, city: 'Lagos', area: 'Victoria Island', hue: 20, avail: 'AVAILABLE_NOW', bio: 'Elegant company for dinners, events and weekend trips. (Demo profile — fictional.)' },
  { username: 'zee', name: 'Zee', age: 25, city: 'Lagos', area: 'Ajah', hue: 280, avail: 'BY_APPOINTMENT', bio: 'Model and creator based in Ajah. Bookings by appointment. (Demo profile — fictional.)' },
  { username: 'nia', name: 'Nia', age: 26, city: 'Lagos', area: 'Ikeja', hue: 330, avail: 'AVAILABLE_NOW', bio: 'Warm, witty and always on time. (Demo profile — fictional.)' },
  { username: 'queenb', name: 'Queen B', age: 28, city: 'Abuja', area: 'Maitama', hue: 8, avail: 'BY_APPOINTMENT', bio: 'Abuja-based. Events, galas and good conversation. (Demo profile — fictional.)' },
]

async function putJpeg(key: string, buf: Buffer) { await storage.putBuffer(key, buf, 'image/jpeg') }
const blurred = (buf: Buffer) => sharp(buf).resize({ width: 24 }).blur(1).resize({ width: 480, kernel: 'cubic' }).jpeg({ quality: 70 }).toBuffer()
const small = (buf: Buffer) => sharp(buf).resize({ width: 480 }).jpeg({ quality: 70 }).toBuffer()

export async function seedDemoData() {
  assertNotProduction()
  const now = Date.now()
  const mkUser = (username: string, displayName: string, role: 'CLIENT' | 'PROVIDER' | 'ADMIN', extra: Record<string, unknown> = {}) =>
    prisma.user.create({
      data: {
        authProviderId: `demo_${username}`, username, displayName, role, isDemo: true, onboardedAt: new Date(), termsAcceptedAt: new Date(), privacyAcceptedAt: new Date(),
        ageVerificationStatus: 'VERIFIED', city: 'Lagos', email: `${username}@demo.jaraplug.invalid`, ...extra,
      },
    })

  const admin = await mkUser('demo_admin', 'Demo Admin', 'ADMIN')
  const ife = await mkUser('demo_ife', 'Ife (demo client)', 'CLIENT')
  const kola = await mkUser('demo_kola', 'Kola (demo, unverified)', 'CLIENT', { ageVerificationStatus: 'NOT_STARTED' })

  const created: Record<string, { id: string }> = {}
  const videoFile = await demoVideoFile()
  let n = 0
  for (const p of providers) {
    const u = await mkUser(p.username, p.name, 'PROVIDER', { city: p.city, createdAt: new Date(now - (n + 1) * 5 * 86400_000) })
    created[p.username] = u
    const avatarKey = `profiles/${u.id}/demo.jpg`
    await putJpeg(avatarKey, await demoPortrait(p.hue, n))
    await prisma.providerProfile.create({
      data: {
        userId: u.id, biography: p.bio, city: p.city, area: p.area, displayAge: p.age, profileImage: avatarKey,
        verificationStatus: 'VERIFIED', visibility: 'PUBLIC', availabilityStatus: p.avail as any, consentConfirmedAt: new Date(),
      },
    })
    await prisma.availability.createMany({ data: [1, 2, 3, 4, 5, 6].map((d) => ({ providerId: u.id, dayOfWeek: d, startMinute: 10 * 60, endMinute: 20 * 60 })) })

    // Public (free-for-everyone) photos
    for (let i = 0; i < 3; i++) {
      const id = `demo-${p.username}-pub-${i}`
      const img = await demoPortrait((p.hue + i * 14) % 360, n * 7 + i + 1)
      await putJpeg(`content/${u.id}/${id}.jpg`, img)
      await putJpeg(`thumbs/${u.id}/${id}.jpg`, await small(img))
      await prisma.mediaContent.create({ data: { id, providerId: u.id, title: `Gallery photo ${i + 1}`, mediaType: 'IMAGE', mimeType: 'image/jpeg', sizeBytes: img.length, storageKey: `content/${u.id}/${id}.jpg`, thumbnailKey: `thumbs/${u.id}/${id}.jpg`, visibility: 'PUBLIC', price: 0, status: 'PUBLISHED', moderationStatus: 'APPROVED', consentConfirmed: true } })
    }
    // Paid photos (thumbnail is blurred server-side)
    for (let i = 0; i < 2; i++) {
      const id = `demo-${p.username}-paid-${i}`
      const img = await demoPortrait((p.hue + 40 + i * 20) % 360, n * 11 + i + 5)
      await putJpeg(`content/${u.id}/${id}.jpg`, img)
      await putJpeg(`thumbs/${u.id}/${id}.jpg`, await blurred(img))
      await prisma.mediaContent.create({ data: { id, providerId: u.id, title: `Exclusive Photo Set ${i + 1}`, description: 'Demo exclusive photo (placeholder art).', mediaType: 'IMAGE', mimeType: 'image/jpeg', sizeBytes: img.length, storageKey: `content/${u.id}/${id}.jpg`, thumbnailKey: `thumbs/${u.id}/${id}.jpg`, visibility: 'PAID', price: 300_000 + i * 200_000, status: 'PUBLISHED', moderationStatus: 'APPROVED', consentConfirmed: true } })
    }
    // Videos
    if (videoFile && (p.username === 'amara' || p.username === 'tiana')) {
      const probe = await probeVideo(videoFile)
      const specs = [
        { id: 'pub-vid', title: 'Hello from Lagos', vis: 'PUBLIC', price: 0 },
        { id: 'paid-vid-1', title: 'Private Video 01', vis: 'PAID', price: 500_000 },
        { id: 'paid-vid-2', title: 'Private Video 02', vis: 'PAID', price: 1_000_000 },
      ] as const
      for (const s of specs) {
        const id = `demo-${p.username}-${s.id}`
        const key = `content/${u.id}/${id}.mp4`
        await storage.putFile(key, videoFile, 'video/mp4')
        const thumb = probe.poster ? (s.vis === 'PAID' ? await blurred(probe.poster) : await small(probe.poster)) : await blurred(await demoPortrait(p.hue, 3))
        await putJpeg(`thumbs/${u.id}/${id}.jpg`, thumb)
        await prisma.mediaContent.create({ data: { id, providerId: u.id, title: s.title, description: 'Demo clip (generated test pattern).', mediaType: 'VIDEO', mimeType: 'video/mp4', sizeBytes: fs.statSync(videoFile).size, storageKey: key, thumbnailKey: `thumbs/${u.id}/${id}.jpg`, visibility: s.vis, price: s.price, status: 'PUBLISHED', moderationStatus: 'APPROVED', consentConfirmed: true, durationSeconds: probe.durationSeconds } })
      }
    }
    n++
  }

  // A free "members" photo and one item still waiting for moderation (admin queue demo)
  const amara = created.amara
  const memberImg = await demoPortrait(350, 99)
  await putJpeg(`content/${amara.id}/demo-amara-members.jpg`, memberImg)
  await putJpeg(`thumbs/${amara.id}/demo-amara-members.jpg`, await blurred(memberImg))
  await prisma.mediaContent.create({ data: { id: 'demo-amara-members', providerId: amara.id, title: 'Members-only preview', mediaType: 'IMAGE', mimeType: 'image/jpeg', sizeBytes: memberImg.length, storageKey: `content/${amara.id}/demo-amara-members.jpg`, thumbnailKey: `thumbs/${amara.id}/demo-amara-members.jpg`, visibility: 'FREE_MEMBERS', status: 'PUBLISHED', moderationStatus: 'APPROVED', consentConfirmed: true } })
  const pendImg = await demoPortrait(10, 77)
  await putJpeg(`content/${amara.id}/demo-amara-pending.jpg`, pendImg)
  await putJpeg(`thumbs/${amara.id}/demo-amara-pending.jpg`, await blurred(pendImg))
  await prisma.mediaContent.create({ data: { id: 'demo-amara-pending', providerId: amara.id, title: 'New set (awaiting review)', mediaType: 'IMAGE', mimeType: 'image/jpeg', sizeBytes: pendImg.length, storageKey: `content/${amara.id}/demo-amara-pending.jpg`, thumbnailKey: `thumbs/${amara.id}/demo-amara-pending.jpg`, visibility: 'PAID', price: 400_000, status: 'PUBLISHED', moderationStatus: 'PENDING', consentConfirmed: true } })

  // A provider waiting for verification (admin queue demo) — not listed publicly yet
  const mimi = await mkUser('mimi', 'Mimi', 'PROVIDER', { city: 'Ibadan', ageVerificationStatus: 'PENDING' })
  const mimiKey = `profiles/${mimi.id}/demo.jpg`
  await putJpeg(mimiKey, await demoPortrait(300, 4))
  await prisma.providerProfile.create({ data: { userId: mimi.id, biography: 'Brand new on JaraPlug — waiting for review. (Demo profile — fictional.)', city: 'Ibadan', area: 'Bodija', displayAge: 23, profileImage: mimiKey, verificationStatus: 'PENDING', visibility: 'PUBLIC', consentConfirmedAt: new Date(), submittedAt: new Date() } })
  await prisma.verificationRequest.create({ data: { userId: mimi.id, type: 'PROVIDER_IDENTITY', providerRef: 'sandbox-kyc-passed' } })
  await prisma.verificationRequest.create({ data: { userId: kola.id, type: 'AGE', status: 'PENDING' } })
  await prisma.user.update({ where: { id: kola.id }, data: { ageVerificationStatus: 'PENDING' } })

  // Conversations
  const convo = async (a: string, b: string, msgs: Array<[string, string, number, boolean?]>) => {
    const c = await prisma.conversation.create({ data: { pairKey: [a, b].sort().join(':'), participants: { create: [{ userId: a }, { userId: b }] } } })
    let last = new Date()
    for (const [from, body, minsAgo, unread] of msgs) {
      last = new Date(now - minsAgo * 60_000)
      await prisma.message.create({ data: { conversationId: c.id, senderId: from, body, createdAt: last, deliveredAt: last, readAt: unread ? null : last } })
    }
    await prisma.conversation.update({ where: { id: c.id }, data: { lastMessageAt: last } })
  }
  await convo(ife.id, created.amara.id, [
    [ife.id, 'Hey, how are you? 😊', 190], [created.amara.id, 'Hey! I’m good, thanks. How can I help?', 185],
    [ife.id, 'Are you available this weekend?', 120], [created.amara.id, 'Yes, I am. What date are you thinking?', 100],
    [ife.id, 'Saturday works. What’s your rate?', 90], [created.amara.id, 'Same as my profile. Let me know when you’re ready 💋', 20, true],
  ])
  await convo(ife.id, created.tiana.id, [[ife.id, 'Are you available tonight?', 400], [created.tiana.id, 'Let me check my schedule and get back to you.', 380, true]])
  await convo(ife.id, created.nia.id, [[created.nia.id, 'Thanks babe ❤️', 1500]])

  // Bookings
  const at = (daysAhead: number, hour: number) => new Date(`${new Date(now + daysAhead * 86400_000 + 3600_000).toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00:00+01:00`)
  await prisma.booking.createMany({
    data: [
      { clientId: ife.id, providerId: created.amara.id, category: 'appointment', scheduledAt: at(2, 14), status: 'PENDING', message: 'Dinner somewhere in Lekki?' },
      { clientId: ife.id, providerId: created.tiana.id, category: 'appointment', scheduledAt: at(4, 16), status: 'ACCEPTED' },
      { clientId: ife.id, providerId: created.nia.id, category: 'appointment', scheduledAt: at(-6, 18), status: 'COMPLETED' },
    ],
  })
  await prisma.favorite.createMany({ data: [{ userId: ife.id, providerId: created.amara.id }, { userId: ife.id, providerId: created.tiana.id }] })
  await prisma.notification.createMany({ data: [
    { userId: created.amara.id, type: 'BOOKING_REQUEST', title: 'New booking request', body: 'Ife (demo client) requested an appointment', link: '/provider/bookings' },
    { userId: ife.id, type: 'INFO', title: 'Welcome to JaraPlug (demo)', body: 'This is seeded development data.' },
  ] })
  await prisma.report.create({ data: { reporterId: ife.id, reportedUserId: created.zee.id, category: 'SPAM_OR_SCAM', description: 'Demo report: suspicious message (seed data).' } })

  return { admin, ife, kola }
}
