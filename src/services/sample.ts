import type { User } from '@prisma/client'
import { forbidden } from '../lib/errors'

/**
 * Sample (isDemo) providers are shown publicly with a "Sample profile" label so visitors can see what a profile looks
 * like, but nobody answers for them: they can't message or be messaged, take bookings or sell content.
 */
export function assertNotSample(...users: (Pick<User, 'isDemo'> | null | undefined)[]) {
  if (users.some((u) => u?.isDemo)) throw forbidden('This is a sample profile. Messaging, bookings and purchases are not available.', 'SAMPLE_PROFILE')
}
