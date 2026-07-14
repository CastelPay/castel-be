/**
 * Re-price the USDC <-> cIDR order book against the live USD/IDR reference rate.
 *
 *   bun run scripts/refresh-market.ts
 *
 * Stellar has no peg mechanism: a swap executes at whatever the order book says. So the
 * rate only tracks reality if a market maker keeps re-posting. That is this script — the
 * off-chain half of the anchor. Run it on a schedule; the on-chain half is just two offers.
 *
 * (An on-chain oracle would only be needed if a *contract* had to read the price. Path
 * payments read the order book, so the price feed belongs here, off-chain.)
 */
import { Asset, Keypair, Operation } from "@stellar/stellar-sdk";
import { cIDR, horizon, submit, USDC } from "../src/lib/stellar";
import { usdIdrMid } from "../src/lib/rates";

/** Castel's margin, applied either side of mid. This is the revenue line. */
const SPREAD_BPS = 30;

const CIDR_DEPTH = "50000000";
const USDC_DEPTH = "3000";

type Offer = { id: string; selling: { asset_code?: string; asset_type: string } };

async function offersOf(publicKey: string): Promise<Offer[]> {
  const { records } = await horizon.offers().forAccount(publicKey).limit(200).call();
  return records as unknown as Offer[];
}

const idOfSeller = (offers: Offer[], code: string) =>
  offers.find((o) => o.selling.asset_code === code)?.id;

async function main() {
  const distributor = Keypair.fromSecret(process.env.DISTRIBUTOR_SECRET!);

  const mid = await usdIdrMid();
  const ask = Math.round((mid.rate * (10_000 - SPREAD_BPS)) / 10_000);
  const bid = Math.round((mid.rate * (10_000 + SPREAD_BPS)) / 10_000);

  console.log(`📈 USD/IDR mid ${mid.rate.toFixed(2)} (${mid.source})`);
  console.log(`   ask ${ask} (tourist funds at this) / bid ${bid} — spread ${SPREAD_BPS} bps\n`);

  if (ask >= bid) throw new Error("ask must stay below bid, or the offers cross (op_cross_self)");

  const c = cIDR();
  const u = USDC();
  const existing = await offersOf(distributor.publicKey());
  const cidrOfferId = idOfSeller(existing, c.getCode());
  const usdcOfferId = idOfSeller(existing, u.getCode());

  console.log(existing.length ? `Replacing ${existing.length} live offer(s)…` : "Creating offers…");

  // Both sides must come down before either goes back up. Re-pricing one side in place
  // makes it cross the other side's stale price — and since both belong to the
  // distributor, Stellar rejects the whole transaction with op_cross_self.
  await submit(distributor, (b) => {
    if (cidrOfferId)
      b.addOperation(
        Operation.manageSellOffer({
          selling: c,
          buying: u,
          amount: "0",
          price: { n: 1, d: ask },
          offerId: cidrOfferId,
        }),
      );
    if (usdcOfferId)
      b.addOperation(
        Operation.manageSellOffer({
          selling: u,
          buying: c,
          amount: "0",
          price: { n: bid, d: 1 },
          offerId: usdcOfferId,
        }),
      );

    b.addOperation(
      Operation.manageSellOffer({
        selling: c,
        buying: u,
        amount: CIDR_DEPTH,
        price: { n: 1, d: ask },
      }),
    ).addOperation(
      Operation.manageSellOffer({
        selling: u,
        buying: c,
        amount: USDC_DEPTH,
        price: { n: bid, d: 1 },
      }),
    );
  });

  const after = await offersOf(distributor.publicKey());
  console.log(`\n✅ market re-priced — ${after.length} offers live`);
  console.log(`🔭 https://stellar.expert/explorer/testnet/account/${distributor.publicKey()}`);
}

main().catch((e) => {
  console.error("\n❌ Failed:", e?.message ?? e);
  process.exit(1);
});
