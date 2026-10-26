import http from 'node:http'
import { env } from './env'
import { createApp } from './app'
import { attachRealtime } from './services/realtime'
import { prisma } from './db'
import { checkStorageConfig } from './storage'

const app = createApp()
const server = http.createServer(app)
attachRealtime(server)

server.listen(env.PORT, () => {
  console.log(`▲ JaraPlug API listening on :${env.PORT}  (auth=${env.AUTH_MODE}, storage=${env.STORAGE_DRIVER}, payments=${env.PAYSTACK_SECRET_KEY ? (env.PAYSTACK_SECRET_KEY.startsWith('sk_live_') ? 'paystack-live' : 'paystack-test') : 'NOT CONFIGURED'})`)
  void checkStorageConfig()
  if (env.AUTH_MODE === 'dev') console.warn('⚠  AUTH_MODE=dev — passwordless dev login is enabled. Never use this in production.')
  if (env.DEMO_AUTO_VERIFY) console.warn('⚠  DEMO_AUTO_VERIFY=true — age verification is DISABLED for testing. Remove it before production (the API refuses to boot with it in production).')
  if (!env.PAYSTACK_SECRET_KEY) console.warn('⚠  PAYSTACK_SECRET_KEY is not set — buying credits is unavailable.')
  else if (!env.PAYSTACK_SECRET_KEY.startsWith('sk_live_')) console.warn('⚠  Paystack TEST key in use — no real money moves until you switch to an sk_live_ key.')
})

const shutdown = async () => {
  server.close()
  await prisma.$disconnect()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
