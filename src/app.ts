import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { clientOrigins, env } from './env'
import { errorHandler } from './lib/errors'
import { publicRouter } from './routes/public'
import { meRouter } from './routes/me'
import { providerRouter } from './routes/provider'
import { contentRouter } from './routes/content'
import { purchasesRouter, webhookRouter } from './routes/purchases'
import { creditsRouter } from './routes/credits'
import { referralsRouter } from './routes/referrals'
import { messagesRouter } from './routes/messages'
import { bookingsRouter } from './routes/bookings'
import { socialRouter } from './routes/social'
import { verificationRouter } from './routes/verification'
import { adminRouter } from './routes/admin'

export function createApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.disable('x-powered-by')
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }))
  app.use(cors({ origin: clientOrigins, credentials: true }))

  const limit = (windowMs: number, max: number) =>
    rateLimit({ windowMs, limit: env.NODE_ENV === 'test' ? 100_000 : max, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests, please slow down', code: 'RATE_LIMITED' } })

  // Webhooks need the raw body for signature verification, so they are mounted before express.json().
  app.use('/api/webhooks', limit(60_000, 120), webhookRouter)

  app.use(express.json({ limit: '64kb' }))
  app.use('/api', limit(15 * 60_000, 1500))
  app.use('/api/reports', limit(60 * 60_000, 20))
  app.use('/api/track', limit(60_000, 60))
  app.use('/api/purchases/checkout', limit(60_000, 20))
  app.use('/api/dev', limit(60_000, 30))

  app.use('/api', publicRouter)
  app.use('/api/me', meRouter)
  app.use('/api/verification', verificationRouter)
  app.use('/api/provider', providerRouter)
  app.use('/api/content', contentRouter)
  app.use('/api/purchases', purchasesRouter)
  app.use('/api/credits', creditsRouter)
  app.use('/api/referrals', referralsRouter)
  app.use('/api/conversations', messagesRouter)
  app.use('/api/bookings', bookingsRouter)
  app.use('/api', socialRouter)
  app.use('/api/admin', adminRouter)

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }))
  app.use(errorHandler)
  return app
}
