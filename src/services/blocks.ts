import { prisma } from '../db'

/** True when either user has blocked the other. */
export async function isBlockedEitherWay(a: string, b: string): Promise<boolean> {
  const n = await prisma.block.count({
    where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] },
  })
  return n > 0
}

/** IDs the given user must not see or interact with (blocked in either direction). */
export async function blockedIdsFor(userId: string): Promise<string[]> {
  const rows = await prisma.block.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true },
  })
  return rows.map((r) => (r.blockerId === userId ? r.blockedId : r.blockerId))
}
