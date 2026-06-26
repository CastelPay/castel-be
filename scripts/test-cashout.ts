/**
 * End-to-end cash-out check: tourist locks cIDR into the Soroban escrow,
 * agent releases it with the pickup code (fee split to platform).
 *   bun run scripts/test-cashout.ts
 */
import { Keypair, Operation } from "@stellar/stellar-sdk";
import { balanceOf, cIDR, fundTestnet, submit } from "../src/lib/stellar";
import { escrowLock, escrowRelease, makePickup } from "../src/lib/soroban";
import { createWallet } from "../src/services/custody";

const idr = (n: number | string) => "Rp " + new Intl.NumberFormat("id-ID").format(Math.round(Number(n)));

async function ensureAgent() {
  if (process.env.AGENT_SECRET?.trim()) return Keypair.fromSecret(process.env.AGENT_SECRET.trim());
  const kp = Keypair.random();
  await fundTestnet(kp.publicKey());
  await submit(kp, (b) => b.addOperation(Operation.changeTrust({ asset: cIDR() })));
  console.log("New agent — add to .env:");
  console.log("AGENT_PUBLIC=" + kp.publicKey());
  console.log("AGENT_SECRET=" + kp.secret() + "\n");
  return kp;
}

async function main() {
  const treasury = Keypair.fromSecret(process.env.TREASURY_SECRET!);
  const distributor = Keypair.fromSecret(process.env.DISTRIBUTOR_SECRET!);
  const agent = await ensureAgent();

  console.log("👤 Creating tourist + funding 1,000,000 cIDR...");
  const tourist = await createWallet();
  const touristKp = Keypair.fromSecret(tourist.secret);
  await submit(distributor, (b) =>
    b.addOperation(Operation.payment({ destination: tourist.publicKey, asset: cIDR(), amount: "1000000" })),
  );
  console.log("   tourist cIDR:", await balanceOf(tourist.publicKey, cIDR()));

  const pickup = makePickup();
  console.log("\n🔒 Locking 500,000 cIDR into escrow (1% fee)...");
  const { escrowId } = await escrowLock({
    touristKp,
    amountCidr: 500000,
    agentPub: agent.publicKey(),
    platformPub: treasury.publicKey(),
    feeBps: 100,
    pickupHash: pickup.hash,
  });
  console.log("   escrowId:", escrowId, "| pickup code:", pickup.codeHex);
  console.log("   tourist cIDR after lock:", await balanceOf(tourist.publicKey, cIDR()));

  console.log("\n⏳ waiting for ledger to settle...");
  await new Promise((r) => setTimeout(r, 8000));

  console.log("🏦 Agent scans pickup code → release...");
  const before = Number(await balanceOf(agent.publicKey(), cIDR()));
  const platformBefore = Number(await balanceOf(treasury.publicKey(), cIDR()));
  await escrowRelease(treasury, escrowId, pickup.codeHex);
  const agentGot = Number(await balanceOf(agent.publicKey(), cIDR())) - before;
  const platformGot = Number(await balanceOf(treasury.publicKey(), cIDR())) - platformBefore;

  console.log("   agent received :", idr(agentGot), "(expected Rp 495.000)");
  console.log("   platform fee   :", idr(platformGot), "(expected Rp 5.000)");
  console.log("\n✅ Cash-out escrow works on-chain.");
}

main().catch((e) => {
  console.error("\n❌", e?.message ?? e);
  process.exit(1);
});
