/**
 * Delete legacy display rows from before the card→direct-rupiah change: the old
 * "Deposited $N (card)" format (wrong rupiah amount) and "... (exchange pending)" markers
 * from card top-ups that couldn't auto-convert on a dry DEX. Transactions are display-only
 * (balances live on-chain), so removing them is cosmetic and safe.
 *
 *   bun run scripts/clean-legacy-txs.ts --dry   # list what would go
 *   bun run scripts/clean-legacy-txs.ts         # delete
 */
import { like, or } from "drizzle-orm";
import { db } from "../src/db";
import { transactions } from "../src/db/schema";

const DRY = process.argv.includes("--dry");

const junk = or(
  like(transactions.title, "Deposited %"),
  like(transactions.title, "%(exchange pending)%"),
);

async function main() {
  const rows = await db.select().from(transactions).where(junk);
  console.log(`Found ${rows.length} legacy junk row(s):`);
  for (const r of rows) console.log(`  [${r.id}] ${r.waNumber}  "${r.title}"  Rp${r.amountIdr}`);

  if (DRY) return console.log("\n(dry run — nothing deleted)");
  if (!rows.length) return console.log("nothing to delete");

  await db.delete(transactions).where(junk);
  console.log(`\n🧹 deleted ${rows.length} row(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("❌", e?.message ?? e);
    process.exit(1);
  });
