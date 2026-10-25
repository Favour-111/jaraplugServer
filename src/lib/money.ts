/** All money is integer kobo. 1 NGN = 100 kobo. */
export const nairaToKobo = (naira: number) => Math.round(naira * 100)
export const koboToNaira = (kobo: number) => kobo / 100
export const formatNaira = (kobo: number) =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 }).format(kobo / 100)

/** Commission is always computed on the server from basis points. */
export function splitAmount(amountKobo: number, commissionBps: number, processingFeeKobo = 0) {
  const platformFee = Math.round((amountKobo * commissionBps) / 10_000)
  const netAmount = amountKobo - platformFee - processingFeeKobo
  return { platformFee, processingFee: processingFeeKobo, netAmount }
}
