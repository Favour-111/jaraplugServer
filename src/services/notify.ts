import { prisma } from '../db'
import { emitToUser } from './realtime'

export async function notify(userId: string, type: string, title: string, body = '', link?: string) {
  const n = await prisma.notification.create({ data: { userId, type, title, body, link } })
  emitToUser(userId, 'notification:new', n)
  return n
}

export async function notifyAdmins(type: string, title: string, body = '', link?: string) {
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN', accountStatus: 'ACTIVE' }, select: { id: true } })
  await Promise.all(admins.map((a) => notify(a.id, type, title, body, link)))
}
