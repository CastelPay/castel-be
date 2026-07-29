import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required (Postgres connection string)");

// prepare:false keeps this compatible with Neon's pgbouncer pooler endpoint.
const sql = postgres(url, { ssl: "require", max: 5, prepare: false });

await sql`CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  wa_number TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  secret TEXT NOT NULL,
  created_at BIGINT NOT NULL
)`;
await sql`CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  wa_number TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  amount_idr BIGINT NOT NULL,
  direction TEXT NOT NULL,
  hash TEXT,
  created_at BIGINT NOT NULL
)`;
await sql`CREATE TABLE IF NOT EXISTS cashouts (
  escrow_id INTEGER PRIMARY KEY,
  wa_number TEXT NOT NULL,
  amount_idr BIGINT NOT NULL,
  code_hex TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL
)`;

for (const col of [
  "pin_hash TEXT",
  "pin_attempts INTEGER NOT NULL DEFAULT 0",
  "otp_hash TEXT",
  "otp_expires BIGINT",
  "otp_attempts INTEGER NOT NULL DEFAULT 0",
  "stripe_customer_id TEXT",
  "activated BOOLEAN NOT NULL DEFAULT FALSE",
]) {
  await sql.unsafe(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col}`);
}

await sql`CREATE TABLE IF NOT EXISTS rates (
  id SERIAL PRIMARY KEY,
  usd_idr NUMERIC NOT NULL,
  fetched_at BIGINT NOT NULL
)`;

// Deposit idempotency is keyed on the Stripe session id stored in `hash`. The
// read-then-write check in /deposit/confirm races with itself on a double redirect,
// so the database is the thing that actually has to enforce "credit once".
await sql`CREATE UNIQUE INDEX IF NOT EXISTS transactions_hash_uniq
  ON transactions (hash) WHERE hash IS NOT NULL`;

export const db = drizzle(sql, { schema });
export { schema };
