import { Asset, Keypair, Operation } from "@stellar/stellar-sdk";
import { cIDR, horizon, MONEY_CHANGER_MARKDOWN, submit, USDC } from "../lib/stellar";

const MID_RATE = 16500;

/** How far the executed rate may drift from the quote before we abandon the swap. */
const SLIPPAGE_BPS = 100;

type Hop = { asset_type: string; asset_code?: string; asset_issuer?: string };

export type Quote = {
  usdc: number;
  cidrOut: number;
  rate: number;
  changerRate: number;
  changerCidr: number;
  savingsIdr: number;
  path: Hop[];
};

export function buildQuote(usdc: number, cidrOut: number, path: Hop[] = []): Quote {
  const changerRate = MID_RATE - MONEY_CHANGER_MARKDOWN;
  const changerCidr = usdc * changerRate;
  return {
    usdc,
    cidrOut,
    rate: cidrOut / usdc,
    changerRate,
    changerCidr,
    savingsIdr: cidrOut - changerCidr,
    path,
  };
}

export async function quoteUsdcToCidr(usdc: number): Promise<Quote> {
  const paths = await horizon.strictSendPaths(USDC(), usdc.toFixed(7), [cIDR()]).call();
  const best = paths.records[0];
  if (!best) throw new Error("no path USDC->cIDR (is the market seeded?)");
  return buildQuote(usdc, Number(best.destination_amount), best.path as Hop[]);
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
