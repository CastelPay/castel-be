import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

const SECRET = process.env.SESSION_SECRET;
if (!SECRET) throw new Error("SESSION_SECRET is required (32+ random chars)");

export const LINK_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 24 * 60 * 60_000;
export const OTP_TTL_MS = 5 * 60_000;
export const PIN_RESET_TTL_MS = 15 * 60_000;
export const MAX_OTP_ATTEMPTS = 5;
export const MAX_PIN_ATTEMPTS = 5;

type Kind = "link" | "session" | "pinreset";
type Claims = { wa: string; exp: number; kind: Kind };

const hmac = (body: string) => createHmac("sha256", SECRET).update(body).digest("base64url");

export function signToken(wa: string, kind: Kind, ttlMs: number): string {
  const body = Buffer.from(JSON.stringify({ wa, exp: Date.now() + ttlMs, kind })).toString(
    "base64url",
  );
  return `${body}.${hmac(body)}`;
}

export function verifyToken(token: string, kind: Kind): string | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expected = hmac(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const claims: Claims = JSON.parse(Buffer.from(body, "base64url").toString());
    if (claims.kind !== kind || claims.exp < Date.now()) return null;
    return claims.wa;
  } catch {
    return null;
  }
}

export type Vars = { Variables: { wa: string } };

/** Identity comes from a token we signed — never from a caller-supplied waNumber. */
export const requireAuth: MiddlewareHandler<Vars> = async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const wa = header.startsWith("Bearer ") ? verifyToken(header.slice(7), "session") : null;
  if (!wa) return c.json({ error: "unauthorized" }, 401);
  c.set("wa", wa);
  await next();
};

export const makeOtp = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

export const hashSecret = (s: string) => Bun.password.hash(s);
export const verifySecret = (s: string, hash: string) => Bun.password.verify(s, hash);

const lastSent = new Map<string, number>();
const RESEND_COOLDOWN_MS = 30_000;

export function throttleSend(key: string, cooldownMs = RESEND_COOLDOWN_MS): boolean {
  const prev = lastSent.get(key) ?? 0;
  if (Date.now() - prev < cooldownMs) return false;
  lastSent.set(key, Date.now());
  return true;
}

export const throttleOtp = (wa: string) => throttleSend("otp:" + wa);

/**
 * The PIN is the one credential a WhatsApp takeover doesn't hand over, so it must not be the
 * first thing an attacker would try. Rejects the guesses that dominate every leaked PIN set:
 * one repeated digit and straight runs.
 */
export function pinProblem(pin: string): string | null {
  if (!/^\d{6}$/.test(pin)) return "pin must be 6 digits";
  if (/^(\d)\1{5}$/.test(pin)) return "too easy to guess — don't repeat one digit";
  const run = (step: number) =>
    pin.split("").every((d, i, all) => i === 0 || Number(d) === Number(all[i - 1]) + step);
  if (run(1) || run(-1)) return "too easy to guess — don't use digits in a row";
  return null;
}
