import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { transactions } from "../db/schema";

/**
 * Tier 0 = Simplified CDD: we know the WhatsApp number and a self-declared name,
 * nothing more. FATF Rec.16 sets a de-minimis of USD 1,000 for that level, and its
 * aggregation rule says linked transactions must be counted together — so a single
 * transaction cap alone is meaningless, and a rolling window is required.
 *
 * Raising these is a KYC upgrade (Tier 1: passport + selfie), not a config change.
 */
export const TIER0_TX_CAP_IDR = 16_500_000;
export const TIER0_WINDOW_CAP_IDR = 16_500_000;
export const TIER0_TX_CAP_USD = 1_000;
export const TIER0_WINDOW_CAP_USD = 1_000;
export const WINDOW_MS = 30 * 24 * 60 * 60_000;

/** Rows of type "deposit" store USD in amount_idr, so the two flows are summed apart. */
async function sumSince(waNumber: string, types: string[]): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${transactions.amountIdr}), 0)::bigint` })
    .from(transactions)
    .where(
      and(
        eq(transactions.waNumber, waNumber),
        inArray(transactions.type, types),
        gt(transactions.createdAt, Date.now() - WINDOW_MS),
      ),
    );
  return Number(row?.total ?? 0);
}

export const spentIdr = (waNumber: string) => sumSince(waNumber, ["pay", "cashout"]);
export const depositedUsd = (waNumber: string) => sumSince(waNumber, ["deposit"]);

export type LimitCheck = { ok: true } | { ok: false; error: string };

export async function checkSpendLimit(waNumber: string, amountIdr: number): Promise<LimitCheck> {
  if (amountIdr > TIER0_TX_CAP_IDR)
    return { ok: false, error: `single transaction limit is Rp ${TIER0_TX_CAP_IDR.toLocaleString("id-ID")} — verify your passport to raise it` };
  const spent = await spentIdr(waNumber);
  if (spent + amountIdr > TIER0_WINDOW_CAP_IDR)
    return { ok: false, error: `30-day limit reached (Rp ${spent.toLocaleString("id-ID")} of Rp ${TIER0_WINDOW_CAP_IDR.toLocaleString("id-ID")}) — verify your passport to raise it` };
  return { ok: true };
}

export async function checkDepositLimit(waNumber: string, usd: number): Promise<LimitCheck> {
  if (usd > TIER0_TX_CAP_USD)
    return { ok: false, error: `single deposit limit is $${TIER0_TX_CAP_USD} — verify your passport to raise it` };
  const deposited = await depositedUsd(waNumber);
  if (deposited + usd > TIER0_WINDOW_CAP_USD)
    return { ok: false, error: `30-day deposit limit reached ($${deposited} of $${TIER0_WINDOW_CAP_USD}) — verify your passport to raise it` };
  return { ok: true };
}

export async function limitsFor(waNumber: string) {
  const [spent, deposited] = await Promise.all([spentIdr(waNumber), depositedUsd(waNumber)]);
  return {
    tier: 0,
    tierName: "Simplified CDD",
    spentIdr: spent,
    spendCapIdr: TIER0_WINDOW_CAP_IDR,
    remainingIdr: Math.max(0, TIER0_WINDOW_CAP_IDR - spent),
    depositedUsd: deposited,
    depositCapUsd: TIER0_WINDOW_CAP_USD,
    remainingUsd: Math.max(0, TIER0_WINDOW_CAP_USD - deposited),
    windowDays: 30,
  };
}

/**
 * Sliding-window rate limit, in memory. Single Render instance today; a horizontal
 * scale-out needs this in Postgres or Redis instead.
 */
const hits = new Map<string, number[]>();

export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}
