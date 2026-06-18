# castel-be — Castel Backend

Backend for **Castel (Cash on Stellar)** — WhatsApp-first FX/payment app for Bali tourists. Hono + Bun.

## Responsibilities
- **WhatsApp bot** (Twilio sandbox) — onboarding, top-up, balance, cash-out, notifications
- **Custody/signer** — manage a Stellar account per WhatsApp number, sign & submit txns
- **FX engine** — quote + execute USDC→cIDR via Stellar **path payments**, compute savings vs money changer
- **Settlement** — decode QRIS (EMVCo), mock IDR settlement to merchant; build escrow cash-out
- **DB** (Drizzle) — users, balance mirror, transactions, agents, merchants

## Stack
`@stellar/stellar-sdk` · `twilio` · `drizzle-orm` · Hono · Bun

## Run
```bash
bun install
cp .env.example .env   # fill in keys
bun run dev            # http://localhost:3001
```

## Notes
- cIDR is issued on testnet (see `castel-sc` + Stellar token docs).
- Demo: USDC deposit + path-payment swap are **real**; QRIS merchant settlement, card on-ramp, KYC and treasury rebalance are **mocked**.
