import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

const SECRET = process.env.SESSION_SECRET;
if (!SECRET) throw new Error("SESSION_SECRET is required (32+ random chars)");

export const LINK_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 24 * 60 * 60_000;
export const OTP_TTL_MS = 5 * 60_000;
export const MAX_OTP_ATTEMPTS = 5;
export const MAX_PIN_ATTEMPTS = 5;

type Kind = "link" | "session";
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

export function throttleOtp(wa: string): boolean {
  const prev = lastSent.get(wa) ?? 0;
  if (Date.now() - prev < RESEND_COOLDOWN_MS) return false;
  lastSent.set(wa, Date.now());
  return true;
}
