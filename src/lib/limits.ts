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
export const WINDOW_MS = 30 * 24 * 60 * 60_000;

// A "hold" is written when a Checkout session is created but not yet paid, so the limit counts
// in-flight sessions and a user can't dodge the cap by opening many tabs at once. It counts for
// only this long — an unconfirmed session past this is treated as abandoned (Stripe also expires
// it), and the hold row is deleted the moment the session is confirmed.
const HOLD_TTL_MS = 60 * 60_000;
export const HOLD_DEPOSIT = "hold_deposit";
export const HOLD_SPEND = "hold_spend";
export const HOLD_TYPES = [HOLD_DEPOSIT, HOLD_SPEND];

/** Every amount in the ledger is rupiah — deposits are converted before they are recorded. */
async function sumSince(waNumber: string, types: string[], windowMs = WINDOW_MS): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${transactions.amountIdr}), 0)::bigint` })
    .from(transactions)
    .where(
      and(
        eq(transactions.waNumber, waNumber),
        inArray(transactions.type, types),
        gt(transactions.createdAt, Date.now() - windowMs),
      ),
    );
  return Number(row?.total ?? 0);
}

// "quickpay" is a merchant payment funded by a card per-bill; it counts toward the spend window
// exactly like "pay", or the 30-day aggregation cap could be bypassed via that rail. Recent
// unpaid holds count too, so parallel Checkout sessions can't collectively exceed the cap.
export const spentIdr = async (waNumber: string) =>
  (await sumSince(waNumber, ["pay", "cashout", "quickpay"])) +
  (await sumSince(waNumber, [HOLD_SPEND], HOLD_TTL_MS));
export const depositedIdr = async (waNumber: string) =>
  (await sumSince(waNumber, ["deposit"])) + (await sumSince(waNumber, [HOLD_DEPOSIT], HOLD_TTL_MS));

const rupiah = (n: number) => `Rp ${Math.round(n).toLocaleString("id-ID")}`;

export type LimitCheck = { ok: true } | { ok: false; error: string };

async function check(waNumber: string, amountIdr: number, used: () => Promise<number>, what: string) {
  if (amountIdr > TIER0_TX_CAP_IDR)
    return {
      ok: false as const,
      error: `single ${what} limit is ${rupiah(TIER0_TX_CAP_IDR)} — verify your passport to raise it`,
    };
  const already = await used();
  if (already + amountIdr > TIER0_WINDOW_CAP_IDR)
    return {
      ok: false as const,
      error: `30-day ${what} limit reached (${rupiah(already)} of ${rupiah(TIER0_WINDOW_CAP_IDR)}) — verify your passport to raise it`,
    };
  return { ok: true as const };
}

export const checkSpendLimit = (wa: string, amountIdr: number): Promise<LimitCheck> =>
  check(wa, amountIdr, () => spentIdr(wa), "transaction");

export const checkDepositLimit = (wa: string, amountIdr: number): Promise<LimitCheck> =>
  check(wa, amountIdr, () => depositedIdr(wa), "top-up");

export async function limitsFor(waNumber: string) {
  const [spent, deposited] = await Promise.all([spentIdr(waNumber), depositedIdr(waNumber)]);
  return {
    tier: 0,
    tierName: "Simplified CDD",
    spentIdr: spent,
    spendCapIdr: TIER0_WINDOW_CAP_IDR,
    remainingIdr: Math.max(0, TIER0_WINDOW_CAP_IDR - spent),
    depositedIdr: deposited,
    depositCapIdr: TIER0_WINDOW_CAP_IDR,
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
