import { Keypair, Operation } from "@stellar/stellar-sdk";
import { cIDR, horizon, MONEY_CHANGER_MARKDOWN, submit, USDC } from "../lib/stellar";

const MID_RATE = 16500;

export type Quote = {
  usdc: number;
  cidrOut: number;
  rate: number;
  changerRate: number;
  changerCidr: number;
  savingsIdr: number;
};

export async function quoteUsdcToCidr(usdc: number): Promise<Quote> {
  const paths = await horizon
    .strictSendPaths(USDC(), usdc.toFixed(7), [cIDR()])
    .call();
  const best = paths.records[0];
  if (!best) throw new Error("no path USDC->cIDR (is the market seeded?)");

  const cidrOut = Number(best.destination_amount);
  const changerRate = MID_RATE - MONEY_CHANGER_MARKDOWN;
  const changerCidr = usdc * changerRate;
  return {
    usdc,
    cidrOut,
    rate: cidrOut / usdc,
    changerRate,
    changerCidr,
    savingsIdr: cidrOut - changerCidr,
  };
}

export async function swapUsdcToCidr(userKp: Keypair, usdc: number, minRate = 16000) {
  const destMin = (usdc * minRate).toFixed(7);
  const res = await submit(userKp, (b) =>
    b.addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: USDC(),
        sendAmount: usdc.toFixed(7),
        destination: userKp.publicKey(),
        destAsset: cIDR(),
        destMin,
        path: [],
      }),
    ),
  );
  return res.hash;
}
