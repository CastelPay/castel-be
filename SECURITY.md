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
| Spending | 6-digit PIN, argon2 (`Bun.password`), set during onboarding, locks after 5 failures |
| Forgotten PIN | Single-use link over WhatsApp, 15 min — redeeming it clears the stored hash |
| Webhook | Twilio `X-Twilio-Signature` verified against `PUBLIC_URL` |

No route reads a caller-supplied `waNumber`. Identity is derived from the token.

### Why the PIN exists

WhatsApp account takeover is common in Indonesia — OTP phishing ("please forward the
code you just received") is an everyday scam. An attacker who owns the victim's WhatsApp
gets a **legitimate** OTP and a **valid** session. Every layer above fails.

The PIN is the one control that survives that: it is never typed into a chat, never sent
over WhatsApp, and only ever entered on the web. Possession of the chat is not possession
of the money.

It is created during onboarding, in the same sitting as the OTP — before a wallet exists to
fund. A wallet that can receive money before it can defend it is the wrong order, and a
"set your PIN later" banner is a banner most people dismiss.

**And the honest part: forgetting it has to be recoverable, and recovery runs over WhatsApp.**
Without a reset, five wrong guesses would strand the balance permanently — a real user's most
likely loss is their own memory, not an attacker. So `forgot pin` mails a reset link to the
number. That does hand a WhatsApp takeover a path to the PIN, and we do not pretend otherwise.
What it costs the attacker:

- The link is **single-use** (its hash is stored and cleared on redemption) and dies in 15 min,
  so a forwarded or shoulder-surfed link is usually already spent.
- A successful reset **messages the number**: *"Your PIN was just changed."* The takeover stops
  being silent, which is the property that actually matters — the victim is in the same chat.
- That message carries a one-word kill switch: replying **BLOCK** freezes spending immediately,
  before the attacker can move funds. `checkPin` refuses everything on a frozen account.
- Both the reset request and `/me/pin/*` are rate-limited, and a session token alone can never
  change an existing PIN (`/me/pin` returns `409`) — only the WhatsApp link can.

The residual risk is a takeover that resets, spends, and finishes before the owner reads one
WhatsApp message. Closing that needs a second channel that isn't WhatsApp (see gap 7).

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
| Change the PIN with a stolen session token | `409` — only the WhatsApp reset link can |
| Reuse a PIN reset link | `401` — the stored hash is cleared on first redemption |
| Redeem a magic link as a PIN reset (or vice versa) | `401` — the token kind is signed in |
| Brute-force a PIN | locks after 5 tries; the counter increments in SQL, so racing doesn't inflate it |
| Redeem a cash-out escrow without the pickup code | `403` |
| Exceed the Tier 0 limit | `403` |
| Claim another user's on-chain XLM deposit by its tx hash | `403` — the payment must carry the depositor's MEMO_ID |
| Double-credit a deposit by racing or retrying the convert | blocked — the idempotency hash is reserved before any cIDR is minted |
| Pay a merchant or charge a card twice by retrying a request | blocked — a per-request idempotency key short-circuits the retry |
| Exceed the 30-day cap by opening many Checkout sessions at once | `403` — in-flight sessions hold limit headroom until they expire or confirm |
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
7. **PIN recovery has no second channel.** `forgot pin` is delivered over the same WhatsApp
   account the PIN is meant to survive the loss of, so a takeover can reset it. Today that is
   bounded by a single-use 15-minute link, a change alert, and the `BLOCK` freeze (above), which
   makes the attack loud rather than impossible. Fix: bind the reset to something WhatsApp
   doesn't grant — a passkey on the enrolled device, or an email/Telegram second factor
   captured at onboarding.

### Concurrency, idempotency & settlement (found in an adversarial review, hardened)

A parallel code review of the deposit/pay rails found the money-losing bugs, all now fixed:

- **Claiming another user's XLM deposit** — the payment is now bound by a per-user `MEMO_ID`
  that convert verifies (`403` otherwise).
- **Concurrent double-crediting / double-paying** — every mint rail reserves its idempotency
  hash *before* the on-chain submit, and the Circle rail sweeps its USDC reserve before
  issuing cIDR.
- **Limit-window bypass via parallel sessions (#7)** — creating a Checkout session writes a
  short-lived **hold** row (serialized per user), so the tier cap counts in-flight sessions and
  a user can't collectively exceed it; the hold is released at confirm and expires after 1h.
  No post-payment refusal, so no stranded funds.
- **`/deposit/charge` double-charge (#8)** — the client sends a stable idempotency key that is
  passed to Stripe, so a retry reuses the same `PaymentIntent` instead of charging again.
- **`/pay` replay (#9)** — accepts a client idempotency key and reserves it before submitting,
  so a retry / double-tap short-circuits to `alreadyPaid`.
- **Dropped settlement (#10)** — the merchant is settled with a deterministic per-payment
  `external_id`, and the `alreadyPaid` retry path re-attempts it; Xendit dedups, so it never
  double-disburses.
- **Quick-pay rate drift (#11)** — the create-time USD/IDR rate is locked into the session and
  credited at, so a move before confirm can't under-fund the bill.
- **Stale fallback rates (#13)** — `xlmUsd` drops to the conservative fallback once its cached
  rate is over 6h old rather than pricing a deposit on a stale number.

Residual (understood, not yet built):

7. **The concurrency guards assume a single instance.** The per-account lock, the
   reserve-before-submit, and the in-memory rate limiter (#5) are correct on one Render
   instance; horizontal scale-out needs a database advisory lock.

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
