import { Asset, Keypair, Operation } from "@stellar/stellar-sdk";
import { cIDR, horizon, submit, USDC } from "../lib/stellar";
import { type Mid, MONEY_CHANGER_MARKDOWN, usdIdrMid } from "../lib/rates";

/** How far the executed rate may drift from the quote before we abandon the swap. */
const SLIPPAGE_BPS = 100;

type Hop = { asset_type: string; asset_code?: string; asset_issuer?: string };

export type Quote = {
  usdc: number;
  cidrOut: number;
  rate: number;
  midRate: number;
  midSource: Mid["source"];
  changerRate: number;
  changerCidr: number;
  savingsIdr: number;
  path: Hop[];
};

export function buildQuote(usdc: number, cidrOut: number, mid: Mid, path: Hop[] = []): Quote {
  const changerRate = mid.rate - MONEY_CHANGER_MARKDOWN;
  const changerCidr = usdc * changerRate;
  return {
    usdc,
    cidrOut,
    rate: cidrOut / usdc,
    midRate: mid.rate,
    midSource: mid.source,
    changerRate,
    changerCidr,
    savingsIdr: cidrOut - changerCidr,
    path,
  };
}

export async function quoteUsdcToCidr(usdc: number): Promise<Quote> {
  // The executed rate comes from the order book. The reference rate only says what the
  // wider market thinks a dollar is worth, so the money-changer comparison means something.
  const [paths, mid] = await Promise.all([
    horizon.strictSendPaths(USDC(), usdc.toFixed(7), [cIDR()]).call(),
    usdIdrMid(),
  ]);

  const best = paths.records[0];
  if (!best) throw new Error("no path USDC->cIDR (is the market seeded?)");

  return buildQuote(usdc, Number(best.destination_amount), mid, best.path as Hop[]);
}

const toAsset = (h: Hop) =>
  h.asset_type === "native" ? Asset.native() : new Asset(h.asset_code!, h.asset_issuer!);

/**
 * destMin is a slippage bound derived from a live quote, not a fixed price floor.
 * A hardcoded floor silently tolerates every cent of drift above it, and protects
 * nothing at all once the market trades higher.
 */
export async function swapUsdcToCidr(userKp: Keypair, usdc: number) {
  const quote = await quoteUsdcToCidr(usdc);
  const destMin = ((quote.cidrOut * (10000 - SLIPPAGE_BPS)) / 10000).toFixed(7);

  const res = await submit(userKp, (b) =>
    b.addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: USDC(),
        sendAmount: usdc.toFixed(7),
        destination: userKp.publicKey(),
        destAsset: cIDR(),
        destMin,
        path: quote.path.map(toAsset),
      }),
    ),
  );
  return { hash: res.hash, quote };
}
