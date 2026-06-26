import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

const path = process.env.DATABASE_URL?.replace("file:", "") ?? "castel.db";
const sqlite = new Database(path);
sqlite.run(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_number TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  secret TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);
sqlite.run(`CREATE TABLE IF NOT EXISTS cashouts (
  escrow_id INTEGER PRIMARY KEY,
  wa_number TEXT NOT NULL,
  amount_idr INTEGER NOT NULL,
  code_hex TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
)`);

export const db = drizzle(sqlite, { schema });
export { schema };
