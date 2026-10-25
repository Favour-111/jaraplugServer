/** Wipes ALL data and local media in the DEVELOPMENT database and re-seeds demo data. Refuses to run in production. */
import '../src/env'
import { prisma } from '../src/db'
import { seedDemoData, wipeDatabase, wipeStorage } from './seed-lib'

async function main() {
  await wipeDatabase()
  await wipeStorage()
  await seedDemoData()
  console.log('✔ Development data reset and re-seeded.')
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
