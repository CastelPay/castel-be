import { describe, expect, test } from "bun:test";
import { buildQuote } from "./fx";
import type { Mid } from "../lib/rates";

const mid = (rate: number): Mid => ({ rate, source: "live", at: 0 });

describe("buildQuote", () => {
  test("the Castel rate comes from the on-chain cIDR output, not the reference rate", () => {
    const q = buildQuote(200, 3_290_000, mid(16_500));
    expect(q.rate).toBe(16_450);
  });

  test("savings are measured against the live mid, minus the money-changer markdown", () => {
    const q = buildQuote(200, 3_290_000, mid(16_500));
    expect(q.changerRate).toBe(16_300);
    expect(q.changerCidr).toBe(3_260_000);
    expect(q.savingsIdr).toBe(30_000);
  });

  test("a stronger dollar moves the money-changer benchmark with it", () => {
    const q = buildQuote(200, 3_290_000, mid(18_000));
    expect(q.changerRate).toBe(17_800);
    // The order book is now well below the market, so there is nothing to save.
    expect(q.savingsIdr).toBeLessThan(0);
  });

  test("savings scale with the amount exchanged", () => {
    expect(buildQuote(100, 1_645_000, mid(16_500)).savingsIdr).toBe(15_000);
  });

  test("a worse on-chain rate yields smaller savings", () => {
    expect(buildQuote(200, 3_270_000, mid(16_500)).savingsIdr).toBe(10_000);
  });
});
