import { z } from 'zod'
import { env } from '../env'
import { CREDIT_PACKAGES, MAX_TOPUP_CREDITS, MIN_TOPUP_CREDITS } from './constants'
import { ngnRates } from '../services/fx'

/**
 * Location-based pricing for credit top-ups.
 *
 * Credits are the platform's single internal unit: content prices, provider earnings and payouts stay in NGN/kobo.
 * Only the price a buyer pays for credits changes with their country. A buyer in Ghana pays in GHS, Kenya in KES,
 * South Africa in ZAR, and everyone else outside Nigeria in USD, as long as that currency is switched on in
 * PAYSTACK_CURRENCIES (Paystack only charges in currencies enabled on your merchant account).
 * Amounts are in the currency's minor unit (kobo, cents, pesewas…), which is what Paystack expects.
 *
 * Foreign prices are the naira price converted at today's exchange rate (services/fx.ts), plus FX_MARKUP_PERCENT
 * (default 0) if you want to cover conversion/international-card fees. CREDIT_PRICES pins a fixed price instead.
 */

export type Currency = 'NGN' | 'USD' | 'GHS' | 'KES' | 'ZAR'
const CURRENCIES = ['NGN', 'USD', 'GHS', 'KES', 'ZAR'] as const

/** Countries that pay in their own currency on Paystack. Everyone else pays in USD. */
const LOCAL_CURRENCY: Record<string, Currency> = { NG: 'NGN', GH: 'GHS', KE: 'KES', ZA: 'ZAR' }


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

/**
 * Price of one credit in `currency` minor units. May be fractional (e.g. 6.9 US cents); the total charged is
 * rounded UP to a whole minor unit by amountFor(), so a buyer never pays less than the naira price.
 */
export async function creditPriceIn(currency: Currency) {
  if (currency === 'NGN') return overrides.NGN ?? env.CREDIT_PRICE_KOBO
  if (overrides[currency]) return overrides[currency]!
  const { rates } = await ngnRates()
  const rate = rates[currency]
  if (!rate) throw new Error(`No exchange rate for ${currency}`)
  // kobo → naira → foreign major unit → foreign minor unit (all five currencies use 2 decimals).
  const price = (env.CREDIT_PRICE_KOBO / 100) * rate * 100 * (1 + env.FX_MARKUP_PERCENT / 100)
  return Math.round(price * 1e6) / 1e6 // fixed precision so the app and the server compute identical totals
}

/** What N credits cost, in whole minor units. The client uses the same formula to display prices. */
export const amountFor = (credits: number, creditPrice: number) => Math.ceil(Math.round(credits * creditPrice * 1e6) / 1e6)

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
export async function pricingFor(country: string | null | undefined) {
  let currency = currencyFor(country)
  let creditPrice: number
  try {
    creditPrice = await creditPriceIn(currency)
  } catch {
    currency = 'NGN' // no usable rate: sell in naira rather than at a wrong price
    creditPrice = await creditPriceIn('NGN')
  }
  const minTopup = Math.max(MIN_TOPUP_CREDITS, Math.ceil(MIN_CHARGE[currency] / creditPrice))
  const fx = currency === 'NGN' || overrides[currency] ? null : await ngnRates()
  return {
    country: country ?? null,
    currency,
    creditPrice,
    /** When the exchange rate used was published (null for NGN / fixed prices). */
    rateUpdatedAt: fx?.updatedAt ?? null,
    minTopup,
    maxTopup: MAX_TOPUP_CREDITS,
    packages: CREDIT_PACKAGES.filter((n) => n >= minTopup),
  }
}
