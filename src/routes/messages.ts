import { Router } from 'express'
import { z } from 'zod'
import crypto from 'node:crypto'
import { prisma } from '../db'
import { badRequest, forbidden, notFound, wrap } from '../lib/errors'
import { me, requireAuth, requireVerifiedAdult } from '../auth'
import { assertMember, getOrCreateConversation, markConversationRead, sendMessage, serializeMessage } from '../services/messaging'
import { toUserSummary } from '../lib/serializers'
import { imageUpload, processImage, rm, validateUpload, validateVoiceNote, voiceUpload, VOICE_NOTE_MAX_SECONDS } from '../lib/upload'
import { storage } from '../storage'
import { blockedIdsFor } from '../services/blocks'

export const messagesRouter = Router()
messagesRouter.use(requireAuth)

messagesRouter.get('/', wrap(async (req, res) => {
  const u = me(req)
  const blocked = new Set(await blockedIdsFor(u.id))
  const convos = await prisma.conversation.findMany({
    where: { participants: { some: { userId: u.id } } },
    orderBy: { lastMessageAt: 'desc' },
    take: 100,
    include: {
      participants: { include: { user: { include: { providerProfile: true } } } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  })
  const unread = await prisma.message.groupBy({
    by: ['conversationId'],
    where: { readAt: null, senderId: { not: u.id }, conversation: { participants: { some: { userId: u.id } } } },
    _count: true,
  })
  const unreadMap = new Map(unread.map((x) => [x.conversationId, x._count]))
  const items = await Promise.all(
    convos
      // A conversation whose other participant no longer exists (deleted account) is skipped rather than crashing the list.
      .filter((c) => c.participants.length === 2 && c.participants.some((p) => p.userId === u.id))
      .map(async (c) => {
        const other = c.participants.find((p) => p.userId !== u.id)!.user
        const last = c.messages[0]
        return {
          id: c.id,
          other: await toUserSummary(other),
          blocked: blocked.has(other.id),
          lastMessage: last ? { body: last.messageType === 'IMAGE' ? '📷 Photo' : last.messageType === 'AUDIO' ? '🎤 Voice message' : last.body, createdAt: last.createdAt, fromMe: last.senderId === u.id } : null,
          unread: unreadMap.get(c.id) ?? 0,
          lastMessageAt: c.lastMessageAt,
        }
      }),
  )
  res.json({ items })
}))

/** Start (or open) the single conversation with another user. */
messagesRouter.post('/', requireVerifiedAdult, wrap(async (req, res) => {
  const u = me(req)
  const { username } = z.object({ username: z.string().min(1) }).parse(req.body)
  const other = await prisma.user.findFirst({ where: { username: { equals: username, mode: 'insensitive' }, accountStatus: 'ACTIVE' }, include: { providerProfile: true } })
  if (!other || other.id === u.id) throw notFound('User not found')
  // Clients may only start conversations with listed providers; providers reply to existing ones or message clients who contacted them.
  if (u.role === 'CLIENT' && !(other.role === 'PROVIDER' && other.providerProfile?.verificationStatus === 'VERIFIED' && other.providerProfile.visibility !== 'HIDDEN'))
    throw notFound('User not found')
  if (u.role === 'PROVIDER') {
    const existing = await prisma.conversation.findUnique({ where: { pairKey: [u.id, other.id].sort().join(':') } })
    if (!existing) throw forbidden('Providers can only reply to clients who contact them first', 'PROVIDER_CANNOT_INITIATE')
  }
  const c = await getOrCreateConversation(u.id, other.id)
  res.json({ id: c.id })
}))

messagesRouter.get('/:id/messages', wrap(async (req, res) => {
  const u = me(req)
  const id = String(req.params.id)
  const otherId = await assertMember(u.id, id)
  const { cursor, limit } = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query)
  const rows = await prisma.message.findMany({
    where: { conversationId: id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  })
  const page = rows.slice(0, limit)
  const other = await prisma.user.findUniqueOrThrow({ where: { id: otherId }, include: { providerProfile: true } })
  res.json({
    other: await toUserSummary(other),
    messages: (await Promise.all(page.map(serializeMessage))).reverse(),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
  })
}))

messagesRouter.post('/:id/messages', wrap(async (req, res) => {
  const u = me(req)
  const { body } = z.object({ body: z.string() }).parse(req.body)
  res.status(201).json(await sendMessage({ senderId: u.id, conversationId: String(req.params.id), body }))
}))

messagesRouter.post('/:id/attachments', imageUpload.single('file'), wrap(async (req, res) => {
  const u = me(req)
  const id = String(req.params.id)
  try {
    await assertMember(u.id, id)
    await validateUpload(req.file, ['IMAGE'])
    if (req.file!.size > 5 * 1024 * 1024) throw badRequest('Chat images must be under 5MB', 'FILE_TOO_LARGE')
    const { main } = await processImage(req.file!.path, { maxWidth: 1280 })
    const key = `messages/${id}/${crypto.randomUUID()}.jpg`
    await storage.putBuffer(key, main, 'image/jpeg')
    res.status(201).json(await sendMessage({ senderId: u.id, conversationId: id, attachmentKey: key, body: String(req.body?.caption ?? '').slice(0, 500) }))
  } finally {
    await rm(req.file?.path)
  }
}))

messagesRouter.post('/:id/voice', voiceUpload.single('file'), wrap(async (req, res) => {
  const u = me(req)
  const id = String(req.params.id)
  try {
    await assertMember(u.id, id)
    const sniffed = await validateVoiceNote(req.file)
    const seconds = Math.round(Number(req.body?.duration))
    const durationSeconds = Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), VOICE_NOTE_MAX_SECONDS) : undefined
    const key = `messages/${id}/${crypto.randomUUID()}.${sniffed.ext}`
    await storage.putFile(key, req.file!.path, sniffed.mime)
    res.status(201).json(await sendMessage({ senderId: u.id, conversationId: id, attachmentKey: key, messageType: 'AUDIO', durationSeconds }))
  } finally {
    await rm(req.file?.path)
  }
}))

messagesRouter.post('/:id/read', wrap(async (req, res) => {
  res.json({ marked: await markConversationRead(me(req).id, String(req.params.id)) })
}))
