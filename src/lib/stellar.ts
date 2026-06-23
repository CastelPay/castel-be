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

/** Castel's spread over mid-market, in basis points (50 bps = ~Rp 82 on 16,500). */
export const CASTEL_SPREAD_BPS = 30;
/** Typical money-changer markdown vs mid-market, for the savings comparison. */
export const MONEY_CHANGER_MARKDOWN = 200; // IDR per USD

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

/** Build, sign and submit a classic transaction. */
export async function submit(
  sourceKp: Keypair,
  build: (b: TransactionBuilder) => void,
): Promise<Horizon.HorizonApi.SubmitTransactionResponse> {
  const account = await horizon.loadAccount(sourceKp.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  build(builder);
  const tx = builder.setTimeout(60).build();
  tx.sign(sourceKp);
  try {
    return await horizon.submitTransaction(tx);
  } catch (e: any) {
    const codes = e?.response?.data?.extras?.result_codes;
    if (codes) throw new Error(`tx failed: ${JSON.stringify(codes)}`);
    throw e;
  }
}

export type Balance = { asset: string; balance: string };

/** Read an account's balances as {asset, balance}, asset = "XLM" or "CODE:ISSUER". */
export async function getBalances(publicKey: string): Promise<Balance[]> {
  const acc = await horizon.loadAccount(publicKey);
  return acc.balances.map((b: any) => ({
    asset:
      b.asset_type === "native" ? "XLM" : `${b.asset_code}:${b.asset_issuer}`,
    balance: b.balance,
  }));
}

/** Convenience: balance of a specific Asset for an account (string, "0" if none). */
export async function balanceOf(publicKey: string, asset: Asset): Promise<string> {
  const acc = await horizon.loadAccount(publicKey);
  const found = acc.balances.find(
    (b: any) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
  );
  return found?.balance ?? "0";
}
