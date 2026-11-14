/**
 * Live exchange rates, from NGN to every other currency.
 *
 * Source: ExchangeRate-API's free open endpoint (https://www.exchangerate-api.com/docs/free) — no API key, updated
 * once a day, includes NGN. Only the base currency code is sent; no user data leaves the server.
 * Rates are cached for FX_CACHE_HOURS; if the service is unreachable the last good rates are kept, and before any
 * fetch has ever succeeded the conservative fallback rates below are used (and a warning is logged).
 */
import { env } from '../env'

type Rates = { rates: Record<string, number>; updatedAt: Date; source: 'live' | 'fallback' }

// Approximate units of each currency per 1 NGN, used only until the first successful fetch.
const FALLBACK: Record<string, number> = { NGN: 1, USD: 0.00066, GHS: 0.0072, KES: 0.085, ZAR: 0.012 }

let cache: Rates | null = null
let inflight: Promise<Rates> | null = null

async function fetchRates(): Promise<Rates> {
  const res = await fetch('https://open.er-api.com/v6/latest/NGN', { signal: AbortSignal.timeout(8_000) })
  const json = (await res.json()) as { result?: string; rates?: Record<string, number>; time_last_update_unix?: number }
  if (!res.ok || json.result !== 'success' || !json.rates?.USD) throw new Error(`exchange-rate API answered ${res.status} ${json.result ?? ''}`)
  return { rates: json.rates, updatedAt: new Date((json.time_last_update_unix ?? Date.now() / 1000) * 1000), source: 'live' }
}

/** NGN → currency rates, refreshed at most every FX_CACHE_HOURS. Never throws. */
export async function ngnRates(): Promise<Rates> {
  const fresh = cache && cache.source === 'live' && Date.now() - fetchedAt < env.FX_CACHE_HOURS * 3_600_000
  if (fresh) return cache!
  if (env.NODE_ENV === 'test') return (cache = { rates: FALLBACK, updatedAt: new Date(), source: 'fallback' })
  inflight ??= fetchRates()
    .then((r) => { cache = r; fetchedAt = Date.now(); return r })
    .catch((e) => {
      console.warn('⚠  Could not refresh exchange rates, using', cache ? 'the last known rates' : 'fallback rates', '-', e instanceof Error ? e.message : e)
      // Retry in 10 minutes rather than on every request.
      fetchedAt = Date.now() - env.FX_CACHE_HOURS * 3_600_000 + 600_000
      return (cache ??= { rates: FALLBACK, updatedAt: new Date(), source: 'fallback' })
    })
    .finally(() => { inflight = null })
  return inflight
}
let fetchedAt = 0

/** Test hook: pin the rates. */
export function setRatesForTests(rates: Record<string, number>) {
  cache = { rates: { NGN: 1, ...rates }, updatedAt: new Date(), source: 'live' }
  fetchedAt = Date.now()
}
