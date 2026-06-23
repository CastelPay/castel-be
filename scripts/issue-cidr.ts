/**
 * Issue the cIDR stablecoin on Stellar testnet.
 *
 *   bun run scripts/issue-cidr.ts
 *
 * Idempotent-ish: if issuer/distributor/treasury secrets are already in the
 * environment (.env), they're reused; otherwise fresh keypairs are generated
 * and printed at the end so you can paste them into castel-be/.env.
 *
 * Steps: generate keys -> fund via Friendbot -> distributor & treasury trust
 * cIDR -> issuer mints cIDR to distributor. The FX swap (USDC<->cIDR) comes
 * later via path payments; this script just brings cIDR into existence.
 */
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const HORIZON_URL = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const ASSET_CODE = process.env.CIDR_ASSET_CODE ?? "cIDR";
const MINT_AMOUNT = "1000000000"; // 1,000,000,000 cIDR (Rp 1B) for testnet liquidity

const server = new Horizon.Server(HORIZON_URL);

function getOrCreate(label: string, secret?: string): { kp: Keypair; fresh: boolean } {
  if (secret && secret.trim()) {
    return { kp: Keypair.fromSecret(secret.trim()), fresh: false };
  }
  return { kp: Keypair.random(), fresh: true };
}

async function fundIfNeeded(kp: Keypair, label: string) {
  try {
    await server.loadAccount(kp.publicKey());
    console.log(`  • ${label} already funded (${kp.publicKey()})`);
  } catch {
    console.log(`  • funding ${label} via Friendbot...`);
    const res = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
    if (!res.ok) throw new Error(`Friendbot failed for ${label}: ${res.status}`);
    console.log(`    funded ${kp.publicKey()}`);
  }
}

async function submit(label: string, sourceKp: Keypair, buildOps: (tx: TransactionBuilder) => void) {
  const account = await server.loadAccount(sourceKp.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  });
  buildOps(builder);
  const tx = builder.setTimeout(60).build();
  tx.sign(sourceKp);
  try {
    const res = await server.submitTransaction(tx);
    console.log(`  ✓ ${label} (${res.hash.slice(0, 12)}…)`);
  } catch (e: any) {
    const codes = e?.response?.data?.extras?.result_codes;
    if (codes) console.error(`  ✗ ${label}:`, JSON.stringify(codes));
    throw e;
  }
}

async function main() {
  console.log("🪙  Issuing cIDR on Stellar testnet\n");

  const issuer = getOrCreate("issuer", process.env.CIDR_ISSUER_SECRET);
  const distributor = getOrCreate("distributor", process.env.DISTRIBUTOR_SECRET);
  const treasury = getOrCreate("treasury", process.env.TREASURY_SECRET);

  console.log("Accounts:");
  console.log(`  issuer      ${issuer.kp.publicKey()}`);
  console.log(`  distributor ${distributor.kp.publicKey()}`);
  console.log(`  treasury    ${treasury.kp.publicKey()}\n`);

  console.log("Funding:");
  await fundIfNeeded(issuer.kp, "issuer");
  await fundIfNeeded(distributor.kp, "distributor");
  await fundIfNeeded(treasury.kp, "treasury");

  const cIDR = new Asset(ASSET_CODE, issuer.kp.publicKey());

  console.log("\nTrustlines (distributor + treasury trust cIDR):");
  await submit("distributor trusts cIDR", distributor.kp, (b) =>
    b.addOperation(Operation.changeTrust({ asset: cIDR })),
  );
  await submit("treasury trusts cIDR", treasury.kp, (b) =>
    b.addOperation(Operation.changeTrust({ asset: cIDR })),
  );

  console.log("\nMint (issuer -> distributor):");
  await submit(`mint ${MINT_AMOUNT} cIDR`, issuer.kp, (b) =>
    b.addOperation(
      Operation.payment({
        destination: distributor.kp.publicKey(),
        asset: cIDR,
        amount: MINT_AMOUNT,
      }),
    ),
  );

  // Verify balance
  const distAcc = await server.loadAccount(distributor.kp.publicKey());
  const bal = distAcc.balances.find(
    (x: any) => x.asset_code === ASSET_CODE && x.asset_issuer === issuer.kp.publicKey(),
  );
  console.log(`\n✅ Done. Distributor cIDR balance: ${bal?.balance ?? "0"}`);

  console.log("\n--- paste into castel-be/.env ---");
  console.log(`CIDR_ASSET_CODE=${ASSET_CODE}`);
  console.log(`CIDR_ISSUER_PUBLIC=${issuer.kp.publicKey()}`);
  console.log(`CIDR_ISSUER_SECRET=${issuer.kp.secret()}`);
  console.log(`DISTRIBUTOR_PUBLIC=${distributor.kp.publicKey()}`);
  console.log(`DISTRIBUTOR_SECRET=${distributor.kp.secret()}`);
  console.log(`TREASURY_PUBLIC=${treasury.kp.publicKey()}`);
  console.log(`TREASURY_SECRET=${treasury.kp.secret()}`);
  console.log(`\n🔭 Inspect: https://stellar.expert/explorer/testnet/asset/${ASSET_CODE}-${issuer.kp.publicKey()}`);
}

main().catch((e) => {
  console.error("\n❌ Failed:", e?.message ?? e);
  process.exit(1);
});
