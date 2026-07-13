# Castel — security model

Castel holds tourists' money. This document states what we protect, what we deliberately
do not yet protect, and how we get from here to a non-custodial system.

## The core decision: custody

A tourist landing in Bali has no Indonesian bank account, no local SIM, and no crypto
wallet. Handing them a seed phrase is not a product — it is the reason nobody uses crypto
for payments. So Castel is **custodial**: the server generates and holds each user's
Stellar key, and the WhatsApp number is the account.

That choice is the product. It is also the largest thing we have to defend.

## Identity is not authority

The mistake we made first, and fixed: the WhatsApp number was both *who you are* and
*what you may do*. Every route accepted a `waNumber` from the request body, and magic
links were `?wa=+62812…`. Typing a stranger's phone number into a URL spent their money.

A phone number is a **username**, not a credential. It is public, guessable, and
enumerable. Authority now comes only from something the server issued:

| Layer | Mechanism |
|---|---|
| Session | HMAC-SHA256 signed token (`SESSION_SECRET`), 24 h, `Authorization: Bearer` |
| Proof of number | 6-digit OTP delivered **over WhatsApp**, single-use, 5 min, 5 attempts |
| Magic link | Separately-typed signed token, 15 min — a link token cannot be used as a session token |
| Spending | 6-digit PIN, argon2 (`Bun.password`), locks after 5 failures |
| Webhook | Twilio `X-Twilio-Signature` verified against `PUBLIC_URL` |

No route reads a caller-supplied `waNumber`. Identity is derived from the token.

### Why the PIN exists

WhatsApp account takeover is common in Indonesia — OTP phishing ("please forward the
code you just received") is an everyday scam. An attacker who owns the victim's WhatsApp
gets a **legitimate** OTP and a **valid** session. Every layer above fails.

The PIN is the one control that survives that: it is never typed into a chat, never sent
over WhatsApp, and only ever entered on the web. Possession of the chat is not possession
of the money.

## Tier 0 limits are compliance, in code

Indonesian regulation (POJK 12/2017 Art. 15) treats opening a wallet as a business
relationship, which triggers CDD regardless of amount. There is no legal "no-KYC" tier.
Castel Tier 0 is therefore **Simplified CDD**, not anonymity — and FATF Rec. 16's
de-minimis (USD 1,000) plus its aggregation rule are enforced as real limits:

- Single transaction ≤ Rp 16,500,000 (~USD 1,000)
- Rolling 30-day total ≤ Rp 16,500,000 — aggregation, not just a per-transaction cap
- Deposits ≤ USD 1,000 single / 30-day

Raising them is a KYC upgrade (Tier 1: passport + selfie), not a config change.
`GET /me/limits` exposes the remaining allowance; the wallet shows it.

## What an attacker cannot do

Verified against the running service:

| Attack | Result |
|---|---|
| Call any money route without a token | `401` |
| `POST /pay {waNumber: "<victim>"}` | `401` — the field is not read |
| Forge a session token | `401` |
| Replay a WhatsApp magic-link token as a session | `401` |
| Reuse an OTP | rejected |
| POST to `/wa/webhook` impersonating a number | `403` |
| Spend with a hijacked WhatsApp session | blocked at the PIN |
| Redeem a cash-out escrow without the pickup code | `403` |
| Exceed the Tier 0 limit | `403` |
| Hammer auth or payment endpoints | `429` |

## Known gaps (honest list)

These are real, and we know exactly what each fix is.

1. **Custodial keys are stored in plaintext** in Postgres. One database dump is every
   tourist's funds. Fix: envelope-encrypt with AES-256-GCM under a KMS-held key,
   decrypt only inside the signing path. This is the highest-priority production gap.
2. **The escrow contract's `release()` has no `require_auth`** on the agent. The API now
   requires the pickup code, so this is not exploitable through Castel — but on-chain,
   anyone holding a leaked code could release. Fix: `escrow.agent.require_auth()`, making
   code + agent signature true dual control. (Our tests used `mock_all_auths()`, which is
   precisely why this went unnoticed — they should use explicit `mock_auths`.)
3. **The cIDR issuer has no authorization flags.** `AUTH_REVOCABLE` (freeze) and
   `AUTH_CLAWBACK_ENABLED` (reverse fraud) are the compliance primitives a rupiah-pegged
   token needs. ⚠️ Clawback is **not retroactive** — it only applies to trustlines created
   after the flag is set, so this must be done before real users exist.
4. **The issuer key has unlimited mint authority** and lives beside the other secrets.
   Fix: multisig on the issuer account.
5. **In-memory rate limiting** breaks the moment we run more than one instance.
   Fix: move to Postgres or Redis.
6. **No `stellar.toml` (SEP-1)** — required before any anchor integration.

## Roadmap out of custody

Custody is a starting position, not a destination. Stellar has native answers, and none
of them require a custom contract:

**Stellar multisig.** An account can have several signers with weights and thresholds.
The tourist's device holds one key, Castel holds another, 2-of-2 to spend. Castel becomes
a **co-signer, not an owner** — we cannot move funds alone.

**SEP-30 (Recoverable Wallets).** The Stellar standard built for exactly the "I lost my
phone" problem: recovery servers co-sign a key rotation after verifying identity — and
SEP-30's identity model explicitly includes `phone_number`. So the WhatsApp number that
is the account today becomes the *recovery identity* tomorrow. That is the graduation
path: custodial → 2-of-2 multisig → SEP-30 recoverable non-custodial, with WhatsApp still
the thing the tourist actually uses.

**SEP-10 / SEP-12 / SEP-24 at the anchor boundary.** SEP-10 is not the tourist's login —
it proves control of a Stellar key, and today we hold that key. It is how *Castel*
authenticates to an anchor. When a licensed Indonesian PJP sits in the flow, SEP-12
becomes the wire format for the tiered CDD data above, and SEP-24 the deposit/withdraw
protocol. The interesting inversion: Castel could itself become a **SEP-24 withdraw
anchor**, exposing the Bali cash-agent network so that *any* Stellar wallet can cash out
rupiah in Bali.

## Reporting

Testnet only. No real funds. Keys in this repo's `.env.example` are placeholders.
