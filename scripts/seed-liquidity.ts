/**
 * Seed a USDC <-> cIDR market on testnet so path-payment FX works.
 *   bun run scripts/seed-liquidity.ts
 * Prints USDC_ISSUER / USDC_ISSUER_SECRET to paste into castel-be/.env.
 */
import { Asset, Keypair, Operation } from "@stellar/stellar-sdk";
import { fundTestnet, submit, horizon } from "../src/lib/stellar";

const MID = 16500;
const ASK = 16450; // cIDR per USDC a tourist receives when funding (USDC -> cIDR)
const BID = 16550; // cIDR per USDC required when cashing out (cIDR -> USDC)

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
  console.log(`  ✓ two-sided market live (ask ${ASK} / bid ${BID}, mid ${MID})`);

  console.log("\n--- add to castel-be/.env ---");
  console.log(`USDC_ISSUER=${usdcIssuer.publicKey()}`);
  console.log(`USDC_ISSUER_SECRET=${usdcIssuer.secret()}`);
}

main().catch((e) => {
  console.error("\n❌ Failed:", e?.message ?? e);
  process.exit(1);
});
