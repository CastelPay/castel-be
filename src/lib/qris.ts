export type QrisInfo = {
  merchantName: string;
  city: string;
  amount: number | null;
  currency: string;
  isStatic: boolean;
};

function parseTLV(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i + 4 <= s.length) {
    const tag = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    if (Number.isNaN(len)) break;
    out[tag] = s.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

export function parseQris(payload: string): QrisInfo {
  const t = parseTLV(payload.trim());
  const amountRaw = t["54"];
  return {
    merchantName: (t["59"] ?? "Unknown Merchant").trim(),
    city: (t["60"] ?? "").trim(),
    amount: amountRaw ? Number(amountRaw) : null,
    currency: t["53"] === "360" ? "IDR" : (t["53"] ?? "IDR"),
    isStatic: !amountRaw,
  };
}
