/** Usage: npm run make-admin -w server -- <username-or-email>   (the only way to create an administrator) */
import '../src/env'
import { prisma } from '../src/db'

async function main() {
  const who = process.argv[2]
  if (!who) throw new Error('Usage: make-admin <username-or-email>')
  const user = await prisma.user.findFirst({ where: { OR: [{ username: who }, { email: who }] } })
  if (!user) throw new Error(`No user found for "${who}". Sign up and onboard first.`)
  await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN', onboardedAt: user.onboardedAt ?? new Date(), ageVerificationStatus: 'VERIFIED' } })
  console.log(`✔ ${who} is now an administrator.`)
}
main().finally(() => prisma.$disconnect())
