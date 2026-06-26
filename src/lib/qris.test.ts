import { describe, expect, test } from "bun:test";
import { parseQris } from "./qris";

const DYNAMIC = "00020101021253033605405850005802ID5916Warung Made Bali6004Bali6304ABCD";
const STATIC = "00020101021153033605802ID5916Warung Made Bali6004Bali6304ABCD";

describe("parseQris", () => {
  test("parses a dynamic QRIS with an embedded amount", () => {
    const r = parseQris(DYNAMIC);
    expect(r.merchantName).toBe("Warung Made Bali");
    expect(r.city).toBe("Bali");
    expect(r.amount).toBe(85000);
    expect(r.currency).toBe("IDR");
    expect(r.isStatic).toBe(false);
  });

  test("flags a static QRIS (no amount) as isStatic", () => {
    const r = parseQris(STATIC);
    expect(r.amount).toBeNull();
    expect(r.isStatic).toBe(true);
    expect(r.merchantName).toBe("Warung Made Bali");
  });

  test("falls back to a default merchant name when tag 59 is missing", () => {
    expect(parseQris("000201010212").merchantName).toBe("Unknown Merchant");
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseQris(`  ${DYNAMIC}  `).amount).toBe(85000);
  });

  test("maps currency 360 to IDR", () => {
    expect(parseQris(DYNAMIC).currency).toBe("IDR");
  });
});
