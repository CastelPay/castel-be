import { describe, expect, test } from "bun:test";
import { buildQuote } from "./fx";

describe("buildQuote", () => {
  test("computes the Castel rate from the on-chain cIDR output", () => {
    const q = buildQuote(200, 3_290_000);
    expect(q.rate).toBe(16450);
  });

  test("computes savings versus the money-changer rate", () => {
    const q = buildQuote(200, 3_290_000);
    expect(q.changerRate).toBe(16300);
    expect(q.changerCidr).toBe(3_260_000);
    expect(q.savingsIdr).toBe(30_000);
  });

  test("savings scale with the amount exchanged", () => {
    expect(buildQuote(100, 1_645_000).savingsIdr).toBe(15_000);
  });

  test("a worse on-chain rate yields smaller savings", () => {
    const q = buildQuote(200, 3_270_000);
    expect(q.savingsIdr).toBe(10_000);
  });
});
