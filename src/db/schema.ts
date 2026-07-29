import { bigint, integer, numeric, pgTable, serial, text } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  waNumber: text("wa_number").notNull().unique(),
  publicKey: text("public_key").notNull(),
  secret: text("secret").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  pinHash: text("pin_hash"),
  pinAttempts: integer("pin_attempts").notNull().default(0),
  otpHash: text("otp_hash"),
  otpExpires: bigint("otp_expires", { mode: "number" }),
  otpAttempts: integer("otp_attempts").notNull().default(0),
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
