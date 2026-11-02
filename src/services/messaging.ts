import { prisma } from '../db'
import { MESSAGE_MAX_LENGTH } from '../config/constants'
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors'
import { emitToUser, isOnline } from './realtime'
import { isBlockedEitherWay } from './blocks'
import { storage } from '../storage'
import { assertNotSample } from './sample'

/** How long the link handed out when a view-once item is opened stays valid. */
export const VIEW_ONCE_URL_TTL_SECONDS = 120

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
  viewOnce?: boolean; viewedAt?: Date | null
}) {
  const viewOnce = !!m.viewOnce
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    messageType: m.messageType,
    body: m.body,
    // View-once media never gets a link here, for either person: the only way to a link is claimViewOnce(), which works once.
    attachmentUrl: m.attachmentKey && !viewOnce ? await storage.signedUrl(m.attachmentKey, 3600) : null,
    viewOnce,
    viewedAt: viewOnce ? (m.viewedAt ?? null) : null,
    durationSeconds: m.durationSeconds ?? null,
    createdAt: m.createdAt,
    deliveredAt: m.deliveredAt,
    readAt: m.readAt,
  }
}

export async function sendMessage(input: {
  senderId: string; conversationId: string; body?: string; attachmentKey?: string; messageType?: 'IMAGE' | 'AUDIO' | 'VIDEO'; durationSeconds?: number; viewOnce?: boolean
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
  assertNotSample(sender, other)
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
        durationSeconds: type === 'AUDIO' || type === 'VIDEO' ? input.durationSeconds : undefined,
        viewOnce: hasAttachment && (type === 'IMAGE' || type === 'VIDEO') && !!input.viewOnce,
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

/**
 * Opens a view-once photo/video for the recipient. Works exactly once: the claim is a single atomic UPDATE, so two
 * simultaneous requests cannot both succeed. The sender can never open their own item, and neither can anyone outside the chat.
 */
export async function claimViewOnce(userId: string, conversationId: string, messageId: string) {
  const otherId = await assertMember(userId, conversationId)
  if (await isBlockedEitherWay(userId, otherId)) throw forbidden('You cannot open this', 'BLOCKED')
  const msg = await prisma.message.findFirst({ where: { id: messageId, conversationId, viewOnce: true } })
  if (!msg || !msg.attachmentKey) throw notFound('Message not found')
  if (msg.senderId === userId) throw forbidden('You cannot open your own view-once message', 'OWN_VIEW_ONCE')
  const now = new Date()
  const claimed = await prisma.message.updateMany({
    where: { id: messageId, viewOnce: true, viewedAt: null, attachmentKey: { not: null }, senderId: { not: userId } },
    data: { viewedAt: now, readAt: msg.readAt ?? now, deliveredAt: msg.deliveredAt ?? now },
  })
  if (claimed.count === 0) throw new HttpError(410, 'This was already opened and is no longer available', 'VIEW_ONCE_CONSUMED')
  const key = msg.attachmentKey
  const url = await storage.signedUrl(key, VIEW_ONCE_URL_TTL_SECONDS)
  // Delete the file as soon as the link has expired; purgeViewedMedia() is the safety net if the server restarts first.
  setTimeout(() => { void removeViewedMedia(messageId, key) }, (VIEW_ONCE_URL_TTL_SECONDS + 30) * 1000).unref()
  emitToUser(otherId, 'message:viewed', { conversationId, messageId, viewedAt: now })
  emitToUser(userId, 'message:viewed', { conversationId, messageId, viewedAt: now })
  return { url, messageType: msg.messageType, expiresInSeconds: VIEW_ONCE_URL_TTL_SECONDS }
}

async function removeViewedMedia(messageId: string, key: string) {
  try {
    await storage.delete(key)
    await prisma.message.updateMany({ where: { id: messageId, attachmentKey: key }, data: { attachmentKey: null } })
  } catch (e) { console.error('view-once cleanup failed', e) }
}

/** Deletes the stored file of every view-once message that was opened more than `graceSeconds` ago. */
export async function purgeViewedMedia(graceSeconds = VIEW_ONCE_URL_TTL_SECONDS + 30) {
  const rows = await prisma.message.findMany({
    where: { viewOnce: true, attachmentKey: { not: null }, viewedAt: { lt: new Date(Date.now() - graceSeconds * 1000) } },
    select: { id: true, attachmentKey: true },
    take: 500,
  })
  for (const r of rows) await removeViewedMedia(r.id, r.attachmentKey!)
  return rows.length
}
