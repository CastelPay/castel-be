import { Keypair, Operation } from "@stellar/stellar-sdk";
import { timingSafeEqual } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import twilio from "twilio";
import Stripe from "stripe";
import { db } from "./db";
import { cIDR, submit, USDC } from "./lib/stellar";
import { parseQris } from "./lib/qris";
import { settleToMerchant, xenditEnabled, type Settlement } from "./lib/xendit";
import { escrowLock, escrowRelease, makePickup } from "./lib/soroban";
import {
  hashSecret,
  LINK_TTL_MS,
  makeOtp,
  MAX_OTP_ATTEMPTS,
  MAX_PIN_ATTEMPTS,
  OTP_TTL_MS,
  requireAuth,
  SESSION_TTL_MS,
  signToken,
  throttleOtp,
  type Vars,
  verifySecret,
  verifyToken,
} from "./lib/auth";
import {
  checkDepositLimit,
  checkSpendLimit,
  limitsFor,
  rateLimit,
} from "./lib/limits";
import { cashouts, transactions, users } from "./db/schema";
import { createWallet, walletBalances } from "./services/custody";
import { quoteUsdcToCidr, swapUsdcToCidr } from "./services/fx";
import { usdIdrMid } from "./lib/rates";

const app = new Hono<Vars>();
const WEB = process.env.WEB_WALLET_URL ?? "http://localhost:3000";

app.use("*", logger());
app.use("*", cors({ origin: [WEB, "http://localhost:3000"], allowHeaders: ["content-type", "authorization"] }));

const clientIp = (c: Context) =>
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

// Abuse control sits in front of anything that costs us money or reaches Twilio.
app.use("/auth/*", async (c, next) => {
  if (!rateLimit("auth:" + clientIp(c), 10, 60_000))
    return c.json({ error: "too many attempts — try again in a minute" }, 429);
  await next();
});

for (const path of ["/pay", "/cashout/request", "/fx/swap", "/deposit/create", "/fund"]) {
  app.use(path, async (c, next) => {
    const who = c.req.header("Authorization") ?? clientIp(c);
    if (!rateLimit("money:" + who, 20, 60_000))
      return c.json({ error: "too many requests — slow down" }, 429);
    await next();
  });
}

const findUser = async (waNumber: string) =>
  (await db.select().from(users).where(eq(users.waNumber, waNumber)))[0];

type User = NonNullable<Awaited<ReturnType<typeof findUser>>>;

async function ensureUser(waNumber: string): Promise<User> {
  const existing = await findUser(waNumber);
  if (existing) return existing;
  const wallet = await createWallet();
  await db.insert(users).values({
    waNumber,
    publicKey: wallet.publicKey,
    secret: wallet.secret,
    createdAt: Date.now(),
  });
  return (await findUser(waNumber))!;
}

/** Spending needs the PIN — a hijacked WhatsApp session must not be able to move money. */
async function checkPin(user: User, pin: unknown): Promise<string | null> {
  if (!user.pinHash) return "pin not set";
  if (user.pinAttempts >= MAX_PIN_ATTEMPTS) return "pin locked";
  if (!pin) return "pin required";
  if (!(await verifySecret(String(pin), user.pinHash))) {
    await db
      .update(users)
      .set({ pinAttempts: user.pinAttempts + 1 })
      .where(eq(users.id, user.id));
    return "wrong pin";
  }
  if (user.pinAttempts > 0) {
    await db.update(users).set({ pinAttempts: 0 }).where(eq(users.id, user.id));
  }
  return null;
}

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

const normalizeWa = (s: string) => s.trim().replace(/[^\d+]/g, "");

// Proving you own a WhatsApp number means receiving something sent to it.
// Typing the number proves nothing, so every session starts with an OTP.
app.post("/auth/request", async (c) => {
  const { waNumber } = await c.req.json();
  const wa = normalizeWa(String(waNumber ?? ""));
  if (!/^\+\d{8,15}$/.test(wa)) return c.json({ error: "valid waNumber required" }, 400);
  if (!throttleOtp(wa)) return c.json({ error: "please wait before requesting another code" }, 429);

  const user = await ensureUser(wa);
  const otp = makeOtp();
  await db
    .update(users)
    .set({ otpHash: await hashSecret(otp), otpExpires: Date.now() + OTP_TTL_MS, otpAttempts: 0 })
    .where(eq(users.id, user.id));

  if (process.env.LOG_OTP === "true") console.log(`[dev] OTP for ${wa}: ${otp}`);

  const sent = await sendWa("whatsapp:" + wa, `🔐 Your Castel code is ${otp}\nIt expires in 5 minutes.`);
  // Twilio's WhatsApp sandbox will only deliver to numbers that have joined it.
  // Reporting success anyway leaves the user waiting for a code that never arrives.
  if (!sent && !process.env.LOG_OTP)
    return c.json({ error: "couldn't reach that number on WhatsApp — message the bot first" }, 502);

  return c.json({ sent: true });
});

app.post("/auth/verify", async (c) => {
  const { waNumber, otp } = await c.req.json();
  const wa = normalizeWa(String(waNumber ?? ""));
  const user = await findUser(wa);
  if (!user?.otpHash || !user.otpExpires) return c.json({ error: "request a code first" }, 400);
  if (user.otpExpires < Date.now()) return c.json({ error: "code expired" }, 400);
  if (user.otpAttempts >= MAX_OTP_ATTEMPTS) return c.json({ error: "too many attempts" }, 429);

  if (!(await verifySecret(String(otp ?? ""), user.otpHash))) {
    await db
      .update(users)
      .set({ otpAttempts: user.otpAttempts + 1 })
      .where(eq(users.id, user.id));
    return c.json({ error: "wrong code" }, 401);
  }

  await db
    .update(users)
    .set({ otpHash: null, otpExpires: null, otpAttempts: 0 })
    .where(eq(users.id, user.id));

  return c.json({
    token: signToken(wa, "session", SESSION_TTL_MS),
    waNumber: wa,
    publicKey: user.publicKey,
    hasPin: !!user.pinHash,
  });
});

// Magic links from WhatsApp carry a short-lived signed token; only the owner of
// the number ever received it, so it stands in for the OTP.
app.post("/auth/exchange", async (c) => {
  const { linkToken } = await c.req.json();
  const wa = linkToken ? verifyToken(String(linkToken), "link") : null;
  if (!wa) return c.json({ error: "invalid or expired link" }, 401);
  const user = await ensureUser(wa);
  return c.json({
    token: signToken(wa, "session", SESSION_TTL_MS),
    waNumber: wa,
    publicKey: user.publicKey,
    hasPin: !!user.pinHash,
  });
});

app.get("/me", requireAuth, async (c) => {
  const user = await findUser(c.get("wa"));
  if (!user) return c.json({ error: "not found" }, 404);
  return c.json({ waNumber: user.waNumber, publicKey: user.publicKey, hasPin: !!user.pinHash });
});

app.post("/me/pin", requireAuth, async (c) => {
  const { pin } = await c.req.json();
  if (!/^\d{6}$/.test(String(pin ?? ""))) return c.json({ error: "pin must be 6 digits" }, 400);
  const user = await findUser(c.get("wa"));
  if (!user) return c.json({ error: "not found" }, 404);
  if (user.pinHash) return c.json({ error: "pin already set" }, 409);
  await db
    .update(users)
    .set({ pinHash: await hashSecret(String(pin)), pinAttempts: 0 })
    .where(eq(users.id, user.id));
  return c.json({ ok: true });
});

app.get("/me/limits", requireAuth, async (c) => c.json(await limitsFor(c.get("wa"))));

app.get("/me/balance", requireAuth, async (c) => {
  const user = await findUser(c.get("wa"));
  if (!user) return c.json({ error: "not found" }, 404);
  return c.json(await walletBalances(user.publicKey));
});

app.get("/fx/quote", async (c) => {
  const usdc = Number(c.req.query("usdc") ?? "0");
  if (!usdc) return c.json({ error: "usdc query param required" }, 400);
  return c.json(await quoteUsdcToCidr(usdc));
});

// Testnet demo faucet. Anyone can self-register a WhatsApp number, so without the
// flag and the cap this is an open tap straight out of the treasury.
const DEMO_FUND_MAX = 500;



app.post("/fund", requireAuth, async (c) => {
  if (process.env.ALLOW_DEMO_FUND !== "true") return c.json({ error: "disabled" }, 403);
  const { usdc } = await c.req.json();
  const amount = Number(usdc);
  if (!Number.isFinite(amount) || amount <= 0 || amount > DEMO_FUND_MAX)
    return c.json({ error: `usdc must be between 0 and ${DEMO_FUND_MAX}` }, 400);
  const user = await findUser(c.get("wa"));
  if (!user) return c.json({ error: "not found" }, 404);
  const treasury = Keypair.fromSecret(process.env.TREASURY_SECRET!);
  await submit(treasury, (b) =>
    b.addOperation(
      Operation.payment({ destination: user.publicKey, asset: USDC(), amount: String(amount) }),
    ),
  );
  return c.json(await walletBalances(user.publicKey));
});

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

app.post("/deposit/create", requireAuth, async (c) => {
  if (!stripe) return c.json({ error: "stripe not configured" }, 500);
  const waNumber = c.get("wa");
  const { usd } = await c.req.json();
  const user = await findUser(waNumber);
  if (!user) return c.json({ error: "not found" }, 404);
  const amount = Number(usd);
  if (!amount || amount <= 0) return c.json({ error: "amount required" }, 400);

  // A quote needs a route on the DEX, and a large enough amount has none. Fall back to
  // the reference rate so the tier limit — not a liquidity error — is what the user sees.
  const quote = await quoteUsdcToCidr(amount).catch(() => null);
  const idrValue = quote?.cidrOut ?? amount * (await usdIdrMid()).rate;

  const limit = await checkDepositLimit(waNumber, idrValue);
  if (!limit.ok) return c.json({ error: limit.error }, 403);
  if (!quote) return c.json({ error: "that amount is too large to exchange right now" }, 400);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Math.round(amount * 100),
          product_data: {
            name: "Castel top-up",
            description: `Adds about ${rupiah(quote.cidrOut)} to your Castel balance`,
          },
        },
      },
    ],
    success_url: `${WEB}/wallet?deposit={CHECKOUT_SESSION_ID}`,
    cancel_url: `${WEB}/wallet?deposit=cancel`,
    metadata: { waNumber, usd: String(amount) },
  });

  return c.json({ url: session.url });
});

app.post("/deposit/confirm", requireAuth, async (c) => {
  if (!stripe) return c.json({ error: "stripe not configured" }, 500);
  const waNumber = c.get("wa");
  const { sessionId } = await c.req.json();
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== "paid")
    return c.json({ error: "not paid", status: session.payment_status }, 402);
  if (session.metadata?.waNumber !== waNumber)
    return c.json({ error: "session does not belong to you" }, 403);

  const user = await findUser(waNumber);
  if (!user) return c.json({ error: "not found" }, 404);

  const usd = Number(session.metadata?.usd ?? (session.amount_total ?? 0) / 100);
  const balances = await walletBalances(user.publicKey);

  // Idempotent: the confirm redirect can fire more than once — credit only once per session.
  const already = (
    await db.select().from(transactions).where(eq(transactions.hash, sessionId))
  )[0];
  if (already) return c.json({ credited: false, usd, balances });

  const treasury = Keypair.fromSecret(process.env.TREASURY_SECRET!);
  await submit(treasury, (b) =>
    b.addOperation(
      Operation.payment({ destination: user.publicKey, asset: USDC(), amount: String(usd) }),
    ),
  );

  // The tourist bought rupiah, not crypto. USDC is a rail, so it is converted here
  // rather than left on the balance for them to reason about.
  const userKp = Keypair.fromSecret(user.secret);
  try {
    const { hash, quote } = await swapUsdcToCidr(userKp, usd);
    await recordTx(waNumber, "deposit", `Added ${rupiah(quote.cidrOut)}`, quote.cidrOut, "in", sessionId);
    return c.json({
      credited: true,
      usd,
      cidr: quote.cidrOut,
      rate: quote.rate,
      savingsIdr: quote.savingsIdr,
      hash,
      balances: await walletBalances(user.publicKey),
    });
  } catch (e) {
    // The card already cleared, so the money must not vanish: keep it as USDC and let
    // the wallet offer a manual exchange.
    await recordTx(waNumber, "deposit", `Added $${usd} (exchange pending)`, 0, "in", sessionId);
    return c.json({
      credited: true,
      usd,
      exchangeFailed: (e as Error).message,
      balances: await walletBalances(user.publicKey),
    });
  }
});

// Over-fund the card charge by this much so the on-chain swap reliably clears the bill
// despite the spread and slippage. The remainder lands as balance.
const QUICKPAY_BUFFER = 0.03;

// Quick pay: no prefund. Scan → pay, charging the card for exactly this bill (plus the
// buffer). The card authorisation is the authorisation, so unlike a balance payment there
// is no PIN — there was no pre-existing balance to protect, and the leftover buffer is all
// that ends up on the wallet.
app.post("/pay/quick/create", requireAuth, async (c) => {
  if (!stripe) return c.json({ error: "stripe not configured" }, 500);
  const waNumber = c.get("wa");
  const { payload, amount } = await c.req.json();
  const info = parseQris(String(payload ?? ""));
  const amountIdr = info.amount ?? Number(amount);
  if (!amountIdr || amountIdr <= 0) return c.json({ error: "amount required" }, 400);

  const spend = await checkSpendLimit(waNumber, amountIdr);
  if (!spend.ok) return c.json({ error: spend.error }, 403);

  const mid = await usdIdrMid();
  const usd = Math.ceil((amountIdr / mid.rate) * (1 + QUICKPAY_BUFFER) * 100) / 100;

  const dep = await checkDepositLimit(waNumber, usd * mid.rate);
  if (!dep.ok) return c.json({ error: dep.error }, 403);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Math.round(usd * 100),
          product_data: {
            name: `Pay ${info.merchantName}`,
            description: `${rupiah(amountIdr)} at ${info.merchantName}`,
          },
        },
      },
    ],
    success_url: `${WEB}/pay?quick={CHECKOUT_SESSION_ID}`,
    cancel_url: `${WEB}/pay?quick=cancel`,
    metadata: { waNumber, usd: String(usd), quickPayload: String(payload), quickAmountIdr: String(amountIdr) },
  });

  return c.json({ url: session.url, usd, amountIdr });
});

app.post("/pay/quick/confirm", requireAuth, async (c) => {
  if (!stripe) return c.json({ error: "stripe not configured" }, 500);
  const waNumber = c.get("wa");
  const { sessionId } = await c.req.json();
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== "paid")
    return c.json({ error: "not paid", status: session.payment_status }, 402);
  if (session.metadata?.waNumber !== waNumber)
    return c.json({ error: "session does not belong to you" }, 403);

  const user = await findUser(waNumber);
  if (!user) return c.json({ error: "not found" }, 404);

  const usd = Number(session.metadata?.usd ?? 0);
  const payload = String(session.metadata?.quickPayload ?? "");
  const amountIdr = Number(session.metadata?.quickAmountIdr ?? 0);
  const info = parseQris(payload);
  const userKp = Keypair.fromSecret(user.secret);

  // The card-charge leg is marked before the swap so a repeated redirect can never charge
  // the card twice, even if the swap or the merchant payment below throws and is retried.
  const charged = (
    await db.select().from(transactions).where(eq(transactions.hash, sessionId))
  )[0];
  if (!charged) {
    const treasury = Keypair.fromSecret(process.env.TREASURY_SECRET!);
    await submit(treasury, (b) =>
      b.addOperation(
        Operation.payment({ destination: user.publicKey, asset: USDC(), amount: String(usd) }),
      ),
    );
    await recordTx(waNumber, "deposit", `Card charge · ${info.merchantName}`, 0, "in", sessionId);
    await swapUsdcToCidr(userKp, usd);
  }

  // The merchant-payment leg has its own marker keyed on the same session, so a retry
  // after the swap resumes into the payment instead of paying the merchant twice.
  const payHash = `${sessionId}:pay`;
  const alreadyPaid = (
    await db.select().from(transactions).where(eq(transactions.hash, payHash))
  )[0];
  if (alreadyPaid) {
    return c.json({
      merchant: info.merchantName,
      city: info.city,
      amountIdr,
      alreadyPaid: true,
      settlement: null,
      balances: await walletBalances(user.publicKey),
    });
  }

  const res = await submit(userKp, (b) =>
    b.addOperation(
      Operation.payment({
        destination: process.env.TREASURY_PUBLIC!,
        asset: cIDR(),
        amount: amountIdr.toFixed(7),
      }),
    ),
  );
  await recordTx(waNumber, "pay", info.merchantName, amountIdr, "out", payHash);

  let settlement: Settlement | { error: string } | null = null;
  if (xenditEnabled()) {
    try {
      settlement = await settleToMerchant({
        externalId: `castel-pay-${res.hash.slice(0, 24)}`,
        amountIdr,
        merchantName: info.merchantName,
      });
    } catch (e) {
      settlement = { error: (e as Error).message };
    }
  }

  return c.json({
    merchant: info.merchantName,
    city: info.city,
    amountIdr,
    hash: res.hash,
    settlement,
    balances: await walletBalances(user.publicKey),
  });
});

app.post("/fx/swap", requireAuth, async (c) => {
  const waNumber = c.get("wa");
  const { usdc } = await c.req.json();
  const amount = Number(usdc);
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: "usdc required" }, 400);
  const user = await findUser(waNumber);
  if (!user) return c.json({ error: "not found" }, 404);

  const { hash, quote } = await swapUsdcToCidr(Keypair.fromSecret(user.secret), amount);
  await recordTx(waNumber, "swap", `Exchanged ${amount} USDC`, quote.cidrOut, "in", hash);

  return c.json({ hash, quote, balances: await walletBalances(user.publicKey) });
});

app.post("/qris/decode", async (c) => {
  const { payload } = await c.req.json();
  if (!payload) return c.json({ error: "payload required" }, 400);
  return c.json(parseQris(payload));
});

app.post("/pay", requireAuth, async (c) => {
  const waNumber = c.get("wa");
  const { payload, amount, pin } = await c.req.json();
  const user = await findUser(waNumber);
  if (!user) return c.json({ error: "not found" }, 404);

  const pinError = await checkPin(user, pin);
  if (pinError) return c.json({ error: pinError }, 403);

  const info = parseQris(payload);
  const amountIdr = info.amount ?? Number(amount);
  if (!amountIdr || amountIdr <= 0) return c.json({ error: "amount required" }, 400);

  const limit = await checkSpendLimit(waNumber, amountIdr);
  if (!limit.ok) return c.json({ error: limit.error }, 403);

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

  // Settle IDR to the merchant via Xendit sandbox. Non-fatal: the on-chain debit
  // already succeeded, so a settlement error must not fail the payment.
  let settlement: Settlement | { error: string } | null = null;
  if (xenditEnabled()) {
    try {
      settlement = await settleToMerchant({
        externalId: `castel-pay-${res.hash.slice(0, 24)}`,
        amountIdr,
        merchantName: info.merchantName,
      });
    } catch (e) {
      settlement = { error: (e as Error).message };
    }
  }

  return c.json({
    merchant: info.merchantName,
    city: info.city,
    amountIdr,
    hash: res.hash,
    settlement,
    balances: await walletBalances(user.publicKey),
  });
});

const CASHOUT_FEE_BPS = 100;
const agentFee = (amountIdr: number) => Math.round((amountIdr * CASHOUT_FEE_BPS) / 10000);

app.post("/cashout/request", requireAuth, async (c) => {
  const waNumber = c.get("wa");
  const { amountIdr, pin } = await c.req.json();
  const user = await findUser(waNumber);
  if (!user) return c.json({ error: "not found" }, 404);

  const pinError = await checkPin(user, pin);
  if (pinError) return c.json({ error: pinError }, 403);

  const amount = Number(amountIdr);
  if (!amount || amount <= 0) return c.json({ error: "amount required" }, 400);

  const limit = await checkSpendLimit(waNumber, amount);
  if (!limit.ok) return c.json({ error: limit.error }, 403);

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
  const fee = agentFee(row.amountIdr);
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

  // The pickup code is the credential: it is what the tourist hands the agent.
  // Never fall back to the stored code — escrow ids are sequential, so that would
  // let anyone release every pending escrow just by counting upwards.
  const given = Buffer.from(String(codeHex ?? ""));
  const expected = Buffer.from(row.codeHex);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return c.json({ error: "invalid pickup code" }, 403);

  const treasury = Keypair.fromSecret(process.env.TREASURY_SECRET!);
  await escrowRelease(treasury, id, row.codeHex);
  await db.update(cashouts).set({ status: "paid" }).where(eq(cashouts.escrowId, id));

  const fee = agentFee(row.amountIdr);
  return c.json({ escrowId: id, amountIdr: row.amountIdr, agentReceived: row.amountIdr - fee, fee });
});

app.get("/me/history", requireAuth, async (c) => {
  const rows = await db
    .select()
    .from(transactions)
    .where(eq(transactions.waNumber, c.get("wa")))
    .orderBy(desc(transactions.createdAt))
    .limit(15);
  return c.json(rows);
});

const fmt = (n: string | number) => new Intl.NumberFormat("id-ID").format(Math.round(Number(n)));
const rupiah = (n: number) => `Rp ${fmt(n)}`;
const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (ch) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[ch]!,
  );

async function internal(path: string, body?: unknown, wa?: string) {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (wa) headers.Authorization = "Bearer " + signToken(wa, "session", 60_000);
  const res = await app.fetch(
    new Request("http://internal" + path, {
      method: body ? "POST" : "GET",
      headers,
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
  const link = (p: string) => `${WEB}${p}?t=${signToken(waNumber, "link", LINK_TTL_MS)}`;
  const numIn = (s: string) => {
    const m = s.match(/(\d[\d.,]*)/);
    return m ? Number(m[1].replace(/[.,]/g, "")) : null;
  };

  await ensureUser(waNumber);

  if (t.startsWith("bal")) {
    const b = await internal("/me/balance", undefined, waNumber);
    const pending = Number(b.USDC) > 0 ? `\n(${Number(b.USDC).toFixed(2)} USDC not yet exchanged)` : "";
    return `💰 Your balance\n${rupiah(Number(b.cIDR))}${pending}`;
  }
  if (t.startsWith("top") || t.startsWith("deposit") || t.startsWith("add")) {
    return `💳 Tap to add rupiah with your card:\n${link("/wallet")}&topup=1`;
  }
  if (t.startsWith("exchange") || t.startsWith("swap")) {
    const usdc = numIn(t);
    if (!usdc) return "How much USDC? e.g. *exchange 200*";
    const q = await internal(`/fx/quote?usdc=${usdc}`);
    const r = await internal("/fx/swap", { usdc }, waNumber);
    if (r.error) return `⚠️ Couldn't exchange — do you have ${usdc} USDC? Send *topup* first.`;
    return `✅ Exchanged ${usdc} USDC → Rp ${fmt(q.cidrOut)}\n💰 You saved Rp ${fmt(q.savingsIdr)} vs money changers.\nBalance: Rp ${fmt(r.balances.cIDR)}`;
  }
  if (t.startsWith("pay")) {
    return `📷 Tap to scan & pay a QRIS merchant:\n${link("/pay")}`;
  }
  if (t.startsWith("cash") || t.startsWith("withdraw")) {
    return `💵 Tap to get cash at a Castel agent:\n${link("/cashout")}`;
  }
  return `👋 Welcome to *Castel* — fair-rate rupiah for Bali, no bank needed.\n\nTry:\n• *balance* — see your rupiah\n• *topup* — add rupiah with your card\n• *pay* — scan & pay any QRIS merchant\n• *cash* — withdraw cash at an agent`;
}

const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

async function sendWa(to: string, body: string): Promise<boolean> {
  if (!twilioClient) return false;
  try {
    await twilioClient.messages.create({ from: process.env.TWILIO_WHATSAPP_FROM!, to, body });
    return true;
  } catch (e) {
    console.error("sendWa failed:", (e as Error).message);
    return false;
  }
}

// On-chain commands take a few seconds — show an instant acknowledgement.
function loadingMessage(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (t.startsWith("exchange") || t.startsWith("swap")) return "⏳ Exchanging at the best rate… one moment";
  if (t.startsWith("cash") || t.startsWith("withdraw")) return "⏳ Preparing your cash pickup…";
  return null;
}

function twiml(c: Context, message: string) {
  const body = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`;
  return c.body(body, 200, { "content-type": "text/xml" });
}

// Twilio signs every webhook. Without this check anyone can POST here claiming
// to be any WhatsApp number. The signed URL must match what Twilio saw, so it is
// built from PUBLIC_URL — behind Render's proxy c.req.url is not that URL.
function twilioSignatureValid(c: Context, form: Record<string, unknown>): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return true;
  const publicUrl = process.env.PUBLIC_URL;
  if (!publicUrl) {
    console.error("PUBLIC_URL not set — cannot verify Twilio signature");
    return false;
  }
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(form)) params[k] = String(v);
  return twilio.validateRequest(
    token,
    c.req.header("X-Twilio-Signature") ?? "",
    publicUrl.replace(/\/$/, "") + "/wa/webhook",
    params,
  );
}

app.post("/wa/webhook", async (c) => {
  const form = await c.req.parseBody();
  if (!twilioSignatureValid(c, form)) return c.text("forbidden", 403);

  const from = String(form.From ?? "").replace("whatsapp:", "");
  const body = String(form.Body ?? "");

  const loading = loadingMessage(body);
  if (loading && twilioClient) {
    void (async () => {
      let reply: string;
      try {
        reply = await botReply(from, body);
      } catch (e) {
        reply = "⚠️ Something went wrong: " + (e as Error).message;
      }
      await sendWa("whatsapp:" + from, reply);
    })();
    return twiml(c, loading);
  }

  let reply: string;
  try {
    reply = await botReply(from, body);
  } catch (e) {
    reply = "⚠️ Something went wrong: " + (e as Error).message;
  }
  return twiml(c, reply);
});

export default { port: Number(process.env.PORT ?? 3001), fetch: app.fetch };
