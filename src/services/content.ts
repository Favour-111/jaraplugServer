import type { MediaContent, User } from '@prisma/client'
import { prisma } from '../db'
import { storage } from '../storage'
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

/** Public-safe card for a content item. `url` is only present when the viewer is entitled. */
export async function serializeContent(content: MediaContent, viewer: Viewer, opts: { withUrl?: boolean } = {}) {
  const accessible = await canAccessContent(viewer, content)
  const isOwner = viewer?.id === content.providerId
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
    // Thumbnails of paid items are server-side pre-blurred derivatives — never CSS-blurred originals.
    thumbnailUrl: content.thumbnailKey ? await storage.signedUrl(content.thumbnailKey, 3600) : null,
    url: accessible && opts.withUrl !== false ? await storage.signedUrl(content.storageKey) : null,
  }
}
