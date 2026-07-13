/**
 * Put Stellar's native compliance primitives on the cIDR issuer.
 *
 *   bun run scripts/harden-issuer.ts
 *
 * AUTH_REVOCABLE lets the issuer freeze a compromised trustline; AUTH_CLAWBACK_ENABLED
 * lets it reverse a fraudulent transfer. A rupiah-pegged asset needs both, and Stellar
 * gives them at the protocol level — no token contract required.
 *
 * AUTH_REQUIRED is deliberately NOT set: it would land every new wallet's trustline
 * unauthorized and break path payments until an approval server (SEP-8) exists.
 *
 * Also points home_domain at the stellar.toml, which is what makes the asset
 * discoverable under SEP-1.
 *
 * NOTE: clawback is not retroactive. Trustlines created before this runs stay
 * non-clawbackable forever.
 */
import {
  AuthClawbackEnabledFlag,
  AuthRevocableFlag,
  Keypair,
  Operation,
} from "@stellar/stellar-sdk";
import { horizon, submit } from "../src/lib/stellar";

const HOME_DOMAIN = "castelpay.vercel.app";

async function main() {
  const issuer = Keypair.fromSecret(process.env.CIDR_ISSUER_SECRET!);
  console.log("🔐 Hardening cIDR issuer", issuer.publicKey(), "\n");

  const before = await horizon.loadAccount(issuer.publicKey());
  console.log("before:", before.flags, "home_domain:", (before as any).home_domain ?? "(none)");

  await submit(issuer, (b) =>
    b.addOperation(
      Operation.setOptions({
        setFlags: (AuthRevocableFlag | AuthClawbackEnabledFlag) as any,
        homeDomain: HOME_DOMAIN,
      }),
    ),
  );

  const after = await horizon.loadAccount(issuer.publicKey());
  console.log("after: ", after.flags, "home_domain:", (after as any).home_domain);

  const ok = after.flags.auth_revocable && after.flags.auth_clawback_enabled;
  console.log(ok ? "\n✅ auth_revocable + auth_clawback_enabled set" : "\n❌ flags not set");
  console.log(`🔭 https://stellar.expert/explorer/testnet/account/${issuer.publicKey()}`);
}

main().catch((e) => {
  console.error("\n❌ Failed:", e?.message ?? e);
  process.exit(1);
});
