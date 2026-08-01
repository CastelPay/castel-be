import { describe, expect, test } from "bun:test";
import { pinProblem, PIN_RESET_TTL_MS, signToken, verifyToken } from "./auth";

describe("pinProblem", () => {
  test("accepts an unpredictable 6-digit pin", () => {
    expect(pinProblem("394027")).toBeNull();
    expect(pinProblem("246810")).toBeNull();
  });

  test("rejects anything that isn't 6 digits", () => {
    for (const pin of ["", "12345", "1234567", "12a456", "  1234"]) {
      expect(pinProblem(pin)).toBe("pin must be 6 digits");
    }
  });

  test("rejects the guesses an attacker tries first", () => {
    for (const pin of ["000000", "111111", "999999"]) {
      expect(pinProblem(pin)).toMatch(/repeat one digit/);
    }
    for (const pin of ["123456", "012345", "654321", "987654"]) {
      expect(pinProblem(pin)).toMatch(/digits in a row/);
    }
  });
});

describe("pinreset tokens", () => {
  const WA = "+6281200000000";

  test("round-trips only as its own kind", () => {
    const token = signToken(WA, "pinreset", PIN_RESET_TTL_MS);
    expect(verifyToken(token, "pinreset")).toBe(WA);
    // A reset link must not double as a login, and a magic link must not reset a PIN.
    expect(verifyToken(token, "session")).toBeNull();
    expect(verifyToken(token, "link")).toBeNull();
    expect(verifyToken(signToken(WA, "link", 60_000), "pinreset")).toBeNull();
  });

  test("rejects an expired or tampered token", () => {
    expect(verifyToken(signToken(WA, "pinreset", -1), "pinreset")).toBeNull();
    const token = signToken(WA, "pinreset", PIN_RESET_TTL_MS);
    expect(verifyToken(token.slice(0, -2) + "xy", "pinreset")).toBeNull();
  });
});
