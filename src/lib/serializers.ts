import type { ProviderProfile, User } from '@prisma/client'
import { storage } from '../storage'
import { isOnline } from '../services/realtime'

type PublicFields = { age?: boolean; area?: boolean }

export async function toProviderCard(
  user: Pick<User, 'id' | 'username' | 'displayName' | 'createdAt' | 'lastSeenAt' | 'isDemo'>,
  profile: ProviderProfile,
  opts: { isFavorite?: boolean } = {},
) {
  const pf = (profile.publicFields ?? {}) as PublicFields
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName ?? user.username,
    age: pf.age !== false ? profile.displayAge : null,
    city: profile.city,
    area: pf.area !== false ? profile.area : null,
    availabilityStatus: profile.availabilityStatus,
    online: isOnline(user.id),
    verified: profile.verificationStatus === 'VERIFIED',
    avatarUrl: profile.profileImage ? await storage.signedUrl(profile.profileImage, 3600) : null,
    isFavorite: !!opts.isFavorite,
    memberSince: user.createdAt,
    isDemo: user.isDemo,
  }
}

/** Minimal public view of any user (e.g. the other side of a conversation). */
export async function toUserSummary(u: Pick<User, 'id' | 'username' | 'displayName' | 'avatarKey' | 'role'> & { providerProfile?: ProviderProfile | null }) {
  const key = u.providerProfile?.profileImage ?? u.avatarKey
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName ?? u.username ?? 'Member',
    role: u.role,
    avatarUrl: key ? await storage.signedUrl(key, 3600) : null,
    online: isOnline(u.id),
  }
}

/** The signed-in user's own account object. Never exposes other users' private fields. */
export function toSelf(u: User, profile?: ProviderProfile | null) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    role: u.role,
    accountStatus: u.accountStatus,
    ageVerificationStatus: u.ageVerificationStatus,
    city: u.city,
    preferences: u.preferences,
    onboarded: !!u.onboardedAt,
    isDemo: u.isDemo,
    providerProfile: profile
      ? {
          verificationStatus: profile.verificationStatus,
          visibility: profile.visibility,
          availabilityStatus: profile.availabilityStatus,
          submittedAt: profile.submittedAt,
        }
      : null,
    createdAt: u.createdAt,
  }
}
