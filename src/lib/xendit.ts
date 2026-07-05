const BASE = "https://api.xendit.co";
const key = process.env.XENDIT_SECRET_KEY;

export const xenditEnabled = () => !!key;

async function xnd(path: string, method: string, body?: unknown) {
  if (!key) throw new Error("xendit not configured");
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: "Basic " + Buffer.from(key + ":").toString("base64"),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message ?? data?.error_code ?? "xendit request failed");
  return data;
}

export type Settlement = {
  id: string;
  status: string;
  amount: number;
  channel: string;
};

// Settle IDR to a QRIS merchant via Xendit disbursement (sandbox). The merchant's
// bank account stands in for the acquirer payout the licensed PJP would run in production.
export async function settleToMerchant(params: {
  externalId: string;
  amountIdr: number;
  merchantName: string;
}): Promise<Settlement> {
  const d = await xnd("/disbursements", "POST", {
    external_id: params.externalId,
    amount: Math.round(params.amountIdr),
    bank_code: "BCA",
    account_holder_name: params.merchantName || "Castel Merchant",
    account_number: "1234567890",
    description: `Castel QRIS settlement — ${params.merchantName}`,
  });
  return { id: d.id, status: d.status, amount: d.amount, channel: d.bank_code };
}
