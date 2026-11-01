import type { Prisma, ProviderProfile, User } from '@prisma/client'

/**
 * A provider profile may appear in search engines (sitemap, `index` robots tag, profile photo in link previews) only
 * when the owner turned on "Allow search engines to discover my profile" AND an anonymous visitor can already see it:
 * active account, verified, "Public" visibility, photo set. Demo/seed accounts are never indexed.
 * Keep these two definitions in sync.
 */
export const searchIndexableProviderWhere: Prisma.UserWhereInput = {
  role: 'PROVIDER',
  accountStatus: 'ACTIVE',
  isDemo: false,
  username: { not: null },
  providerProfile: {
    is: { searchIndexingEnabled: true, visibility: 'PUBLIC', verificationStatus: 'VERIFIED', profileImage: { not: null } },
  },
}

export function isSearchIndexable(
  user: Pick<User, 'role' | 'accountStatus' | 'isDemo' | 'username'>,
  profile: Pick<ProviderProfile, 'searchIndexingEnabled' | 'visibility' | 'verificationStatus' | 'profileImage'>,
) {
  return (
    user.role === 'PROVIDER' && user.accountStatus === 'ACTIVE' && !user.isDemo && !!user.username &&
    profile.searchIndexingEnabled && profile.visibility === 'PUBLIC' && profile.verificationStatus === 'VERIFIED' && !!profile.profileImage
  )
}
