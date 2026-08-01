import { boolean, bigint, integer, numeric, pgTable, serial, text } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  waNumber: text("wa_number").notNull().unique(),
  publicKey: text("public_key").notNull(),
  secret: text("secret").notNull(),
  // Whether the on-chain account has been funded + given its trustlines (done lazily after
  // sign-up so the OTP isn't blocked on it).
  activated: boolean("activated").notNull().default(false),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  pinHash: text("pin_hash"),
  pinAttempts: integer("pin_attempts").notNull().default(0),
  otpHash: text("otp_hash"),
  otpExpires: bigint("otp_expires", { mode: "number" }),
  otpAttempts: integer("otp_attempts").notNull().default(0),
  // A forgotten PIN is recovered through a single-use link sent over WhatsApp. Storing the
  // hash (not the token) is what makes it single-use: redeeming clears it, so a replayed
  // link — from a forwarded chat or a shoulder-surfed screen — no longer matches anything.
  pinResetHash: text("pin_reset_hash"),
  pinResetExpires: bigint("pin_reset_expires", { mode: "number" }),
  pinChangedAt: bigint("pin_changed_at", { mode: "number" }),
  // Set by the owner replying BLOCK to the "your PIN was changed" alert: the escape hatch
  // when the reset was someone else's doing.
  frozen: boolean("frozen").notNull().default(false),
  stripeCustomerId: text("stripe_customer_id"),
});

export const transactions = pgTable("transactions", {
  id: serial("id").primaryKey(),
  waNumber: text("wa_number").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  amountIdr: bigint("amount_idr", { mode: "number" }).notNull(),
  direction: text("direction").notNull(),
  hash: text("hash"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const cashouts = pgTable("cashouts", {
  escrowId: integer("escrow_id").primaryKey(),
  waNumber: text("wa_number").notNull(),
  amountIdr: bigint("amount_idr", { mode: "number" }).notNull(),
  codeHex: text("code_hex").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// The last known USD/IDR mid, so a cold start (which wipes the in-memory cache) recovers a
// real rate instead of falling back to a constant that is wrong the moment it is written.
export const rates = pgTable("rates", {
  id: serial("id").primaryKey(),
  usdIdr: numeric("usd_idr").notNull(),
  fetchedAt: bigint("fetched_at", { mode: "number" }).notNull(),
});
