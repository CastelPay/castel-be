import { Keypair, Operation } from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "./db";
import { users } from "./db/schema";
import { submit, USDC } from "./lib/stellar";
import { createWallet, walletBalances } from "./services/custody";
import { quoteUsdcToCidr, swapUsdcToCidr } from "./services/fx";

const app = new Hono();

const findUser = async (waNumber: string) =>
  (await db.select().from(users).where(eq(users.waNumber, waNumber)))[0];

app.get("/", (c) => c.json({ ok: true, service: "castel-be" }));

app.post("/onboard", async (c) => {
  const { waNumber } = await c.req.json();
  if (!waNumber) return c.json({ error: "waNumber required" }, 400);
  let user = await findUser(waNumber);
  if (!user) {
    const wallet = await createWallet();
    await db.insert(users).values({
      waNumber,
      publicKey: wallet.publicKey,
      secret: wallet.secret,
      createdAt: Date.now(),
    });
    user = await findUser(waNumber);
  }
  return c.json({ waNumber, publicKey: user!.publicKey });
});

app.get("/balance/:waNumber", async (c) => {
  const user = await findUser(c.req.param("waNumber"));
  if (!user) return c.json({ error: "not found" }, 404);
  return c.json(await walletBalances(user.publicKey));
});

app.get("/fx/quote", async (c) => {
  const usdc = Number(c.req.query("usdc") ?? "0");
  if (!usdc) return c.json({ error: "usdc query param required" }, 400);
  return c.json(await quoteUsdcToCidr(usdc));
});

app.post("/fund", async (c) => {
  const { waNumber, usdc } = await c.req.json();
  const user = await findUser(waNumber);
  if (!user) return c.json({ error: "not found" }, 404);
  const treasury = Keypair.fromSecret(process.env.TREASURY_SECRET!);
  await submit(treasury, (b) =>
    b.addOperation(
      Operation.payment({ destination: user.publicKey, asset: USDC(), amount: String(usdc) }),
    ),
  );
  return c.json(await walletBalances(user.publicKey));
});

app.post("/fx/swap", async (c) => {
  const { waNumber, usdc } = await c.req.json();
  const user = await findUser(waNumber);
  if (!user) return c.json({ error: "not found" }, 404);
  const hash = await swapUsdcToCidr(Keypair.fromSecret(user.secret), Number(usdc));
  return c.json({ hash, balances: await walletBalances(user.publicKey) });
});

export default { port: Number(process.env.PORT ?? 3001), fetch: app.fetch };
