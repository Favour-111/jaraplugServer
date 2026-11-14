import { z } from 'zod'
import { env } from '../env'
import { CREDIT_PACKAGES, MAX_TOPUP_CREDITS, MIN_TOPUP_CREDITS } from './constants'

/**
 * Location-based pricing for credit top-ups.
 *
 * Credits are the platform's single internal unit: content prices, provider earnings and payouts stay in NGN/kobo.
 * Only the price a buyer pays for credits changes with their country. A buyer in Ghana pays in GHS, Kenya in KES,
 * South Africa in ZAR, and everyone else outside Nigeria in USD, as long as that currency is switched on in
 * PAYSTACK_CURRENCIES (Paystack only charges in currencies enabled on your merchant account).
 * Amounts are in the currency's minor unit (kobo, cents, pesewas…), which is what Paystack expects.
 */

export type Currency = 'NGN' | 'USD' | 'GHS' | 'KES' | 'ZAR'
const CURRENCIES = ['NGN', 'USD', 'GHS', 'KES', 'ZAR'] as const

/** Countries that pay in their own currency on Paystack. Everyone else pays in USD. */
const LOCAL_CURRENCY: Record<string, Currency> = { NG: 'NGN', GH: 'GHS', KE: 'KES', ZA: 'ZAR' }

/** Default price of one credit, in minor units. Override with CREDIT_PRICES, e.g. "USD:10,GHS:100". */
const DEFAULT_CREDIT_PRICE: Record<Currency, number> = {
  NGN: env.CREDIT_PRICE_KOBO, // ₦100
  USD: 10, // $0.10
  GHS: 100, // GH₵1.00
  KES: 1000, // KSh10
  ZAR: 125, // R1.25
}

/** Paystack's smallest accepted charge per currency (minor units). Small top-ups are raised to meet it. */
const MIN_CHARGE: Record<Currency, number> = { NGN: 5_000, USD: 200, GHS: 10, KES: 300, ZAR: 100 }

const enabled = new Set(
  env.PAYSTACK_CURRENCIES.split(',').map((c) => c.trim().toUpperCase()).filter((c): c is Currency => (CURRENCIES as readonly string[]).includes(c)),
)
enabled.add('NGN') // Always available: it is the platform's home currency.

const overrides = Object.fromEntries(
  (env.CREDIT_PRICES ?? '').split(',').map((p) => p.split(':').map((s) => s.trim())).filter(([c, v]) => c && v)
    .map(([c, v]) => [c.toUpperCase(), Number(v)]).filter(([, v]) => Number.isInteger(v) && (v as number) > 0),
) as Partial<Record<Currency, number>>

export const creditPriceIn = (currency: Currency) => overrides[currency] ?? DEFAULT_CREDIT_PRICE[currency]

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })
/** ISO 3166-1 alpha-2 code ("NG", "GB", "US"…) for a real country. */
export const isCountryCode = (c: string) => {
  if (!/^[A-Z]{2}$/.test(c) || c === 'ZZ') return false
  try { const n = regionNames.of(c); return !!n && n !== c } catch { return false }
}
export const countryField = z.string().trim().toUpperCase().refine(isCountryCode, 'Choose your country')

export const countryName = (code: string | null | undefined) => {
  if (!code) return null
  try { return regionNames.of(code) ?? code } catch { return code }
}

/** The currency a buyer from `country` is charged in. Unknown country → Nigeria (the original behaviour). */
export function currencyFor(country: string | null | undefined): Currency {
  const local = LOCAL_CURRENCY[country ?? 'NG'] ?? 'USD'
  if (enabled.has(local)) return local
  return enabled.has('USD') ? 'USD' : 'NGN'
}

/** Everything the Credits page needs to show and charge prices for a buyer. */
export function pricingFor(country: string | null | undefined) {
  const currency = currencyFor(country)
  const creditPrice = creditPriceIn(currency)
  const minTopup = Math.max(MIN_TOPUP_CREDITS, Math.ceil(MIN_CHARGE[currency] / creditPrice))
  return {
    country: country ?? null,
    currency,
    creditPrice,
    minTopup,
    maxTopup: MAX_TOPUP_CREDITS,
    packages: CREDIT_PACKAGES.filter((n) => n >= minTopup),
  }
}
