import { prisma } from '../db'
import type { Prisma } from '@prisma/client'

type Db = Prisma.TransactionClient | typeof prisma

/** Every sensitive administrator action is written to the audit log with the reason given. */
export const audit = (
  adminId: string,
  action: string,
  targetType: string,
  targetId: string,
  reason?: string,
  metadata?: Prisma.InputJsonValue,
  db: Db = prisma,
) => db.auditLog.create({ data: { administratorId: adminId, action, targetType, targetId, reason, metadata } })
