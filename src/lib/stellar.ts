/**
 * Shared Stellar config + helpers for Castel backend.
 */
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";

export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const HORIZON_URL = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
export const horizon = new Horizon.Server(HORIZON_URL);

function envAsset(codeKey: string, issuerKey: string, defCode: string): Asset {
  const code = process.env[codeKey] ?? defCode;
  const issuer = process.env[issuerKey];
  if (!issuer) throw new Error(`Missing ${issuerKey} in environment (.env)`);
  return new Asset(code, issuer);
}

export const cIDR = (): Asset => envAsset("CIDR_ASSET_CODE", "CIDR_ISSUER_PUBLIC", "cIDR");
export const USDC = (): Asset => envAsset("USDC_ASSET_CODE", "USDC_ISSUER", "USDC");

/** Fund a testnet account from Friendbot (idempotent-ish). */
export async function fundTestnet(publicKey: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${publicKey}`);
  if (!res.ok && res.status !== 400) {
    throw new Error(`Friendbot failed (${res.status}) for ${publicKey}`);
  }
}

/**
 * BASE_FEE is the network minimum — bidding it means the first fee surge strands
 * every deposit and payout. The fee field is a max bid, so headroom costs nothing
 * when the network is quiet.
 */
const FEE = String(Number(BASE_FEE) * 100);

/**
 * One key (the treasury) signs every deposit and payout, and a Stellar account has
 * a single sequence number. Two concurrent submissions would both read sequence N,
 * both build N+1, and one would die with tx_bad_seq — a paid-for Stripe deposit
 * that never credits. Serialise per source key, and re-read the sequence on retry.
 */
const chains = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  chains.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

async function submitOnce(
  sourceKp: Keypair,
  build: (b: TransactionBuilder) => void,
): Promise<Horizon.HorizonApi.SubmitTransactionResponse> {
  const account = await horizon.loadAccount(sourceKp.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  build(builder);
  const tx = builder.setTimeout(60).build();
  tx.sign(sourceKp);

  try {
    return await horizon.submitTransaction(tx);
  } catch (e: any) {
    const codes = e?.response?.data?.extras?.result_codes;
    if (codes?.transaction === "tx_bad_seq") {
      const err = new Error("tx_bad_seq");
      (err as any).retryable = true;
      throw err;
    }
    if (codes) throw new Error(`tx failed: ${JSON.stringify(codes)}`);
    throw e;
  }
}

/** Build, sign and submit a classic transaction. */
export function submit(
  sourceKp: Keypair,
  build: (b: TransactionBuilder) => void,
): Promise<Horizon.HorizonApi.SubmitTransactionResponse> {
  return serialize(sourceKp.publicKey(), async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await submitOnce(sourceKp, build);
      } catch (e: any) {
        if (!e?.retryable || attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  });
}

/** Balance of a specific Asset for an account (string, "0" if none). */
export async function balanceOf(publicKey: string, asset: Asset): Promise<string> {
  const acc = await horizon.loadAccount(publicKey);
  const found = acc.balances.find(
    (b: any) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
  );
  return found?.balance ?? "0";
}
