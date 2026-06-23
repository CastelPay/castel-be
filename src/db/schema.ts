import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  waNumber: text("wa_number").notNull().unique(),
  publicKey: text("public_key").notNull(),
  secret: text("secret").notNull(),
  createdAt: integer("created_at").notNull(),
});
