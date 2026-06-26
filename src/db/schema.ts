import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  waNumber: text("wa_number").notNull().unique(),
  publicKey: text("public_key").notNull(),
  secret: text("secret").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const transactions = sqliteTable("transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  waNumber: text("wa_number").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  amountIdr: integer("amount_idr").notNull(),
  direction: text("direction").notNull(),
  hash: text("hash"),
  createdAt: integer("created_at").notNull(),
});

export const cashouts = sqliteTable("cashouts", {
  escrowId: integer("escrow_id").primaryKey(),
  waNumber: text("wa_number").notNull(),
  amountIdr: integer("amount_idr").notNull(),
  codeHex: text("code_hex").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: integer("created_at").notNull(),
});
