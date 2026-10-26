export const CITIES = ['Lagos', 'Abuja', 'Port Harcourt', 'Ibadan', 'Enugu', 'Benin City'] as const

export const BOOKING_LEAD_HOURS = 2
export const BOOKING_MAX_DAYS_AHEAD = 60
export const BOOKING_DURATION_MINS = 60
export const LAGOS_OFFSET = '+01:00' // Africa/Lagos has no DST

export const MESSAGE_MAX_LENGTH = 2000
export const MIN_PAID_PRICE_KOBO = 50_000 // ₦500
export const MAX_PAID_PRICE_KOBO = 100_000_000 // ₦1,000,000
export const MIN_TOPUP_CREDITS = 1
export const MAX_TOPUP_CREDITS = 2000 // ₦200,000
export const CREDIT_PACKAGES = [10, 20, 50, 100, 200, 500] as const

export const PRIORITY_REPORT_CATEGORIES = ['NON_CONSENSUAL_IMAGERY', 'UNDERAGE', 'EXPLOITATION', 'IMPERSONATION'] as const
// Content reported under these categories is hidden immediately, pending admin review.
export const AUTO_HIDE_REPORT_CATEGORIES = ['NON_CONSENSUAL_IMAGERY', 'UNDERAGE', 'EXPLOITATION'] as const

/** Banks a provider can choose for withdrawals (account numbers are 10-digit NUBAN). */
export const NIGERIAN_BANKS = [
  'Access Bank', 'Citibank Nigeria', 'Ecobank Nigeria', 'Fidelity Bank', 'First Bank of Nigeria', 'First City Monument Bank (FCMB)',
  'Globus Bank', 'Guaranty Trust Bank (GTBank)', 'Heritage Bank', 'Keystone Bank', 'Kuda Microfinance Bank', 'Moniepoint Microfinance Bank',
  'OPay', 'PalmPay', 'Polaris Bank', 'Providus Bank', 'Stanbic IBTC Bank', 'Standard Chartered Bank', 'Sterling Bank',
  'SunTrust Bank', 'Union Bank of Nigeria', 'United Bank for Africa (UBA)', 'Unity Bank', 'VFD Microfinance Bank', 'Wema Bank', 'Zenith Bank',
] as const
