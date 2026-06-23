/**
 * End-to-end check: onboard a tourist, fund with USDC, swap to cIDR.
 *   bun run scripts/test-flow.ts
 */
import { Keypair, Operation } from "@stellar/stellar-sdk";
import { submit, USDC } from "../src/lib/stellar";
import { createWallet, walletBalances } from "../src/services/custody";
import { quoteUsdcToCidr, swapUsdcToCidr } from "../src/services/fx";

const rupiah = (n: number) => "Rp " + Math.round(n).toLocaleString("id-ID");

async function main() {
  console.log("👤 Onboarding tourist (creating custodial wallet)...");
  const tourist = await createWallet();
  console.log("   ", tourist.publicKey);

  console.log("\n💵 Treasury funds tourist with 200 USDC...");
  const treasury = Keypair.fromSecret(process.env.TREASURY_SECRET!);
  await submit(treasury, (b) =>
    b.addOperation(
      Operation.payment({ destination: tourist.publicKey, asset: USDC(), amount: "200" }),
    ),
  );
  console.log("   before:", await walletBalances(tourist.publicKey));

  console.log("\n📊 Quote for 200 USDC -> cIDR:");
  const q = await quoteUsdcToCidr(200);
  console.log(`    Castel rate : ${q.rate.toFixed(0)} cIDR/USDC -> ${rupiah(q.cidrOut)}`);
  console.log(`    Changer rate: ${q.changerRate} cIDR/USDC -> ${rupiah(q.changerCidr)}`);
  console.log(`    💰 Savings  : ${rupiah(q.savingsIdr)}`);

  console.log("\n🔄 Swapping via path payment...");
  const hash = await swapUsdcToCidr(Keypair.fromSecret(tourist.secret), 200);
  console.log("    tx:", hash.slice(0, 16) + "…");

  console.log("\n✅ after:", await walletBalances(tourist.publicKey));
}

main().catch((e) => {
  console.error("\n❌ Failed:", e?.message ?? e);
  process.exit(1);
});
