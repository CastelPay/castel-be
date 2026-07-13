import { bigint, integer, pgTable, serial, text } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  waNumber: text("wa_number").notNull().unique(),
  publicKey: text("public_key").notNull(),
  secret: text("secret").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
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
