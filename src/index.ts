import { Keypair, Operation } from "@stellar/stellar-sdk";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "./db";
import { cIDR, submit, USDC } from "./lib/stellar";
import { parseQris } from "./lib/qris";
import { escrowLock, escrowRelease, makePickup } from "./lib/soroban";
import { cashouts, transactions, users } from "./db/schema";
import { createWallet, walletBalances } from "./services/custody";
import { quoteUsdcToCidr, swapUsdcToCidr } from "./services/fx";

const app = new Hono();

app.use("*", cors());

const findUser = async (waNumber: string) =>
  (await db.select().from(users).where(eq(users.waNumber, waNumber)))[0];

const recordTx = (
  waNumber: string,
  type: string,
  title: string,
  amountIdr: number,
  direction: "in" | "out",
  hash?: string,
) =>
  db.insert(transactions).values({
    waNumber,
    type,
    title,
    amountIdr: Math.round(amountIdr),
    direction,
    hash: hash ?? null,
    createdAt: Date.now(),
  });

app.get("/", (c) => c.json({ ok: true, service: "castel-be" }));

app.post("/onboard", async (c) => {
  const { waNumber } = await c.req.json();
  if (!waNumber) return c.json({ error: "waNumber required" }, 400);
  let user = await findUser(waNumber);
  if (!user) {
    const wallet = await createWallet();
    await db.insert(users).values({
      waNumber,
      publicKey: wallet.publicKey,
      secret: wallet.secret,
      createdAt: Date.now(),
    });
    user = await findUser(waNumber);
  }
  return c.json({ waNumber, publicKey: user!.publicKey });
});

app.get("/balance/:waNumber", async (c) => {
  const user = await findUser(c.req.param("waNumber"));
  if (!user) return c.json({ error: "not found" }, 404);
  return c.json(await walletBalances(user.publicKey));
});

app.get("/fx/quote", async (c) => {
  const usdc = Number(c.req.query("usdc") ?? "0");
  if (!usdc) return c.json({ error: "usdc query param required" }, 400);
  return c.json(await quoteUsdcToCidr(usdc));
});

app.post("/fund", async (c) => {
  const { waNumber, usdc } = await c.req.json();
  const user = await findUser(waNumber);
  if (!user) return c.json({ error: "not found" }, 404);
  const treasury = Keypair.fromSecret(process.env.TREASURY_SECRET!);
  await submit(treasury, (b) =>
    b.addOperation(
      Operation.payment({ destination: user.publicKey, asset: USDC(), amount: String(usdc) }),
    ),
  );
  return c.json(await walletBalances(user.publicKey));
});

app.post("/fx/swap", async (c) => {
  const { waNumber, usdc } = await c.req.json();
  const user = await findUser(waNumber);
  if (!user) return c.json({ error: "not found" }, 404);
  const before = Number((await walletBalances(user.publicKey)).cIDR);
  const hash = await swapUsdcToCidr(Keypair.fromSecret(user.secret), Number(usdc));
  const balances = await walletBalances(user.publicKey);
  const received = Number(balances.cIDR) - before;
  await recordTx(waNumber, "swap", `Exchanged ${usdc} USDC`, received, "in", hash);
  return c.json({ hash, balances });
});

app.post("/qris/decode", async (c) => {
  const { payload } = await c.req.json();
  if (!payload) return c.json({ error: "payload required" }, 400);
  return c.json(parseQris(payload));
});

app.post("/pay", async (c) => {
  const { waNumber, payload, amount } = await c.req.json();
  const user = await findUser(waNumber);
  if (!user) return c.json({ error: "not found" }, 404);

  const info = parseQris(payload);
  const amountIdr = info.amount ?? Number(amount);
  if (!amountIdr || amountIdr <= 0) return c.json({ error: "amount required" }, 400);

  const userKp = Keypair.fromSecret(user.secret);
  const res = await submit(userKp, (b) =>
    b.addOperation(
      Operation.payment({
        destination: process.env.TREASURY_PUBLIC!,
        asset: cIDR(),
        amount: amountIdr.toFixed(7),
      }),
    ),
  );

  await recordTx(waNumber, "pay", info.merchantName, amountIdr, "out", res.hash);

  return c.json({
    merchant: info.merchantName,
    city: info.city,
    amountIdr,
    hash: res.hash,
    balances: await walletBalances(user.publicKey),
  });
});

const CASHOUT_FEE_BPS = 100;

app.post("/cashout/request", async (c) => {
  const { waNumber, amountIdr } = await c.req.json();
  const user = await findUser(waNumber);
  if (!user) return c.json({ error: "not found" }, 404);
  const amount = Number(amountIdr);
  if (!amount || amount <= 0) return c.json({ error: "amount required" }, 400);

  const pickup = makePickup();
  const { escrowId, hash } = await escrowLock({
    touristKp: Keypair.fromSecret(user.secret),
    amountCidr: amount,
    agentPub: process.env.AGENT_PUBLIC!,
    platformPub: process.env.TREASURY_PUBLIC!,
    feeBps: CASHOUT_FEE_BPS,
    pickupHash: pickup.hash,
  });

  await recordTx(waNumber, "cashout", "Cash withdrawal", amount, "out", hash);

  await db.insert(cashouts).values({
    escrowId,
    waNumber,
    amountIdr: amount,
    codeHex: pickup.codeHex,
    status: "pending",
    createdAt: Date.now(),
  });

  return c.json({
    escrowId,
    codeHex: pickup.codeHex,
    amountIdr: amount,
    balances: await walletBalances(user.publicKey),
  });
});

app.get("/cashout/:escrowId", async (c) => {
  const id = Number(c.req.param("escrowId"));
  const row = (await db.select().from(cashouts).where(eq(cashouts.escrowId, id)))[0];
  if (!row) return c.json({ error: "not found" }, 404);
  const fee = Math.round((row.amountIdr * CASHOUT_FEE_BPS) / 10000);
  return c.json({
    escrowId: row.escrowId,
    amountIdr: row.amountIdr,
    agentReceives: row.amountIdr - fee,
    status: row.status,
  });
});

app.post("/cashout/redeem", async (c) => {
  const { escrowId, codeHex } = await c.req.json();
  const id = Number(escrowId);
  const row = (await db.select().from(cashouts).where(eq(cashouts.escrowId, id)))[0];
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.status === "paid") return c.json({ error: "already paid out" }, 400);

  const treasury = Keypair.fromSecret(process.env.TREASURY_SECRET!);
  await escrowRelease(treasury, id, codeHex || row.codeHex);
  await db.update(cashouts).set({ status: "paid" }).where(eq(cashouts.escrowId, id));

  const fee = Math.round((row.amountIdr * CASHOUT_FEE_BPS) / 10000);
  return c.json({ escrowId: id, amountIdr: row.amountIdr, agentReceived: row.amountIdr - fee, fee });
});

app.get("/history/:waNumber", async (c) => {
  const rows = await db
    .select()
    .from(transactions)
    .where(eq(transactions.waNumber, c.req.param("waNumber")))
    .orderBy(desc(transactions.createdAt))
    .limit(15);
  return c.json(rows);
});

const fmt = (n: string | number) => new Intl.NumberFormat("id-ID").format(Math.round(Number(n)));
const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (ch) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[ch]!,
  );

async function internal(path: string, body?: unknown) {
  const res = await app.fetch(
    new Request("http://internal" + path, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text || "request failed" };
  }
}

async function botReply(waNumber: string, message: string): Promise<string> {
  const t = message.trim().toLowerCase();
  const web = process.env.WEB_WALLET_URL ?? "http://localhost:3000";
  const link = (p: string) => `${web}${p}?wa=${encodeURIComponent(waNumber)}`;
  const numIn = (s: string) => {
    const m = s.match(/(\d[\d.,]*)/);
    return m ? Number(m[1].replace(/[.,]/g, "")) : null;
  };

  await internal("/onboard", { waNumber });

  if (t.startsWith("bal")) {
    const b = await internal(`/balance/${encodeURIComponent(waNumber)}`);
    return `💰 Your balance\nRupiah: Rp ${fmt(b.cIDR)}\nUSDC: ${Number(b.USDC).toFixed(2)}`;
  }
  if (t.startsWith("top")) {
    const b = await internal("/fund", { waNumber, usdc: 200 });
    return `✅ Topped up 200 USDC (demo).\nUSDC: ${Number(b.USDC).toFixed(2)}`;
  }
  if (t.startsWith("exchange") || t.startsWith("swap")) {
    const usdc = numIn(t);
    if (!usdc) return "How much USDC? e.g. *exchange 200*";
    const q = await internal(`/fx/quote?usdc=${usdc}`);
    const r = await internal("/fx/swap", { waNumber, usdc });
    if (r.error) return `⚠️ Couldn't exchange — do you have ${usdc} USDC? Send *topup* first.`;
    return `✅ Exchanged ${usdc} USDC → Rp ${fmt(q.cidrOut)}\n💰 You saved Rp ${fmt(q.savingsIdr)} vs money changers.\nBalance: Rp ${fmt(r.balances.cIDR)}`;
  }
  if (t.startsWith("pay")) {
    return `📷 Tap to scan & pay a QRIS merchant:\n${link("/pay")}`;
  }
  if (t.startsWith("cash") || t.startsWith("withdraw")) {
    return `💵 Tap to get cash at a Castel agent:\n${link("/cashout")}`;
  }
  return `👋 Welcome to *Castel* — fair-rate rupiah for Bali, no bank needed.\n\nTry:\n• *balance*\n• *topup* — add 200 USDC (demo)\n• *exchange 200* — swap to rupiah\n• *pay* — pay a QRIS merchant\n• *cash* — withdraw at an agent`;
}

app.post("/wa/webhook", async (c) => {
  const form = await c.req.parseBody();
  const from = String(form.From ?? "").replace("whatsapp:", "");
  const body = String(form.Body ?? "");
  let reply: string;
  try {
    reply = await botReply(from, body);
  } catch (e) {
    reply = "⚠️ Something went wrong: " + (e as Error).message;
  }
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`;
  return c.body(twiml, 200, { "content-type": "text/xml" });
});

export default { port: Number(process.env.PORT ?? 3001), fetch: app.fetch };
