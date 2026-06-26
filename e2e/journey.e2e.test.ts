/**
 * End-to-end system test: the whole tourist journey through the real backend
 * (in-process via Hono app.fetch) against Stellar testnet. No browser, no server.
 *   bun run test:e2e
 */
import { describe, expect, test } from "bun:test";
import app from "../src/index";

const SAMPLE_QR = "00020101021253033605405850005802ID5916Warung Made Bali6004Bali6304ABCD";
const WA = "+62800" + Date.now().toString().slice(-7);

function call(path: string, body?: unknown, method = body ? "POST" : "GET") {
  return app.fetch(
    new Request("http://localhost" + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}
const json = async (p: ReturnType<typeof call>) => (await p).json();
const settle = () => new Promise((r) => setTimeout(r, 8000));

describe("full tourist journey", () => {
  test(
    "onboard → fund → swap → pay → cash-out → history",
    async () => {
      const onboard = await json(call("/onboard", { waNumber: WA }));
      expect(onboard.publicKey).toMatch(/^G[A-Z0-9]{55}$/);

      const funded = await json(call("/fund", { waNumber: WA, usdc: 200 }));
      expect(Number(funded.USDC)).toBeCloseTo(200, 0);

      const quote = await json(call("/fx/quote?usdc=200"));
      expect(quote.cidrOut).toBeGreaterThan(quote.changerCidr);
      expect(quote.savingsIdr).toBeGreaterThan(0);

      const swap = await json(call("/fx/swap", { waNumber: WA, usdc: 200 }));
      expect(swap.hash).toBeTruthy();
      expect(Number(swap.balances.cIDR)).toBeGreaterThan(3_000_000);
      await settle();

      const pay = await json(call("/pay", { waNumber: WA, payload: SAMPLE_QR }));
      expect(pay.merchant).toBe("Warung Made Bali");
      expect(pay.amountIdr).toBe(85000);
      await settle();

      const req = await json(call("/cashout/request", { waNumber: WA, amountIdr: 100000 }));
      expect(req.escrowId).toBeGreaterThan(0);
      expect(req.codeHex).toBeTruthy();

      await new Promise((r) => setTimeout(r, 9000));

      const redeem = await json(
        call("/cashout/redeem", { escrowId: req.escrowId, codeHex: req.codeHex }),
      );
      expect(redeem.agentReceived).toBe(99000);
      expect(redeem.fee).toBe(1000);

      const history = await json(call(`/history/${encodeURIComponent(WA)}`));
      const types = history.map((t: { type: string }) => t.type);
      expect(types).toContain("swap");
      expect(types).toContain("pay");
      expect(types).toContain("cashout");
    },
    180_000,
  );
});
