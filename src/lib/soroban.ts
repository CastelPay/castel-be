import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  Networks,
  rpc,
  scValToNative,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import { createHash, randomBytes } from "node:crypto";

const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
export const soroban = new rpc.Server(RPC_URL);

const NETWORK = Networks.TESTNET;
const STROOPS = 10_000_000n;
const addr = (a: string) => new Address(a).toScVal();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function invoke(contractId: string, method: string, args: xdr.ScVal[], signer: Keypair) {
  for (let attempt = 0; ; attempt++) {
    const account = await soroban.getAccount(signer.publicKey());
    const built = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(60)
      .build();

    const prepared = await soroban.prepareTransaction(built);
    prepared.sign(signer);

    const sent = await soroban.sendTransaction(prepared);
    if (sent.status === "ERROR") {
      if (attempt < 4 && JSON.stringify(sent.errorResult).includes("txBadSeq")) {
        await sleep(2000);
        continue;
      }
      throw new Error("send error: " + JSON.stringify(sent.errorResult));
    }

    let got = await soroban.getTransaction(sent.hash);
    for (let polls = 0; got.status === rpc.Api.GetTransactionStatus.NOT_FOUND && polls < 30; polls++) {
      await sleep(1000);
      got = await soroban.getTransaction(sent.hash);
    }
    if (got.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error("tx failed: " + got.status);
    }
    return { hash: sent.hash, value: got.returnValue ? scValToNative(got.returnValue) : null };
  }
}

export function makePickup() {
  const code = randomBytes(16);
  return { codeHex: code.toString("hex"), hash: createHash("sha256").update(code).digest() };
}

export async function escrowLock(opts: {
  touristKp: Keypair;
  amountCidr: number;
  agentPub: string;
  platformPub: string;
  feeBps: number;
  pickupHash: Buffer;
}) {
  const stroops = BigInt(Math.round(opts.amountCidr)) * STROOPS;
  const args = [
    addr(opts.touristKp.publicKey()),
    addr(process.env.CIDR_SAC!),
    nativeToScVal(stroops, { type: "i128" }),
    addr(opts.agentPub),
    addr(opts.platformPub),
    nativeToScVal(opts.feeBps, { type: "u32" }),
    nativeToScVal(opts.pickupHash, { type: "bytes" }),
  ];
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await invoke(process.env.ESCROW_CONTRACT_ID!, "lock", args, opts.touristKp);
      return { escrowId: Number(res.value), hash: res.hash };
    } catch (e) {
      // Error(Contract, #10) = SAC balance not visible to simulation yet (RPC lag
      // after a just-settled credit like a swap); retry.
      if (attempt < 4 && (e as Error).message.includes("Contract, #10")) {
        await sleep(3000);
        continue;
      }
      throw e;
    }
  }
}

export async function escrowRelease(sourceKp: Keypair, escrowId: number, codeHex: string) {
  const args = [
    nativeToScVal(escrowId, { type: "u64" }),
    nativeToScVal(Buffer.from(codeHex, "hex"), { type: "bytes" }),
  ];
  for (let attempt = 0; ; attempt++) {
    try {
      return await invoke(process.env.ESCROW_CONTRACT_ID!, "release", args, sourceKp);
    } catch (e) {
      // Error(Contract, #1) = escrow not visible yet (RPC lag after lock); retry.
      if (attempt < 4 && (e as Error).message.includes("Contract, #1")) {
        await sleep(3000);
        continue;
      }
      throw e;
    }
  }
}
