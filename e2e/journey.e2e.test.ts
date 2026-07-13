/**
 * End-to-end system test: the whole tourist journey through the real backend
 * (in-process via Hono app.fetch) against Stellar testnet. No browser, no server.
 *   bun run test:e2e
 */
import { describe, expect, test } from "bun:test";
import app from "../src/index";
import { LINK_TTL_MS, signToken } from "../src/lib/auth";

const SAMPLE_QR = "00020101021253033605405850005802ID5916Warung Made Bali6004Bali6304ABCD";
const WA = "+62800" + Date.now().toString().slice(-7);
const PIN = "246810";

function call(path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  return app.fetch(
    new Request("http://localhost" + path, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}
const json = async <T = any>(p: ReturnType<typeof call>): Promise<T> => (await p).json() as Promise<T>;
const settle = () => new Promise((r) => setTimeout(r, 8000));

describe("auth", () => {
  test("money routes reject unauthenticated callers", async () => {
    expect((await call("/me/balance")).status).toBe(401);
    expect((await call("/fx/swap", { usdc: 1 })).status).toBe(401);
    expect((await call("/pay", { payload: SAMPLE_QR })).status).toBe(401);
    expect((await call("/cashout/request", { amountIdr: 1000 })).status).toBe(401);
    expect((await call("/deposit/create", { usd: 10 })).status).toBe(401);
  });

  test("a forged token is rejected", async () => {
    const forged = Buffer.from(JSON.stringify({ wa: WA, exp: Date.now() + 60_000, kind: "session" }))
      .toString("base64url") + ".not-a-real-signature";
    expect((await call("/me/balance", undefined, forged)).status).toBe(401);
  });

  test("a link token cannot be used as a session token", async () => {
    const link = signToken(WA, "link", LINK_TTL_MS);
    expect((await call("/me/balance", undefined, link)).status).toBe(401);
  });

  test("an expired link token is rejected", async () => {
    const expired = signToken(WA, "link", -1000);
    expect((await call("/auth/exchange", { linkToken: expired })).status).toBe(401);
  });
});

describe("full tourist journey", () => {
  test(
    "magic link → PIN → fund → swap → pay → cash-out → history",
    async () => {
      // Tapping the WhatsApp magic link is what proves ownership of the number.
      const session = await json(
        call("/auth/exchange", { linkToken: signToken(WA, "link", LINK_TTL_MS) }),
      );
      expect(session.publicKey).toMatch(/^G[A-Z0-9]{55}$/);
      expect(session.hasPin).toBe(false);
      const token = session.token as string;

      const funded = await json(call("/fund", { usdc: 200 }, token));
      expect(Number(funded.USDC)).toBeCloseTo(200, 0);

      const quote = await json(call("/fx/quote?usdc=200"));
      expect(quote.cidrOut).toBeGreaterThan(quote.changerCidr);
      expect(quote.savingsIdr).toBeGreaterThan(0);

      const swap = await json(call("/fx/swap", { usdc: 200 }, token));
      expect(swap.hash).toBeTruthy();
      expect(Number(swap.balances.cIDR)).toBeGreaterThan(3_000_000);
      await settle();

      // Spending is blocked until a PIN exists, and blocked again if it is wrong.
      const noPin = await call("/pay", { payload: SAMPLE_QR }, token);
      expect(noPin.status).toBe(403);
      expect(((await noPin.json()) as any).error).toBe("pin not set");

      expect((await call("/me/pin", { pin: "12345" }, token)).status).toBe(400);
      expect((await call("/me/pin", { pin: PIN }, token)).status).toBe(200);
      expect((await call("/me/pin", { pin: "999999" }, token)).status).toBe(409);

      const wrongPin = await call("/pay", { payload: SAMPLE_QR, pin: "000000" }, token);
      expect(wrongPin.status).toBe(403);
      expect(((await wrongPin.json()) as any).error).toBe("wrong pin");

      const pay = await json(call("/pay", { payload: SAMPLE_QR, pin: PIN }, token));
      expect(pay.merchant).toBe("Warung Made Bali");
      expect(pay.amountIdr).toBe(85000);
      await settle();

      const req = await json(call("/cashout/request", { amountIdr: 100000, pin: PIN }, token));
      expect(req.escrowId).toBeGreaterThan(0);
      expect(req.codeHex).toBeTruthy();

      await new Promise((r) => setTimeout(r, 9000));

      const redeem = await json(
        call("/cashout/redeem", { escrowId: req.escrowId, codeHex: req.codeHex }),
      );
      expect(redeem.agentReceived).toBe(99000);
      expect(redeem.fee).toBe(1000);

      const history = await json(call("/me/history", undefined, token));
      const types = history.map((t: { type: string }) => t.type);
      expect(types).toContain("swap");
      expect(types).toContain("pay");
      expect(types).toContain("cashout");
    },
    180_000,
  );
});
