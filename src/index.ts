import { Keypair, Operation } from "@stellar/stellar-sdk";
import { timingSafeEqual } from "node:crypto";
import { and, desc, eq, ne, notInArray, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import twilio from "twilio";
import Stripe from "stripe";
import { db } from "./db";
import { cIDR, circleUSDC, CIRCLE_USDC_ISSUER, horizon, submit, USDC } from "./lib/stellar";
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
  PIN_RESET_TTL_MS,
  pinProblem,
  requireAuth,
  SESSION_TTL_MS,
  signToken,
  throttleOtp,
  throttleSend,
  type Vars,
  verifySecret,
  verifyToken,
} from "./lib/auth";
import {
  checkDepositLimit,
  checkSpendLimit,
  HOLD_DEPOSIT,
  HOLD_SPEND,
  HOLD_TYPES,
  limitsFor,
  rateLimit,
} from "./lib/limits";
import { cashouts, transactions, users } from "./db/schema";
import {
  activateWallet,
  circleUsdcBalance,
  newWallet,
  trustCircleUsdc,
  walletBalances,
} from "./services/custody";
import { buildQuote, quoteUsdcToCidr, swapUsdcToCidr } from "./services/fx";
import { MONEY_CHANGER_MARKDOWN, usdIdrMid, xlmUsd } from "./lib/rates";

const app = new Hono<Vars>();

// Castel's margin on any reference-rate conversion (the fiat card rail, the crypto on-ramps,
// and where the DEX market maker posts its offers). cIDR out for a given USD in.
const REFERENCE_SPREAD_BPS = 30;
const refCidr = (usd: number, mid: number) =>
  Math.round((usd * mid * (10_000 - REFERENCE_SPREAD_BPS)) / 10_000);
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

// `/me/pin/*` is in here because it reaches Twilio (the reset link) and guards spending —
// the same two reasons the rest of this list is throttled.
for (const path of [
  "/pay",
  "/pay/*",
  "/cashout/request",
  "/fx/swap",
  "/deposit/*",
  "/fund",
  "/me/pin",
  "/me/pin/*",
]) {
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

// A row with a fresh keypair, created instantly. The on-chain account is funded + trustlined
// later by ensureActivated, so sign-up (and its OTP) never waits ~15s on friendbot.
async function ensureUser(waNumber: string): Promise<User> {
  const existing = await findUser(waNumber);
  if (existing) return existing;
  const wallet = newWallet();
  await db.insert(users).values({
    waNumber,
    publicKey: wallet.publicKey,
    secret: wallet.secret,
    activated: false,
    createdAt: Date.now(),
  });
  return (await findUser(waNumber))!;
}

// Fund + trustline the account, once, before it is used on-chain. Concurrent callers (the
// background kick-off at sign-up and the first real request) share one activation.
const activating = new Map<number, Promise<void>>();

function activate(user: User): Promise<void> {
  let p = activating.get(user.id);
  if (!p) {
    p = (async () => {
      const fresh = await findUser(user.waNumber);
      if (fresh?.activated) return;
      await activateWallet(user.secret);
      await db.update(users).set({ activated: true }).where(eq(users.id, user.id));
    })().finally(() => activating.delete(user.id));
    activating.set(user.id, p);
  }
  return p;
}

async function ensureActivated(user: User): Promise<void> {
  if (user.activated) return;
  await activate(user);
}

/** findUser for routes that touch the chain: guarantees the account is funded + trustlined. */
async function walletUser(waNumber: string): Promise<User | null> {
  const user = await findUser(waNumber);
  if (!user) return null;
  await ensureActivated(user);
  return user;
}

/** Spending needs the PIN — a hijacked WhatsApp session must not be able to move money. */
async function checkPin(user: User, pin: unknown): Promise<string | null> {
  if (user.frozen) return "account frozen — message the bot to unfreeze";
  if (!user.pinHash) return "pin not set";
  if (user.pinAttempts >= MAX_PIN_ATTEMPTS)
    return "pin locked — send *forgot pin* on WhatsApp to set a new one";
  if (!pin) return "pin required";
  if (!(await verifySecret(String(pin), user.pinHash))) {
    // Increment in SQL, not from the row we read: two wrong guesses racing would otherwise
    // both write the same number and quietly hand out more than MAX_PIN_ATTEMPTS tries.
    const [row] = await db
      .update(users)
      .set({ pinAttempts: sql`${users.pinAttempts} + 1` })
      .where(eq(users.id, user.id))
      .returning({ attempts: users.pinAttempts });
    const left = Math.max(0, MAX_PIN_ATTEMPTS - (row?.attempts ?? user.pinAttempts + 1));
    // Say how many are left: without it the lock arrives with no warning, and the account
    // is stuck behind a reset the user didn't know they were one wrong guess away from.
    return left > 0
      ? `wrong pin — ${left} ${left === 1 ? "try" : "tries"} left`
      : "pin locked — send *forgot pin* on WhatsApp to set a new one";
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

/**
 * Reserve `hash` for exactly one credit by inserting its ledger row up front. The unique index
 * on `hash` makes this atomic, so a concurrent or replayed request that would otherwise mint a
 * second time gets `false` and must skip the on-chain submit. Call releaseHash if the submit
 * then fails, so a genuine retry can re-attempt.
 */
async function reserveHash(
  waNumber: string,
  type: string,
  title: string,
  amountIdr: number,
  direction: "in" | "out",
  hash: string,
): Promise<boolean> {
  const inserted = await db
    .insert(transactions)
    .values({
      waNumber,
      type,
      title,
      amountIdr: Math.round(amountIdr),
      direction,
      hash,
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .returning({ id: transactions.id });
  return inserted.length > 0;
}

const releaseHash = (hash: string) =>
  db.delete(transactions).where(eq(transactions.hash, hash)).catch(() => {});

// A hold reserves limit headroom for an unpaid Checkout session (see limits.ts). Placed at
// create, deleted at confirm, and ignored by the cap after HOLD_TTL if the session is abandoned.
const placeHold = (
  waNumber: string,
  type: string,
  amountIdr: number,
  direction: "in" | "out",
  sessionId: string,
) => recordTx(waNumber, type, "Pending", amountIdr, direction, `hold:${sessionId}`);
const releaseHold = (sessionId: string) => releaseHash(`hold:${sessionId}`);

/**
 * Serialize async work per key, in-process (single Render instance today). Used so two
 * concurrent requests for the same account can't both read a balance and both act on it.
 */
const userLocks = new Map<string, Promise<unknown>>();
function withUserLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (userLocks.get(key) ?? Promise.resolve()).then(fn, fn);
  userLocks.set(
    key,
    run.catch(() => {}),
  );
  return run;
}

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

  // Warm the on-chain account in the background while the user reads the code and types it in.
  void ensureActivated(user).catch(() => {});
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
  void ensureActivated(user).catch(() => {});
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
  const bad = pinProblem(String(pin ?? ""));
  if (bad) return c.json({ error: bad }, 400);
  const user = await findUser(c.get("wa"));
  if (!user) return c.json({ error: "not found" }, 404);
  // Changing an existing PIN goes through the WhatsApp reset link, never through a live
  // session — a stolen session must not be able to swap the credential that guards spending.
  if (user.pinHash) return c.json({ error: "pin already set" }, 409);
  await db
    .update(users)
    .set({ pinHash: await hashSecret(String(pin)), pinAttempts: 0, pinChangedAt: Date.now() })
    .where(eq(users.id, user.id));
  return c.json({ ok: true });
});

/**
 * Forgot-PIN, step 1: mail a single-use reset link to the number itself. Only the owner of
 * the WhatsApp account receives it, which is the same proof of ownership the OTP gives — so
 * this is deliberately NOT reachable with a session token alone (see the note in SECURITY.md
 * about what a WhatsApp takeover does and does not get you).
 */
async function sendPinResetLink(waNumber: string): Promise<{ sent: boolean; error?: string }> {
  const user = await findUser(waNumber);
  if (!user) return { sent: false, error: "not found" };
  if (!throttleSend("pinreset:" + waNumber))
    return { sent: false, error: "please wait before asking for another reset link" };

  // The token is signed AND its hash is stored: the signature bounds its lifetime, the stored
  // hash is what redeeming clears, making the link good exactly once.
  const token = signToken(waNumber, "pinreset", PIN_RESET_TTL_MS);
  await db
    .update(users)
    .set({ pinResetHash: await hashSecret(token), pinResetExpires: Date.now() + PIN_RESET_TTL_MS })
    .where(eq(users.id, user.id));

  const url = `${WEB}/reset-pin?t=${token}`;
  const sent = await sendWa(
    "whatsapp:" + waNumber,
    `🔑 Reset your Castel PIN\n${url}\n\nThe link works once and expires in 15 minutes. If you didn't ask for this, ignore it — your PIN hasn't changed.`,
  );
  if (!sent && process.env.LOG_OTP === "true") {
    console.log(`[dev] PIN reset link for ${waNumber}: ${url}`);
    return { sent: true };
  }
  return sent ? { sent: true } : { sent: false, error: "couldn't reach that number on WhatsApp" };
}

// Triggered from the web ("Forgot PIN?"), which knows the number from the session. The link
// still goes to WhatsApp — the session only says which number to send it to.
app.post("/me/pin/reset-link", requireAuth, async (c) => {
  const res = await sendPinResetLink(c.get("wa"));
  return res.sent ? c.json({ sent: true }) : c.json({ error: res.error }, 429);
});

/**
 * Forgot-PIN, step 2: redeem the link. The token IS the authorisation, so no session is
 * required — the user is typically locked out and may be on a fresh device. Redeeming also
 * clears the attempt counter, which is what makes a locked PIN recoverable at all.
 */
app.post("/auth/pin/reset", async (c) => {
  const { token, pin } = await c.req.json();
  const wa = token ? verifyToken(String(token), "pinreset") : null;
  if (!wa) return c.json({ error: "this reset link is invalid or has expired" }, 401);

  const bad = pinProblem(String(pin ?? ""));
  if (bad) return c.json({ error: bad }, 400);

  const user = await findUser(wa);
  if (!user?.pinResetHash || !user.pinResetExpires)
    return c.json({ error: "this reset link has already been used" }, 401);
  if (user.pinResetExpires < Date.now())
    return c.json({ error: "this reset link has expired — ask for a new one" }, 401);
  if (!(await verifySecret(String(token), user.pinResetHash)))
    return c.json({ error: "this reset link has already been used" }, 401);

  await db
    .update(users)
    .set({
      pinHash: await hashSecret(String(pin)),
      pinAttempts: 0,
      pinChangedAt: Date.now(),
      pinResetHash: null,
      pinResetExpires: null,
    })
    .where(eq(users.id, user.id));

  // Tell the number its PIN changed and give it a one-word way to stop the damage. A
  // takeover that got as far as the reset link is loud from here on, not silent.
  void sendWa(
    "whatsapp:" + wa,
    `🔐 Your Castel PIN was just changed.\n\nIf that wasn't you, reply *BLOCK* now — it freezes spending on your account immediately.`,
  ).catch(() => {});

  return c.json({
    token: signToken(wa, "session", SESSION_TTL_MS),
    waNumber: wa,
    publicKey: user.publicKey,
    hasPin: true,
  });
});

app.get("/me/limits", requireAuth, async (c) => c.json(await limitsFor(c.get("wa"))));

// Everything the deposit sheet needs: the Stellar address to receive USDC at, the USDC
// asset to send, and whether a card is already on file for one-tap top-ups.
app.get("/me/wallet", requireAuth, async (c) => {
  const user = await walletUser(c.get("wa"));
  if (!user) return c.json({ error: "not found" }, 404);
  const usdc = USDC();
  const card = stripe && user.stripeCustomerId ? await savedCard(user.stripeCustomerId) : null;
  return c.json({
    publicKey: user.publicKey,
    usdc: { code: usdc.getCode(), issuer: usdc.getIssuer() },
    balances: await walletBalances(user.publicKey),
    hasSavedCard: !!card,
    cardLast4: card?.card?.last4 ?? null,
  });
});

app.get("/me/balance", requireAuth, async (c) => {
  const user = await walletUser(c.get("wa"));
  if (!user) return c.json({ error: "not found" }, 404);
  return c.json(await walletBalances(user.publicKey));
});

// A preview/estimate. Priced off the reference rate (what the market maker pegs the book to),
// so it always resolves — no dependency on live DEX depth just to show a number.
app.get("/fx/quote", async (c) => {
  const usdc = Number(c.req.query("usdc") ?? "0");
  if (!usdc) return c.json({ error: "usdc query param required" }, 400);
  const mid = await usdIdrMid();
  return c.json(buildQuote(usdc, refCidr(usdc, mid.rate), mid));
});

// Rupiah preview for a native-XLM deposit: XLM → USD (Coinbase spot) → cIDR at the reference
// rate. Same shape as /fx/quote so the wallet renders it exactly like the card/USDC preview.
app.get("/fx/xlm-quote", async (c) => {
  const xlm = Number(c.req.query("xlm") ?? "0");
  if (!xlm) return c.json({ error: "xlm query param required" }, 400);
  const usdValue = xlm * (await xlmUsd()).rate;
  const mid = await usdIdrMid();
  return c.json(buildQuote(usdValue, refCidr(usdValue, mid.rate), mid));
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
  const user = await walletUser(c.get("wa"));
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

/** Reuse one Stripe customer per user so the card saved on the first top-up can be charged again. */
async function stripeCustomerFor(user: User): Promise<string> {
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const customer = await stripe!.customers.create({
    metadata: { waNumber: user.waNumber },
  });
  await db.update(users).set({ stripeCustomerId: customer.id }).where(eq(users.id, user.id));
  return customer.id;
}

async function savedCard(customerId: string): Promise<Stripe.PaymentMethod | null> {
  const pms = await stripe!.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
  return pms.data[0] ?? null;
}

/**
 * The tourist bought rupiah, not crypto. The card money is the reserve (held as fiat at the
 * payment processor), so we issue the matching cIDR straight to the user at the reference
 * rate — no DEX, nothing to strand, and the balance simply reads in rupiah. `txHash` keys
 * idempotency (Stripe session or payment-intent id), so a repeated confirm never double-credits.
 */
async function creditUsdAsRupiah(user: User, waNumber: string, usd: number, txHash: string) {
  await ensureActivated(user);

  const mid = (await usdIdrMid()).rate;
  const cidrOut = refCidr(usd, mid);
  const savingsIdr = cidrOut - usd * (mid - MONEY_CHANGER_MARKDOWN);

  // Reserve the txHash before minting so a concurrent or replayed confirm can't double-credit.
  if (!(await reserveHash(waNumber, "deposit", `Added ${rupiah(cidrOut)}`, cidrOut, "in", txHash)))
    return { credited: false, usd, balances: await walletBalances(user.publicKey) };

  try {
    const distributor = Keypair.fromSecret(process.env.DISTRIBUTOR_SECRET!);
    await submit(distributor, (b) =>
      b.addOperation(
        Operation.payment({ destination: user.publicKey, asset: cIDR(), amount: cidrOut.toFixed(7) }),
      ),
    );
    return {
      credited: true,
      usd,
      cidr: cidrOut,
      rate: cidrOut / usd,
      savingsIdr,
      hash: txHash,
      balances: await walletBalances(user.publicKey),
    };
  } catch (e) {
    await releaseHash(txHash);
    throw e;
  }
}

app.post("/deposit/create", requireAuth, async (c) => {
  if (!stripe) return c.json({ error: "stripe not configured" }, 500);
  const waNumber = c.get("wa");
  const { usd } = await c.req.json();
  const user = await findUser(waNumber);
  if (!user) return c.json({ error: "not found" }, 404);
  const amount = Number(usd);
  if (!amount || amount <= 0) return c.json({ error: "amount required" }, 400);

  // Card money is credited at the reference rate (see creditUsdAsRupiah), so the tier limit
  // is measured against that — no DEX quote, no liquidity error before the user even pays.
  const cidrOut = refCidr(amount, (await usdIdrMid()).rate);

  // Serialize per user so parallel Checkout sessions can't collectively exceed the tier cap:
  // check the limit (which counts existing holds) and place this session's hold atomically.
  return withUserLock(waNumber, async () => {
    const limit = await checkDepositLimit(waNumber, cidrOut);
    if (!limit.ok) return c.json({ error: limit.error }, 403);

    // Save the card to a reusable customer so later top-ups need no card entry (/deposit/charge).
    const customer = await stripeCustomerFor(user);
    const session = await stripe!.checkout.sessions.create({
      mode: "payment",
      customer,
      payment_intent_data: { setup_future_usage: "off_session" },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: Math.round(amount * 100),
            product_data: {
              name: "Castel top-up",
              description: `Adds about ${rupiah(cidrOut)} to your Castel balance`,
            },
          },
        },
      ],
      success_url: `${WEB}/wallet?deposit={CHECKOUT_SESSION_ID}`,
      cancel_url: `${WEB}/wallet?deposit=cancel`,
      metadata: { waNumber, usd: String(amount) },
    });
    await placeHold(waNumber, HOLD_DEPOSIT, cidrOut, "in", session.id);
    return c.json({ url: session.url });
  });
});

// One-tap top-up once a card is on file: charge the saved card off-session, no redirect.
app.post("/deposit/charge", requireAuth, async (c) => {
  if (!stripe) return c.json({ error: "stripe not configured" }, 500);
  const waNumber = c.get("wa");
  const { usd, key } = await c.req.json();
  const amount = Number(usd);
  if (!amount || amount <= 0) return c.json({ error: "amount required" }, 400);

  const user = await findUser(waNumber);
  if (!user) return c.json({ error: "not found" }, 404);
  if (!user.stripeCustomerId) return c.json({ error: "no saved card" }, 409);
  const card = await savedCard(user.stripeCustomerId);
  if (!card) return c.json({ error: "no saved card" }, 409);

  const cidrOut = refCidr(amount, (await usdIdrMid()).rate);
  const limit = await checkDepositLimit(waNumber, cidrOut);
  if (!limit.ok) return c.json({ error: limit.error }, 403);

  let intent: Stripe.PaymentIntent;
  try {
    intent = await stripe.paymentIntents.create(
      {
        amount: Math.round(amount * 100),
        currency: "usd",
        customer: user.stripeCustomerId,
        payment_method: card.id,
        off_session: true,
        confirm: true,
        metadata: { waNumber, usd: String(amount) },
      },
      // A client key makes a retry reuse the SAME PaymentIntent instead of charging the card
      // again if the first response was lost. (Idempotency keys expire after ~24h on Stripe.)
      typeof key === "string" && key ? { idempotencyKey: `charge:${key}` } : undefined,
    );
  } catch (e) {
    // A card that now needs re-authentication (SCA) can't be charged silently — fall back to Checkout.
    return c.json({ error: "card needs re-entry", useCheckout: true, detail: (e as Error).message }, 402);
  }
  if (intent.status !== "succeeded")
    return c.json({ error: "card needs re-entry", useCheckout: true, status: intent.status }, 402);

  return c.json(await creditUsdAsRupiah(user, waNumber, amount, intent.id));
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

  // The session is paid: its limit hold has done its job — the real deposit row now counts.
  await releaseHold(sessionId);

  // Remember the customer so subsequent top-ups can reuse the card Checkout just saved.
  if (session.customer && !user.stripeCustomerId) {
    const id = typeof session.customer === "string" ? session.customer : session.customer.id;
    await db.update(users).set({ stripeCustomerId: id }).where(eq(users.id, user.id));
  }

  const usd = Number(session.metadata?.usd ?? (session.amount_total ?? 0) / 100);
  return c.json(await creditUsdAsRupiah(user, waNumber, usd, sessionId));
});

// USDC on-ramp for crypto-native users: they send USDC to their Castel address, then this
// converts whatever USDC has arrived into rupiah on the DEX. No card involved.
app.post("/deposit/usdc/convert", requireAuth, async (c) => {
  const waNumber = c.get("wa");
  const user = await walletUser(waNumber);
  if (!user) return c.json({ error: "not found" }, 404);

  const usdc = Number((await walletBalances(user.publicKey)).USDC);
  if (usdc <= 0)
    return c.json({ error: "no USDC received yet — send USDC to your address, then try again" }, 400);

  const quote = await quoteUsdcToCidr(usdc).catch(() => null);
  const idrValue = quote?.cidrOut ?? usdc * (await usdIdrMid()).rate;
  const limit = await checkDepositLimit(waNumber, idrValue);
  if (!limit.ok) return c.json({ error: limit.error }, 403);
  if (!quote) return c.json({ error: "that amount is too large to exchange right now" }, 400);

  const { hash, quote: q } = await swapUsdcToCidr(Keypair.fromSecret(user.secret), usdc);
  await recordTx(waNumber, "deposit", `Added ${rupiah(q.cidrOut)} (USDC)`, q.cidrOut, "in", hash);
  return c.json({
    credited: true,
    usdc,
    cidr: q.cidrOut,
    savingsIdr: q.savingsIdr,
    hash,
    balances: await walletBalances(user.publicKey),
  });
});

// --- Real USDC on-ramp: connect a Stellar wallet (Freighter) and send Circle testnet USDC ---

/** Castel's margin on the crypto on-ramp, applied against the live mid — same as the DEX book. */
const CIRCLE_SPREAD_BPS = 30;

// Prepare the account to receive Circle USDC: ensure its trustline exists (older accounts and
// new ones alike), and hand back the address + asset the wallet should send to.
app.post("/deposit/circle/prepare", requireAuth, async (c) => {
  const user = await walletUser(c.get("wa"));
  if (!user) return c.json({ error: "not found" }, 404);
  await trustCircleUsdc(user.secret);
  return c.json({
    publicKey: user.publicKey,
    asset: { code: "USDC", issuer: CIRCLE_USDC_ISSUER },
  });
});

// Convert Circle USDC that has arrived at the user's Castel account into rupiah. Anchor-style:
// the treasury takes the USDC as reserve and cIDR is issued at the reference rate — no DEX,
// because a Circle-USDC/cIDR order book can't be seeded from a rate-limited faucet.
app.post("/deposit/circle/convert", requireAuth, async (c) => {
  const waNumber = c.get("wa");
  const user = await findUser(waNumber);
  if (!user) return c.json({ error: "not found" }, 404);

  // Serialize per account so two concurrent converts can't both read the same USDC balance
  // and both mint. Combined with sweep-before-issue below, the on-chain balance is itself the
  // idempotency key: once swept it reads 0, so a retry can't double-mint.
  return withUserLock(user.publicKey, async () => {
    const usdc = Number(await circleUsdcBalance(user.publicKey));
    if (usdc <= 0)
      return c.json({ error: "no USDC received yet — send USDC to your Castel address first" }, 400);

    const mid = (await usdIdrMid()).rate;
    const cidrOut = Math.round((usdc * mid * (10_000 - CIRCLE_SPREAD_BPS)) / 10_000);
    const savingsIdr = cidrOut - usdc * (mid - MONEY_CHANGER_MARKDOWN);

    const limit = await checkDepositLimit(waNumber, cidrOut);
    if (!limit.ok) return c.json({ error: limit.error }, 403);

    // Sweep the USDC into the treasury as the reserve FIRST — this zeroes the user's USDC
    // balance, so any retry sees 0 and cannot double-mint. Then issue the matching cIDR.
    const sweep = await submit(Keypair.fromSecret(user.secret), (b) =>
      b.addOperation(
        Operation.payment({
          destination: process.env.TREASURY_PUBLIC!,
          asset: circleUSDC(),
          amount: usdc.toFixed(7),
        }),
      ),
    );
    const distributor = Keypair.fromSecret(process.env.DISTRIBUTOR_SECRET!);
    await submit(distributor, (b) =>
      b.addOperation(
        Operation.payment({ destination: user.publicKey, asset: cIDR(), amount: cidrOut.toFixed(7) }),
      ),
    );

    await recordTx(waNumber, "deposit", `Added ${rupiah(cidrOut)} (USDC)`, cidrOut, "in", sweep.hash);
    return c.json({
      credited: true,
      usdc,
      cidr: cidrOut,
      savingsIdr,
      hash: sweep.hash,
      balances: await walletBalances(user.publicKey),
    });
  });
});

// --- Native XLM on-ramp: connect a Stellar wallet (Freighter) and send real testnet XLM ---
// XLM needs no trustline, and an already-funded account can't be "swept" (it holds friendbot
// XLM), so instead the wallet pays XLM straight to the treasury and we verify that payment by
// its hash — then credit cIDR at the live XLM→USD→IDR reference rate. Showcases native Stellar.
const XLM_SPREAD_BPS = 30;

app.post("/deposit/xlm/prepare", requireAuth, async (c) => {
  const user = await walletUser(c.get("wa"));
  if (!user) return c.json({ error: "not found" }, 404);
  // The wallet must stamp this MEMO_ID on the XLM payment so convert can bind it to THIS user —
  // without it, anyone could claim any XLM that reached the treasury by submitting its hash.
  return c.json({ destination: process.env.TREASURY_PUBLIC!, memo: String(user.id) });
});

app.post("/deposit/xlm/convert", requireAuth, async (c) => {
  const waNumber = c.get("wa");
  const user = await walletUser(waNumber);
  if (!user) return c.json({ error: "not found" }, 404);

  const { hash } = await c.req.json().catch(() => ({}));
  if (!hash || typeof hash !== "string") return c.json({ error: "hash required" }, 400);

  // One credit per on-chain payment — a replayed hash never double-credits.
  const already = (await db.select().from(transactions).where(eq(transactions.hash, hash)))[0];
  if (already) return c.json({ error: "this deposit was already credited" }, 409);

  // Verify on-chain: the hash must carry a native-XLM payment into the treasury AND be tagged
  // with this user's MEMO_ID (set by /deposit/xlm/prepare). The memo is what binds the payment
  // to the caller — the `to` alone would let anyone claim any XLM the treasury ever received.
  const treasuryPub = process.env.TREASURY_PUBLIC!;
  let xlm = 0;
  let memoOk = false;
  try {
    const [tx, ops] = await Promise.all([
      horizon.transactions().transaction(hash).call(),
      horizon.operations().forTransaction(hash).limit(50).call(),
    ]);
    memoOk = tx.memo_type === "id" && tx.memo === String(user.id);
    const pay = ops.records.find(
      (o: any) => o.type === "payment" && o.asset_type === "native" && o.to === treasuryPub,
    ) as any;
    xlm = pay ? Number(pay.amount) : 0;
  } catch {
    return c.json({ error: "couldn't find that transaction yet — try again in a moment" }, 400);
  }
  if (xlm <= 0) return c.json({ error: "no XLM payment to Castel found in that transaction" }, 400);
  if (!memoOk)
    return c.json(
      { error: "this XLM payment isn't tagged to your account — deposit from the Castel app" },
      403,
    );

  const usdValue = xlm * (await xlmUsd()).rate;
  const mid = (await usdIdrMid()).rate;
  const cidrOut = Math.round((usdValue * mid * (10_000 - XLM_SPREAD_BPS)) / 10_000);
  const savingsIdr = cidrOut - usdValue * (mid - MONEY_CHANGER_MARKDOWN);

  const limit = await checkDepositLimit(waNumber, cidrOut);
  if (!limit.ok) return c.json({ error: limit.error }, 403);

  // Reserve the tx hash before minting so a concurrent/replayed convert can't double-credit.
  if (!(await reserveHash(waNumber, "deposit", `Added ${rupiah(cidrOut)} (XLM)`, cidrOut, "in", hash)))
    return c.json({ error: "this deposit was already credited" }, 409);

  // The XLM is already in the treasury (the reserve); issue the matching cIDR to the user.
  try {
    const distributor = Keypair.fromSecret(process.env.DISTRIBUTOR_SECRET!);
    await submit(distributor, (b) =>
      b.addOperation(
        Operation.payment({ destination: user.publicKey, asset: cIDR(), amount: cidrOut.toFixed(7) }),
      ),
    );
  } catch (e) {
    await releaseHash(hash);
    throw e;
  }
  return c.json({
    credited: true,
    xlm,
    cidr: cidrOut,
    savingsIdr,
    hash,
    balances: await walletBalances(user.publicKey),
  });
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

  // Size the charge off the reference rate the card credit executes at (see creditUsdAsRupiah),
  // over-funded by the buffer so rounding can't leave the bill short. No DEX dependency.
  const mid = (await usdIdrMid()).rate;
  const refRate = (mid * (10_000 - REFERENCE_SPREAD_BPS)) / 10_000;
  const usd = Math.ceil((amountIdr / refRate) * (1 + QUICKPAY_BUFFER) * 100) / 100;

  // Serialize per user so parallel quick-pay sessions can't collectively exceed the tier caps:
  // check the spend + deposit limits (counting holds) and place this session's hold atomically.
  return withUserLock(waNumber, async () => {
    const spend = await checkSpendLimit(waNumber, amountIdr);
    if (!spend.ok) return c.json({ error: spend.error }, 403);
    const dep = await checkDepositLimit(waNumber, amountIdr);
    if (!dep.ok) return c.json({ error: dep.error }, 403);

    const session = await stripe!.checkout.sessions.create({
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
      // Lock the create-time rate into the session so confirm credits at the SAME rate the charge
      // was sized against — otherwise a rate move before confirm could under-fund the bill.
      metadata: {
        waNumber,
        usd: String(usd),
        mid: String(mid),
        quickPayload: String(payload),
        quickAmountIdr: String(amountIdr),
      },
    });
    await placeHold(waNumber, HOLD_SPEND, amountIdr, "out", session.id);
    return c.json({ url: session.url, usd, amountIdr });
  });
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

  const user = await walletUser(waNumber);
  if (!user) return c.json({ error: "not found" }, 404);

  // The session is paid: its limit hold has done its job — the real quickpay row now counts.
  await releaseHold(sessionId);

  const usd = Number(session.metadata?.usd ?? 0);
  const payload = String(session.metadata?.quickPayload ?? "");
  const amountIdr = Number(session.metadata?.quickAmountIdr ?? 0);
  const info = parseQris(payload);
  const userKp = Keypair.fromSecret(user.secret);

  // Deterministic per-session settlement id: Xendit dedups on external_id, so re-attempting the
  // settlement (e.g. on an alreadyPaid retry after a first failure) never double-disburses.
  const externalId = `castel-quick-${sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 28)}`;
  const settle = async (): Promise<Settlement | { error: string } | null> => {
    if (!xenditEnabled()) return null;
    try {
      return await settleToMerchant({ externalId, amountIdr, merchantName: info.merchantName });
    } catch (e) {
      return { error: (e as Error).message };
    }
  };

  // The card-charge leg: reserve the session marker BEFORE minting so a concurrent redirect
  // (two tabs / a retry) can't issue cIDR twice for one card charge.
  if (await reserveHash(waNumber, "deposit", `Card charge · ${info.merchantName}`, 0, "in", sessionId)) {
    try {
      // Direct-rupiah: the card money is the reserve, so issue cIDR straight to the user at the
      // rate locked in at create (falling back to the live mid for older sessions) — so the
      // credited cIDR always covers the bill the charge was sized for.
      const lockedMid = Number(session.metadata?.mid) || (await usdIdrMid()).rate;
      const cidrOut = refCidr(usd, lockedMid);
      const distributor = Keypair.fromSecret(process.env.DISTRIBUTOR_SECRET!);
      await submit(distributor, (b) =>
        b.addOperation(
          Operation.payment({ destination: user.publicKey, asset: cIDR(), amount: cidrOut.toFixed(7) }),
        ),
      );
    } catch (e) {
      await releaseHash(sessionId);
      throw e;
    }
  }

  // The merchant-payment leg: reserve its own marker BEFORE submitting, so a concurrent or
  // replayed confirm can't pay the merchant twice.
  const payHash = `${sessionId}:pay`;
  if (!(await reserveHash(waNumber, "quickpay", info.merchantName, 0, "out", payHash))) {
    return c.json({
      merchant: info.merchantName,
      city: info.city,
      amountIdr,
      alreadyPaid: true,
      // Re-attempt settlement in case the first confirm paid on-chain but the disbursement failed.
      settlement: await settle(),
      balances: await walletBalances(user.publicKey),
    });
  }

  let res;
  try {
    res = await submit(userKp, (b) =>
      b.addOperation(
        Operation.payment({
          destination: process.env.TREASURY_PUBLIC!,
          asset: cIDR(),
          amount: amountIdr.toFixed(7),
        }),
      ),
    );
  } catch (e) {
    await releaseHash(payHash);
    throw e;
  }
  // The visible row carries the real Stellar hash so it links on-chain (the payHash marker
  // above is the hidden zero-amount idempotency guard).
  await recordTx(waNumber, "quickpay", info.merchantName, amountIdr, "out", res.hash);

  return c.json({
    merchant: info.merchantName,
    city: info.city,
    amountIdr,
    hash: res.hash,
    settlement: await settle(),
    balances: await walletBalances(user.publicKey),
  });
});

app.post("/fx/swap", requireAuth, async (c) => {
  const waNumber = c.get("wa");
  const { usdc } = await c.req.json();
  const amount = Number(usdc);
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: "usdc required" }, 400);
  const user = await walletUser(waNumber);
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
  const { payload, amount, pin, key } = await c.req.json();
  const user = await walletUser(waNumber);
  if (!user) return c.json({ error: "not found" }, 404);

  const pinError = await checkPin(user, pin);
  if (pinError) return c.json({ error: pinError }, 403);

  const info = parseQris(payload);
  const amountIdr = info.amount ?? Number(amount);
  if (!amountIdr || amountIdr <= 0) return c.json({ error: "amount required" }, 400);

  // Idempotency: reserve the client key before submitting so a retry/double-tap can't pay the
  // merchant twice. A repeat with the same key short-circuits to "already paid".
  const guard = typeof key === "string" && key ? `pay:${key}` : null;
  if (guard && !(await reserveHash(waNumber, "pay", info.merchantName, 0, "out", guard)))
    return c.json({
      merchant: info.merchantName,
      city: info.city,
      amountIdr,
      alreadyPaid: true,
      settlement: null,
      balances: await walletBalances(user.publicKey),
    });

  try {
    const limit = await checkSpendLimit(waNumber, amountIdr);
    if (!limit.ok) {
      if (guard) await releaseHash(guard);
      return c.json({ error: limit.error }, 403);
    }

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

    // Settle IDR to the merchant via Xendit sandbox. Non-fatal (the on-chain debit already
    // succeeded); a deterministic external_id keyed on the payment lets Xendit dedup a retry.
    let settlement: Settlement | { error: string } | null = null;
    if (xenditEnabled()) {
      try {
        settlement = await settleToMerchant({
          externalId: `castel-pay-${(key ?? res.hash).replace(/[^a-zA-Z0-9]/g, "").slice(0, 28)}`,
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
  } catch (e) {
    if (guard) await releaseHash(guard);
    throw e;
  }
});

const CASHOUT_FEE_BPS = 100;
const agentFee = (amountIdr: number) => Math.round((amountIdr * CASHOUT_FEE_BPS) / 10000);

app.post("/cashout/request", requireAuth, async (c) => {
  const waNumber = c.get("wa");
  const { amountIdr, pin } = await c.req.json();
  const user = await walletUser(waNumber);
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
  // Hide zero-amount rows: these are internal idempotency markers (the quick-pay "Card charge"
  // and merchant-payment guards), never something a user should see as a "Rp 0" line.
  const rows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.waNumber, c.get("wa")),
        ne(transactions.amountIdr, 0),
        notInArray(transactions.type, HOLD_TYPES),
      ),
    )
    .orderBy(desc(transactions.createdAt))
    .limit(25);
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

  const user = await ensureUser(waNumber);

  // Checked before everything else: a frozen account is exactly the case where the person
  // typing may not be the owner, so nothing else should answer until it's resolved.
  if (/^(unfreeze|unblock|buka blokir)/.test(t)) {
    if (!user.frozen) return "Your account isn't frozen.";
    await db.update(users).set({ frozen: false }).where(eq(users.id, user.id));
    return "✅ Spending is unfrozen. If you haven't already, send *forgot pin* to set a PIN only you know.";
  }
  if (/^(block|blokir|freeze)/.test(t)) {
    await db.update(users).set({ frozen: true }).where(eq(users.id, user.id));
    return "🛑 Spending is frozen. Nobody can pay or withdraw from this account.\n\nSend *forgot pin* to set a new PIN, then *unfreeze* when you're ready.";
  }
  if (/^(forgot|lupa|reset)/.test(t)) {
    const res = await sendPinResetLink(waNumber);
    return res.sent
      ? "🔑 Sent you a reset link — it works once and expires in 15 minutes."
      : `⚠️ ${res.error}`;
  }
  if (user.frozen)
    return "🛑 This account is frozen. Send *forgot pin* to set a new PIN, then *unfreeze*.";

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
  return `👋 Welcome to *Castel* — fair-rate rupiah for Bali, no bank needed.\n\nTry:\n• *balance* — see your rupiah\n• *topup* — add rupiah with your card\n• *pay* — scan & pay any QRIS merchant\n• *cash* — withdraw cash at an agent\n• *forgot pin* — set a new payment PIN`;
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
