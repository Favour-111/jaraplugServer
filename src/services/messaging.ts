import { prisma } from '../db'
import { MESSAGE_MAX_LENGTH } from '../config/constants'
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors'
import { emitToUser, isOnline } from './realtime'
import { isBlockedEitherWay } from './blocks'
import { storage } from '../storage'

const pairKeyOf = (a: string, b: string) => [a, b].sort().join(':')

/** Sliding-window per-user limiter for chat messages (30 / minute). */
const sendLog = new Map<string, number[]>()
function checkRate(userId: string) {
  const now = Date.now()
  const arr = (sendLog.get(userId) ?? []).filter((t) => now - t < 60_000)
  if (arr.length >= 30) throw new HttpError(429, 'You are sending messages too quickly', 'RATE_LIMITED')
  arr.push(now)
  sendLog.set(userId, arr)
}
export const resetMessageRateLimits = () => sendLog.clear()

/** Returns the OTHER participant's id, or throws 404 (never reveals whether the conversation exists). */
export async function assertMember(userId: string, conversationId: string): Promise<string> {
  const parts = await prisma.conversationParticipant.findMany({ where: { conversationId } })
  if (!parts.some((p) => p.userId === userId)) throw notFound('Conversation not found')
  const other = parts.find((p) => p.userId !== userId)
  if (!other) throw notFound('Conversation not found')
  return other.userId
}

export async function getOrCreateConversation(userId: string, otherId: string) {
  if (userId === otherId) throw badRequest('You cannot message yourself')
  if (await isBlockedEitherWay(userId, otherId)) throw forbidden('You cannot message this user', 'BLOCKED')
  const pairKey = pairKeyOf(userId, otherId)
  return prisma.conversation.upsert({
    where: { pairKey },
    update: {},
    create: { pairKey, participants: { create: [{ userId }, { userId: otherId }] } },
  })
}

export async function serializeMessage(m: {
  id: string; conversationId: string; senderId: string; messageType: string; body: string
  attachmentKey: string | null; durationSeconds?: number | null; createdAt: Date; deliveredAt: Date | null; readAt: Date | null
}) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    messageType: m.messageType,
    body: m.body,
    attachmentUrl: m.attachmentKey ? await storage.signedUrl(m.attachmentKey, 3600) : null,
    durationSeconds: m.durationSeconds ?? null,
    createdAt: m.createdAt,
    deliveredAt: m.deliveredAt,
    readAt: m.readAt,
  }
}

export async function sendMessage(input: {
  senderId: string; conversationId: string; body?: string; attachmentKey?: string; messageType?: 'IMAGE' | 'AUDIO'; durationSeconds?: number
}) {
  const body = (input.body ?? '').trim()
  const hasAttachment = !!input.attachmentKey
  const type = hasAttachment ? (input.messageType ?? 'IMAGE') : 'TEXT'
  if (!hasAttachment && !body) throw badRequest('Message cannot be empty')
  if (body.length > MESSAGE_MAX_LENGTH) throw badRequest(`Messages are limited to ${MESSAGE_MAX_LENGTH} characters`)

  const otherId = await assertMember(input.senderId, input.conversationId)
  const [sender, other] = await Promise.all([
    prisma.user.findUnique({ where: { id: input.senderId } }),
    prisma.user.findUnique({ where: { id: otherId } }),
  ])
  if (!sender || sender.accountStatus !== 'ACTIVE') throw forbidden('Account unavailable')
  if (sender.role !== 'ADMIN' && sender.ageVerificationStatus !== 'VERIFIED')
    throw forbidden('Age verification is required before you can send messages', 'AGE_VERIFICATION_REQUIRED')
  if (!other || other.accountStatus !== 'ACTIVE') throw forbidden('This user is no longer available')
  if (await isBlockedEitherWay(input.senderId, otherId)) throw forbidden('You cannot message this user', 'BLOCKED')
  checkRate(input.senderId)

  const now = new Date()
  const delivered = isOnline(otherId) ? now : null
  const [message] = await prisma.$transaction([
    prisma.message.create({
      data: {
        conversationId: input.conversationId,
        senderId: input.senderId,
        messageType: type,
        body,
        attachmentKey: input.attachmentKey,
        durationSeconds: type === 'AUDIO' ? input.durationSeconds : undefined,
        deliveredAt: delivered,
      },
    }),
    prisma.conversation.update({ where: { id: input.conversationId }, data: { lastMessageAt: now } }),
  ])
  const dto = await serializeMessage(message)
  emitToUser(otherId, 'message:new', dto)
  emitToUser(input.senderId, 'message:new', dto)
  return dto
}

export async function markConversationRead(userId: string, conversationId: string) {
  const otherId = await assertMember(userId, conversationId)
  const now = new Date()
  const res = await prisma.message.updateMany({
    where: { conversationId, senderId: otherId, readAt: null },
    data: { readAt: now, deliveredAt: now },
  })
  await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: { lastReadAt: now },
  })
  if (res.count > 0) emitToUser(otherId, 'message:status', { conversationId, status: 'read', readAt: now })
  return res.count
}
