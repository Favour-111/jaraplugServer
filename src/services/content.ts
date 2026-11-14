import type { MediaContent, User } from '@prisma/client'
import { prisma } from '../db'
import { storage } from '../storage'
import { blurImage } from '../lib/upload'
import { isBlockedEitherWay } from './blocks'

export type Viewer = Pick<User, 'id' | 'role' | 'ageVerificationStatus' | 'accountStatus'> | null

export const isListable = (c: Pick<MediaContent, 'status' | 'moderationStatus'>) =>
  c.status === 'PUBLISHED' && c.moderationStatus === 'APPROVED'

/**
 * Single source of truth for "may this viewer receive the real media file?".
 * Every signed URL is minted only after this returns true.
 */
export async function canAccessContent(viewer: Viewer, content: MediaContent): Promise<boolean> {
  if (viewer?.role === 'ADMIN') return true
  if (viewer && viewer.id === content.providerId) return true
  if (!isListable(content)) return false
  if (viewer && (await isBlockedEitherWay(viewer.id, content.providerId))) return false

  const owner = await prisma.user.findUnique({ where: { id: content.providerId }, select: { accountStatus: true } })
  if (owner?.accountStatus !== 'ACTIVE') return false

  switch (content.visibility) {
    case 'PUBLIC':
      return true
    case 'FREE_MEMBERS':
      return !!viewer && viewer.accountStatus === 'ACTIVE' && viewer.ageVerificationStatus === 'VERIFIED'
    case 'PAID': {
      if (!viewer || viewer.ageVerificationStatus !== 'VERIFIED') return false
      const p = await prisma.contentPurchase.findUnique({
        where: { buyerId_contentId: { buyerId: viewer.id, contentId: content.id } },
      })
      return p?.status === 'COMPLETED'
    }
  }
}

const pendingBlur = new Map<string, Promise<string | null>>()

/**
 * Key of the server-blurred thumbnail, creating it on first use for items uploaded before blurred copies existed.
 * Returns null when no blurred copy can be made; the caller then shows NO thumbnail rather than the clear one.
 */
export function blurredThumbKey(c: Pick<MediaContent, 'id' | 'thumbnailKey' | 'blurThumbKey'>): Promise<string | null> {
  if (c.blurThumbKey) return Promise.resolve(c.blurThumbKey)
  if (!c.thumbnailKey) return Promise.resolve(null)
  const source = c.thumbnailKey
  let p = pendingBlur.get(c.id)
  if (!p) {
    p = (async () => {
      try {
        const key = source.replace(/(\.\w+)?$/, '.blur.jpg')
        await storage.putBuffer(key, await blurImage(await storage.getBuffer(source)), 'image/jpeg')
        await prisma.mediaContent.update({ where: { id: c.id }, data: { blurThumbKey: key } })
        return key
      } catch (e) {
        console.warn(`Could not create a blurred thumbnail for content ${c.id}:`, e instanceof Error ? e.message : e)
        return null
      } finally {
        pendingBlur.delete(c.id)
      }
    })()
    pendingBlur.set(c.id, p)
  }
  return p
}

/** Public-safe card for a content item. `url` is only present when the viewer is entitled. */
export async function serializeContent(content: MediaContent, viewer: Viewer, opts: { withUrl?: boolean } = {}) {
  const accessible = await canAccessContent(viewer, content)
  const isOwner = viewer?.id === content.providerId
  // Locked items (paid, members-only…) only ever get the blurred thumbnail, photos and videos alike.
  const thumbKey = accessible ? content.thumbnailKey : await blurredThumbKey(content)
  return {
    id: content.id,
    providerId: content.providerId,
    title: content.title,
    description: content.description,
    mediaType: content.mediaType,
    visibility: content.visibility,
    price: content.price,
    durationSeconds: content.durationSeconds,
    status: content.status,
    moderationStatus: isOwner || viewer?.role === 'ADMIN' ? content.moderationStatus : undefined,
    moderationNote: isOwner ? content.moderationNote : undefined,
    createdAt: content.createdAt,
    locked: !accessible,
    // Locked thumbnails are server-side blurred derivatives — never CSS-blurred originals.
    thumbnailUrl: thumbKey ? await storage.signedUrl(thumbKey, 3600) : null,
    url: accessible && opts.withUrl !== false ? await storage.signedUrl(content.storageKey) : null,
  }
}
