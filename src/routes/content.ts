import { Router } from 'express'
import { z } from 'zod'
import crypto from 'node:crypto'
import sharp from 'sharp'
import { prisma } from '../db'
import { MAX_PAID_PRICE_KOBO, MIN_PAID_PRICE_KOBO } from '../config/constants'
import { badRequest, conflict, forbidden, notFound, wrap } from '../lib/errors'
import { me, optionalAuth, requireAuth, requireRole } from '../auth'
import { contentUpload, processImage, rm, validateUpload } from '../lib/upload'
import { probeVideo } from '../lib/video'
import { storage } from '../storage'
import { canAccessContent, serializeContent } from '../services/content'
import { nairaToKobo } from '../lib/money'
import { isBlockedEitherWay } from '../services/blocks'
import { env } from '../env'

export const contentRouter = Router()

const placeholderThumb = (blur: boolean) =>
  sharp({ create: { width: 480, height: 640, channels: 3, background: '#1a0509' } }).jpeg({ quality: 60 }).toBuffer().then((b) => (blur ? b : b))

const uploadFields = z.object({
  title: z.string().trim().min(2, 'Title is required').max(80),
  description: z.string().trim().max(500).default(''),
  visibility: z.enum(['PUBLIC', 'FREE_MEMBERS', 'PAID']),
  price: z.coerce.number().min(0).max(1_000_000).default(0), // naira
  publish: z.enum(['true', 'false']).default('false'),
  consentConfirmed: z.enum(['true', 'false']).default('false'),
})

function validatePricing(visibility: string, priceKobo: number) {
  if (visibility === 'PAID') {
    if (priceKobo < MIN_PAID_PRICE_KOBO || priceKobo > MAX_PAID_PRICE_KOBO)
      throw badRequest(`Paid content must be priced between ₦${MIN_PAID_PRICE_KOBO / 100} and ₦${(MAX_PAID_PRICE_KOBO / 100).toLocaleString()}`, 'BAD_PRICE')
    // Buyers pay in whole credits, so the price must be a whole number of credits.
    if (priceKobo % env.CREDIT_PRICE_KOBO !== 0)
      throw badRequest(`Price must be a whole number of credits (1 credit = ₦${env.CREDIT_PRICE_KOBO / 100})`, 'BAD_PRICE')
  } else if (priceKobo !== 0) throw badRequest('Only paid content can have a price', 'BAD_PRICE')
}

const requireVerifiedProvider = wrap(async (req, _res, next) => {
  const p = await prisma.providerProfile.findUnique({ where: { userId: me(req).id } })
  if (p?.verificationStatus !== 'VERIFIED') throw forbidden('Your profile must be verified before you can publish content', 'PROVIDER_NOT_VERIFIED')
  next()
})

// ─── Provider: list own content ───
contentRouter.get('/mine', requireAuth, requireRole('PROVIDER'), wrap(async (req, res) => {
  const u = me(req)
  const rows = await prisma.mediaContent.findMany({
    where: { providerId: u.id },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { purchases: true } } },
  })
  const items = await Promise.all(rows.map(async (r) => ({ ...(await serializeContent(r, u)), purchaseCount: r._count.purchases })))
  res.json({ items })
}))

// ─── Provider: upload ───
contentRouter.post('/', requireAuth, requireRole('PROVIDER'), contentUpload.single('file'), wrap(async (req, res) => {
  const u = me(req)
  const tmp = req.file?.path
  try {
    const sniffed = await validateUpload(req.file, ['IMAGE', 'VIDEO'])
    const f = uploadFields.parse(req.body)
    const priceKobo = nairaToKobo(f.price)
    validatePricing(f.visibility, priceKobo)
    const publish = f.publish === 'true'
    const consent = f.consentConfirmed === 'true'
    if (publish) {
      if (!consent) throw badRequest('You must confirm you own the rights to this media and that everyone shown is an adult who consented to its publication', 'CONSENT_REQUIRED')
      const profile = await prisma.providerProfile.findUnique({ where: { userId: u.id } })
      if (profile?.verificationStatus !== 'VERIFIED') throw forbidden('Your profile must be verified before you can publish content', 'PROVIDER_NOT_VERIFIED')
    }

    const id = crypto.randomUUID()
    const storageKey = `content/${u.id}/${id}.${sniffed.ext}`
    const thumbKey = `thumbs/${u.id}/${id}.jpg`
    const blur = f.visibility === 'PAID'
    let thumb: Buffer
    let durationSeconds: number | null = null
    let main: { path: string; mime: string } = { path: req.file!.path, mime: sniffed.mime }

    if (sniffed.kind === 'IMAGE') {
      const processed = await processImage(req.file!.path, { blurThumb: blur })
      thumb = processed.thumb
      // Re-encoded copy: strips EXIF/GPS metadata from everything we store.
      await storage.putBuffer(storageKey.replace(/\.\w+$/, '.jpg'), processed.main, 'image/jpeg')
      main = { path: '', mime: 'image/jpeg' }
    } else {
      const probe = await probeVideo(req.file!.path)
      durationSeconds = probe.durationSeconds
      if (probe.poster) {
        const base = sharp(probe.poster).resize({ width: 480 })
        thumb = await (blur ? base.resize({ width: 24 }).blur(1).resize({ width: 480, kernel: 'cubic' }) : base).jpeg({ quality: 70 }).toBuffer()
      } else thumb = await placeholderThumb(blur)
      await storage.putFile(storageKey, req.file!.path, sniffed.mime)
    }
    await storage.putBuffer(thumbKey, thumb, 'image/jpeg')

    const finalKey = sniffed.kind === 'IMAGE' ? storageKey.replace(/\.\w+$/, '.jpg') : storageKey
    const content = await prisma.mediaContent.create({
      data: {
        id, providerId: u.id, title: f.title, description: f.description, mediaType: sniffed.kind, mimeType: main.mime,
        sizeBytes: req.file!.size, storageKey: finalKey, thumbnailKey: thumbKey, visibility: f.visibility, price: priceKobo,
        status: publish ? 'PUBLISHED' : 'DRAFT', moderationStatus: 'APPROVED', consentConfirmed: consent, durationSeconds,
      },
    })
    res.status(201).json(await serializeContent(content, u))
  } finally {
    await rm(tmp)
  }
}))

// ─── Provider: edit / publish / unpublish ───
contentRouter.patch('/:id', requireAuth, requireRole('PROVIDER'), wrap(async (req, res) => {
  const u = me(req)
  const content = await prisma.mediaContent.findUnique({ where: { id: String(req.params.id) }, include: { _count: { select: { purchases: true } } } })
  if (!content || content.providerId !== u.id) throw notFound('Content not found')
  if (content.moderationStatus === 'REMOVED') throw forbidden('This content was removed by a moderator', 'CONTENT_REMOVED')
  const body = z.object({
    title: z.string().trim().min(2).max(80).optional(),
    description: z.string().trim().max(500).optional(),
    visibility: z.enum(['PUBLIC', 'FREE_MEMBERS', 'PAID']).optional(),
    price: z.number().min(0).max(1_000_000).optional(),
    publish: z.boolean().optional(),
    consentConfirmed: z.boolean().optional(),
  }).parse(req.body)

  const visibility = body.visibility ?? content.visibility
  const priceKobo = body.price !== undefined ? nairaToKobo(body.price) : visibility === 'PAID' ? content.price : 0
  if (content._count.purchases > 0 && (visibility !== content.visibility || priceKobo !== content.price))
    throw conflict('Price and visibility cannot change after the item has been purchased', 'HAS_PURCHASES')
  validatePricing(visibility, priceKobo)

  const consent = body.consentConfirmed ?? content.consentConfirmed
  if (body.publish === true) {
    if (!consent) throw badRequest('Rights and consent confirmation is required to publish', 'CONSENT_REQUIRED')
    const profile = await prisma.providerProfile.findUnique({ where: { userId: u.id } })
    if (profile?.verificationStatus !== 'VERIFIED') throw forbidden('Your profile must be verified before you can publish content', 'PROVIDER_NOT_VERIFIED')
  }
  const updated = await prisma.mediaContent.update({
    where: { id: content.id },
    data: {
      title: body.title, description: body.description, visibility, price: priceKobo, consentConfirmed: consent,
      ...(body.publish === true && content.status !== 'PUBLISHED' ? { status: 'PUBLISHED', moderationStatus: 'APPROVED' } : {}),
      ...(body.publish === false ? { status: 'DRAFT' } : {}),
    },
  })
  res.json(await serializeContent(updated, u))
}))

contentRouter.delete('/:id', requireAuth, requireRole('PROVIDER'), wrap(async (req, res) => {
  const u = me(req)
  const content = await prisma.mediaContent.findUnique({ where: { id: String(req.params.id) }, include: { _count: { select: { purchases: true } } } })
  if (!content || content.providerId !== u.id) throw notFound('Content not found')
  if (content._count.purchases > 0) throw conflict('This item has been purchased and cannot be deleted. Unpublish it instead.', 'HAS_PURCHASES')
  await prisma.mediaContent.delete({ where: { id: content.id } })
  await Promise.all([storage.delete(content.storageKey), content.thumbnailKey ? storage.delete(content.thumbnailKey) : null].map((p) => p?.catch(() => {})))
  res.json({ ok: true })
}))

// ─── Viewer: metadata (never includes a media URL unless entitled) ───
contentRouter.get('/:id', optionalAuth, wrap(async (req, res) => {
  const content = await prisma.mediaContent.findUnique({ where: { id: String(req.params.id) }, include: { provider: { select: { username: true, displayName: true } } } })
  if (!content) throw notFound('Content not found')
  const viewer = req.user ?? null
  const visibleToList = (content.status === 'PUBLISHED' && content.moderationStatus === 'APPROVED') || viewer?.id === content.providerId || viewer?.role === 'ADMIN'
  if (!visibleToList) throw notFound('Content not found')
  res.json({ ...(await serializeContent(content, viewer)), provider: content.provider })
}))

// ─── Viewer: mint a short-lived signed URL AFTER checking entitlement ───
contentRouter.post('/:id/access', optionalAuth, wrap(async (req, res) => {
  const content = await prisma.mediaContent.findUnique({ where: { id: String(req.params.id) } })
  if (!content) throw notFound('Content not found')
  const viewer = req.user ?? null
  // A blocked pair behaves as if the content does not exist.
  if (viewer && viewer.id !== content.providerId && viewer.role !== 'ADMIN' && (await isBlockedEitherWay(viewer.id, content.providerId))) throw notFound('Content not found')
  if (!(await canAccessContent(viewer, content))) {
    const code = content.visibility === 'PAID' ? 'PURCHASE_REQUIRED' : viewer ? 'AGE_VERIFICATION_REQUIRED' : 'LOGIN_REQUIRED'
    // 404 for items that aren't listable at all, so existence of hidden content isn't revealed.
    if (!(viewer?.id === content.providerId) && (content.status !== 'PUBLISHED' || content.moderationStatus !== 'APPROVED')) throw notFound('Content not found')
    throw forbidden('You do not have access to this content', code)
  }
  const ttl = env.MEDIA_URL_TTL_SECONDS
  res.json({ url: await storage.signedUrl(content.storageKey, ttl), mediaType: content.mediaType, expiresAt: new Date(Date.now() + ttl * 1000) })
}))
