/**
 * Live USD/IDR reference rate.
 *
 * This is NOT the rate a swap executes at — on Stellar that comes from the order book.
 * It is the mid-market reference the market maker quotes around, and the number the
 * money-changer comparison is measured against. Hardcoding it meant our quotes drifted
 * away from reality as soon as the rupiah moved.
 */
const SOURCE = "https://open.er-api.com/v6/latest/USD";
const TTL_MS = 10 * 60_000;

/** Last resort only — a stale rate is better than refusing to quote. */
const FALLBACK_MID = 16_500;

/** Typical Bali money-changer markdown against mid-market, in IDR per USD. An estimate. */
export const MONEY_CHANGER_MARKDOWN = 200;

export type Mid = { rate: number; source: "live" | "cached" | "fallback"; at: number };

let cache: { rate: number; at: number } | null = null;

export async function usdIdrMid(): Promise<Mid> {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return { rate: cache.rate, source: "cached", at: cache.at };
  }

  try {
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(5000) });
    const data = (await res.json()) as { rates?: Record<string, number> };
    const rate = Number(data?.rates?.IDR);
    // A plausibility floor: a "rate" of 1 or 0 would silently destroy every quote.
    if (Number.isFinite(rate) && rate > 5_000) {
      cache = { rate, at: Date.now() };
      return { rate, source: "live", at: cache.at };
    }
  } catch {
    // fall through
  }

  if (cache) return { rate: cache.rate, source: "cached", at: cache.at };
  return { rate: FALLBACK_MID, source: "fallback", at: Date.now() };
}
