import { Keypair, Operation } from "@stellar/stellar-sdk";
import { balanceOf, cIDR, circleUSDC, fundTestnet, horizon, submit, USDC } from "../lib/stellar";

export type Wallet = { publicKey: string; secret: string };

/** Instant: just a keypair. The account does not exist on-chain until it is activated. */
export function newWallet(): Wallet {
  const kp = Keypair.random();
  return { publicKey: kp.publicKey(), secret: kp.secret() };
}

/**
 * The slow part (~15s on testnet): friendbot funds the account, then it opts into cIDR and
 * USDC. Kept off the sign-in path and run lazily, because a new user should get their OTP
 * immediately, not wait for the chain. Idempotent — safe to re-run on an already-active wallet.
 */
export async function activateWallet(secret: string): Promise<void> {
  const kp = Keypair.fromSecret(secret);
  await fundTestnet(kp.publicKey());
  await submit(kp, (b) =>
    b
      .addOperation(Operation.changeTrust({ asset: cIDR() }))
      .addOperation(Operation.changeTrust({ asset: USDC() })),
  );
}

/** Keypair + activation in one call (used by scripts). */
export async function createWallet(): Promise<Wallet> {
  const wallet = newWallet();
  await activateWallet(wallet.secret);
  return wallet;
}

export async function walletBalances(publicKey: string) {
  return {
    cIDR: await balanceOf(publicKey, cIDR()),
    USDC: await balanceOf(publicKey, USDC()),
  };
}

export const circleUsdcBalance = (publicKey: string) => balanceOf(publicKey, circleUSDC());

/** True if the account already opted into Circle USDC. */
export async function hasCircleTrust(publicKey: string): Promise<boolean> {
  const asset = circleUSDC();
  const acc = await horizon.loadAccount(publicKey);
  return acc.balances.some(
    (b: any) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
  );
}

/**
 * Opt the account into Circle USDC so it can receive it — added lazily (only crypto-native
 * users need it). Skips if the trustline already exists.
 */
export async function trustCircleUsdc(secret: string): Promise<void> {
  const kp = Keypair.fromSecret(secret);
  if (await hasCircleTrust(kp.publicKey())) return;
  await submit(kp, (b) => b.addOperation(Operation.changeTrust({ asset: circleUSDC() })));
}
