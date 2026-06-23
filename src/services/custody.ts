import { Keypair, Operation } from "@stellar/stellar-sdk";
import { balanceOf, cIDR, fundTestnet, submit, USDC } from "../lib/stellar";

export type Wallet = { publicKey: string; secret: string };

export async function createWallet(): Promise<Wallet> {
  const kp = Keypair.random();
  await fundTestnet(kp.publicKey());
  await submit(kp, (b) =>
    b
      .addOperation(Operation.changeTrust({ asset: cIDR() }))
      .addOperation(Operation.changeTrust({ asset: USDC() })),
  );
  return { publicKey: kp.publicKey(), secret: kp.secret() };
}

export async function walletBalances(publicKey: string) {
  return {
    cIDR: await balanceOf(publicKey, cIDR()),
    USDC: await balanceOf(publicKey, USDC()),
  };
}
