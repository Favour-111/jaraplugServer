import '../src/env'
import { prisma } from '../src/db'
import { seedDemoData, wipeDatabase, wipeStorage } from '../scripts/seed-lib'

async function main() {
  await wipeDatabase()
  await wipeStorage()
  await seedDemoData()
  console.log('✔ Demo data seeded. Sign in from the dev login screen as demo_ife (client), amara (provider) or demo_admin (admin).')
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
