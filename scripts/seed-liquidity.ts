/**
 * Seed a USDC <-> cIDR market on testnet so path-payment FX works.
 *   bun run scripts/seed-liquidity.ts
 * Prints USDC_ISSUER / USDC_ISSUER_SECRET to paste into castel-be/.env.
 */
import { Asset, Keypair, Operation } from "@stellar/stellar-sdk";
import { fundTestnet, submit, horizon } from "../src/lib/stellar";

import { usdIdrMid } from "../src/lib/rates";

/** Castel's margin, applied either side of the live mid. */
const SPREAD_BPS = 30;

async function trustIfNeeded(kp: Keypair, asset: Asset, label: string) {
  const acc = await horizon.loadAccount(kp.publicKey());
  const has = acc.balances.some(
    (b: any) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
  );
  if (has) return;
  await submit(kp, (b) => b.addOperation(Operation.changeTrust({ asset })));
  console.log(`  ✓ ${label} trusts ${asset.getCode()}`);
}

async function main() {
  console.log("💧 Seeding USDC <-> cIDR market on testnet\n");

  // Prices track the live USD/IDR mid — a hardcoded rate is wrong the moment it is written.
  const mid = await usdIdrMid();
  const MID = mid.rate;
  const ASK = Math.round((MID * (10_000 - SPREAD_BPS)) / 10_000);
  const BID = Math.round((MID * (10_000 + SPREAD_BPS)) / 10_000);
  console.log(`📈 USD/IDR mid ${MID.toFixed(2)} (${mid.source}) → ask ${ASK} / bid ${BID}\n`);

  const distributor = Keypair.fromSecret(process.env.DISTRIBUTOR_SECRET!);
  const treasury = Keypair.fromSecret(process.env.TREASURY_SECRET!);

  const usdcIssuer = process.env.USDC_ISSUER_SECRET?.trim()
    ? Keypair.fromSecret(process.env.USDC_ISSUER_SECRET.trim())
    : Keypair.random();
  console.log("USDC issuer:", usdcIssuer.publicKey());
  await fundTestnet(usdcIssuer.publicKey());

  const USDC = new Asset("USDC", usdcIssuer.publicKey());
  const cIDR = new Asset(
    process.env.CIDR_ASSET_CODE ?? "cIDR",
    process.env.CIDR_ISSUER_PUBLIC!,
  );

  await trustIfNeeded(distributor, USDC, "distributor");
  await trustIfNeeded(treasury, USDC, "treasury");

  await submit(usdcIssuer, (b) =>
    b.addOperation(
      Operation.payment({ destination: distributor.publicKey(), asset: USDC, amount: "100000" }),
    ),
  );
  await submit(usdcIssuer, (b) =>
    b.addOperation(
      Operation.payment({ destination: treasury.publicKey(), asset: USDC, amount: "50000" }),
    ),
  );
  console.log("  ✓ minted USDC to distributor + treasury");

  await submit(distributor, (b) =>
    b
      .addOperation(
        Operation.manageSellOffer({
          selling: cIDR,
          buying: USDC,
          amount: "50000000",
          price: { n: 1, d: ASK },
        }),
      )
      .addOperation(
        Operation.manageSellOffer({
          selling: USDC,
          buying: cIDR,
          amount: "3000",
          price: { n: BID, d: 1 },
        }),
      ),
  );
  console.log(`  ✓ two-sided market live (ask ${ASK} / bid ${BID}, mid ${MID.toFixed(0)})`);
  console.log("  → re-run scripts/refresh-market.ts on a schedule to track the rate");

  console.log("\n--- add to castel-be/.env ---");
  console.log(`USDC_ISSUER=${usdcIssuer.publicKey()}`);
  console.log(`USDC_ISSUER_SECRET=${usdcIssuer.secret()}`);
}

main().catch((e) => {
  console.error("\n❌ Failed:", e?.message ?? e);
  process.exit(1);
});
