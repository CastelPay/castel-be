/**
 * Give the treasury a trustline to Circle's testnet USDC so it can receive the reserve swept
 * from crypto deposits.
 *
 *   bun run scripts/trust-circle-usdc.ts
 */
import { Keypair, Operation } from "@stellar/stellar-sdk";
import { circleUSDC, horizon, submit } from "../src/lib/stellar";

async function main() {
  const treasury = Keypair.fromSecret(process.env.TREASURY_SECRET!);
  const asset = circleUSDC();
  console.log("🔗 Trustlining Circle USDC on treasury", treasury.publicKey());
  console.log("   asset:", asset.getCode(), asset.getIssuer());

  const acc = await horizon.loadAccount(treasury.publicKey());
  const has = acc.balances.some(
    (b: any) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
  );
  if (has) {
    console.log("   ✓ already trustlined");
    return;
  }
  await submit(treasury, (b) => b.addOperation(Operation.changeTrust({ asset })));
  console.log("   ✅ trustline added");
}

main().catch((e) => {
  console.error("❌ Failed:", e?.message ?? e);
  process.exit(1);
});
