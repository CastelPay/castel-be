import { desc } from "drizzle-orm";
import { db } from "../db";
import { rates } from "../db/schema";

/**
 * Live USD/IDR reference rate.
 *
 * This is NOT the rate a swap executes at — on Stellar that comes from the order book.
 * It is the mid-market reference the market maker quotes around, and the number the
 * money-changer comparison is measured against.
 *
 * Source: exchangerate-api.com's open endpoint. No key, no published rate limit, but it
 * refreshes ONCE A DAY and asks to be cached for an hour — so polling it harder than that
 * buys nothing.
 */
const SOURCE = "https://open.er-api.com/v6/latest/USD";
const TTL_MS = 60 * 60_000;

/**
 * Last resort only, and deliberately conservative. Reaching this means both the API and the
 * stored rate failed, and a wrong rate here misprices every quote — so it must never be the
 * quiet default. Render's free tier restarts on every cold start, which wipes the in-memory
 * cache; that is exactly why the last good rate is persisted.
 */
const FALLBACK_MID = 16_500;

/** Typical Bali money-changer markdown against mid-market, in IDR per USD. An estimate. */
export const MONEY_CHANGER_MARKDOWN = 200;

export type Mid = {
  rate: number;
  source: "live" | "cached" | "stored" | "fallback";
  at: number;
};

let memo: { rate: number; at: number } | null = null;

async function lastStored(): Promise<{ rate: number; at: number } | null> {
  try {
    const [row] = await db.select().from(rates).orderBy(desc(rates.fetchedAt)).limit(1);
    return row ? { rate: Number(row.usdIdr), at: row.fetchedAt } : null;
  } catch {
    return null;
  }
}

export async function usdIdrMid(): Promise<Mid> {
  if (memo && Date.now() - memo.at < TTL_MS) {
    return { rate: memo.rate, source: "cached", at: memo.at };
  }

  try {
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(5000) });
    const data = (await res.json()) as { rates?: Record<string, number> };
    const rate = Number(data?.rates?.IDR);
    // A plausibility floor: a "rate" of 1 or 0 would silently destroy every quote.
    if (Number.isFinite(rate) && rate > 5_000) {
      memo = { rate, at: Date.now() };
      await db
        .insert(rates)
        .values({ usdIdr: String(rate), fetchedAt: memo.at })
        .catch(() => {});
      return { rate, source: "live", at: memo.at };
    }
  } catch {
    // fall through to whatever we last knew
  }

  if (memo) return { rate: memo.rate, source: "cached", at: memo.at };

  const stored = await lastStored();
  if (stored) {
    memo = stored;
    return { rate: stored.rate, source: "stored", at: stored.at };
  }

  console.error("USD/IDR unavailable from API and database — quoting on the fallback rate");
  return { rate: FALLBACK_MID, source: "fallback", at: Date.now() };
}
