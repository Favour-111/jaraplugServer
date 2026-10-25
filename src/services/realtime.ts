import type { Server as HttpServer } from 'node:http'
import { Server } from 'socket.io'
import { clientOrigins } from '../env'
import { resolveUserFromToken } from '../auth'
import { sendMessage, markConversationRead, assertMember } from './messaging' // circular with messaging, but only used at call time

let io: Server | null = null
const online = new Map<string, number>() // userId -> open socket count

export const isOnline = (userId: string) => (online.get(userId) ?? 0) > 0
export const emitToUser = (userId: string, event: string, payload: unknown) => {
  io?.to(`user:${userId}`).emit(event, payload)
}

export function attachRealtime(server: HttpServer) {
  io = new Server(server, {
    path: '/socket.io',
    cors: { origin: clientOrigins, credentials: true },
    maxHttpBufferSize: 16 * 1024,
  })

  io.use(async (socket, next) => {
    const user = await resolveUserFromToken(socket.handshake.auth?.token)
    if (!user) return next(new Error('unauthorized'))
    socket.data.userId = user.id
    next()
  })

  io.on('connection', async (socket) => {
    const userId: string = socket.data.userId
    socket.join(`user:${userId}`)
    online.set(userId, (online.get(userId) ?? 0) + 1)
    if (online.get(userId) === 1) io!.emit('presence', { userId, online: true })

    socket.on('message:send', async (data, ack) => {
      try {
        const msg = await sendMessage({ senderId: userId, conversationId: String(data?.conversationId), body: String(data?.body ?? '') })
        ack?.({ ok: true, message: msg })
      } catch (e: any) {
        ack?.({ ok: false, error: e?.message ?? 'Could not send message', code: e?.code })
      }
    })

    socket.on('conversation:read', async (data, ack) => {
      try {
        await markConversationRead(userId, String(data?.conversationId))
        ack?.({ ok: true })
      } catch (e: any) {
        ack?.({ ok: false, error: e?.message })
      }
    })

    socket.on('typing', async (data) => {
      try {
        const other = await assertMember(userId, String(data?.conversationId))
        emitToUser(other, 'typing', { conversationId: data.conversationId, userId, isTyping: !!data.isTyping })
      } catch {
        /* ignore */
      }
    })

    socket.on('disconnect', () => {
      const n = (online.get(userId) ?? 1) - 1
      if (n <= 0) {
        online.delete(userId)
        io?.emit('presence', { userId, online: false })
      } else online.set(userId, n)
    })
  })
  return io
}
