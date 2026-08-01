# Castel — Cash on Stellar

**A holiday wallet for the 4 million tourists Indonesia's payment system leaves out.**

Load it with a card. Pay any QRIS merchant in Bali. Take the rest home as cash.
No Indonesian bank account, no SIM card, no KTP. It runs on WhatsApp.

🔗 **Live:** [castelpay.vercel.app](https://castelpay.vercel.app) · API [castel-be.onrender.com](https://castel-be.onrender.com)
📦 [castel-sc](https://github.com/CastelPay/castel-sc) (Soroban) · **castel-be** (this repo) · [castel-fe](https://github.com/CastelPay/castel-fe)
🏗️ **Architecture diagrams: [ARCHITECTURE.md](./ARCHITECTURE.md)**

---

## The problem is not the tourist's. It's the warung's.

Bank Indonesia built **QRIS** to bring micro-merchants into digital payments — a warung, a
driver, a market stall, all reachable with a printed QR sticker and no card terminal. In
BI's own words, QRIS is *"an entry point into the digital ecosystem for MSMEs, to support
economic and financial inclusion."*

It worked. **45.3 million merchants — 93% of them MSMEs, 57.5% micro.**

But a tourist arriving from Australia, with an Australian phone number and an Australian
bank card, has **no practical way to pay that warung**. The Indonesian wallets that can pay
QRIS — GoPay, OVO, DANA — each need four things a tourist does not have:

| The wallet needs | The tourist has |
|---|---|
| An Indonesian (+62) SIM that receives SMS | A data-only travel eSIM, or roaming on their home number |
| An Indonesian debit card | A foreign **credit** card — which cannot top up GoPay at all |
| An Indonesian bank account | None — and so no way to withdraw a leftover balance |
| A KTP (national ID) | A passport, which in practice fails the KYC upload |

**Bank Indonesia already agrees this is a real problem** — it built **QRIS Cross-Border** so
foreign tourists could pay, and recorded **5,892,621 inbound foreign-tourist transactions in
2025**. But it reaches exactly six countries:

| | |
|---|---|
| **Covered** | Thailand · Malaysia · Singapore · Japan · South Korea · China |
| **Not covered** | 🇦🇺 **Australia — Bali's #1 source market, 1.63M arrivals, 23.4%** · India · UK · USA · France · Germany |

Of Bali's ten largest source markets, only four can use it.

Bali took **US$10.7 billion (Rp 176 trillion)** from foreign tourists in 2025 — **55% of
Indonesia's national tourism foreign exchange**, from **6.95 million arrivals** spending an
average of **US$1,522** each. BPS tells us 41% of that goes to accommodation. What no
published data can tell us — and we looked — is how much of the rest actually reaches the
warung, the driver, the artisan. What we do know is that in 4- and 5-star chain hotels,
**51% of revenue leaves Bali entirely**.

That gap is what Castel is built for.

*(Sources: Bank Indonesia QRIS & QRIS Antarnegara pages; BPS Bali, Feb 2026; Suryawardani
et al., ASEAN Journal on Hospitality and Tourism 13(1), 2014 — accommodation sector, n=79.)*

---

## How it works

```
  WhatsApp                        Web (camera · card · wallet)         Stellar
 ──────────                      ──────────────────────────────      ───────────

  "topup"  ─── magic link ──▶   Stripe Checkout (USD)
                                        │  card charged in USD,
                                        │  credited at the reference
                                        ▼  rate (30 bps spread)
                                balance in RUPIAH (cIDR)          reserve held at Stripe

                                connect wallet (Freighter)
                                        │  send USDC or native XLM;
                                        │  treasury takes it as reserve,
                                        ▼  cIDR issued at reference rate
                                balance in RUPIAH (cIDR)  ◀──  USDC / XLM ──▶ treasury

  "pay"    ─── magic link ──▶   scan QRIS → PIN → paid
                                        │                           cIDR ──▶ treasury
                                        ▼
                              merchant paid in IDR  ◀──── Xendit disbursement

  "cash"   ─── magic link ──▶   request cash → PIN
                                        │                           cIDR ──▶ Soroban escrow
                                        ▼                                      │ hashlock
                              agent scans pickup QR ─────────────────────────┘
                                        │
                                  rupiah in hand
```

**WhatsApp is the account.** The phone number is the identity — the one the tourist already
owns and keeps. The web pages exist only for the two things a chat cannot do: **use a
camera**, and **take a card number**. They report back to the chat.

The tourist never sees the word "crypto". They tap a card and their balance reads in
rupiah, because the card is credited as rupiah (cIDR) directly at the live reference rate
the moment it clears — no dollar balance to convert, nothing to strand. A crypto-native
user can instead connect a Stellar wallet and fund from real USDC or native XLM; the
treasury takes the crypto as reserve and issues the same rupiah balance.

---

## What is actually real

Nothing in the core flow is mocked.

| | |
|---|---|
| **QRIS** | Real EMVCo TLV parser — decodes live merchant QR codes |
| **Card on-ramp** | **Stripe** Checkout, test mode — a real card, charged in USD; cIDR credited **directly at the live USD/IDR reference rate** (30 bps spread), no intermediate dollar balance |
| **Crypto on-ramp** | **Stellar Wallets Kit** + **Freighter** — connect a wallet and deposit real **Circle testnet USDC** or **native XLM**; treasury takes it as reserve, cIDR issued at the reference rate (anchor-style). The XLM tab shows a **live rupiah preview** as you type, from `GET /fx/xlm-quote` (XLM→USD via Coinbase → cIDR at the reference rate) |
| **DEX / path payment** | **Stellar path payment** across the protocol's built-in order book — a real on-chain swap, priced against the **live USD/IDR rate**; powers the optional "exchange held USDC → rupiah" path |
| **Merchant settlement** | **Xendit** Disbursement API, sandbox — a real IDR payout call |
| **Cash-out** | **Soroban escrow** on testnet — hashlock, refund timelock, fee split, on-chain release |
| **WhatsApp** | **Twilio** WhatsApp sandbox — signature-verified webhook |

Testnet and sandbox keys throughout; no real money moves. cIDR has no fiat backing — see
[Honest limits](#honest-limits).

---

## Why Stellar

Not "we needed a blockchain". Each of these is a protocol primitive no other L1 has, and
each one is load-bearing:

- **Path payments** — the optional "exchange held USDC → cIDR" path is a *single atomic
  operation* routed through Stellar's built-in DEX, with a slippage bound derived from a live
  quote. No AMM to deploy, no router contract, no approval step. On an EVM chain this is a
  Uniswap deployment plus a seeded pool; here it is one operation. (The primary card and
  quick-pay rails skip the DEX entirely — they credit rupiah directly at the reference rate.)
- **Real wallet interop, native assets as first-class deposits** — a crypto-native user
  connects **Freighter** through the Stellar Wallets Kit and deposits real **Circle testnet
  USDC** or **native XLM** straight from their own wallet. The treasury takes the incoming
  crypto as reserve and issues cIDR at the live reference rate — an anchor-style on-ramp with
  no DEX hop. Accepting native XLM as a first-class deposit asset, verified by its on-chain
  tx hash, is a Stellar primitive no card network gives you.
- **Native asset issuance + trustlines** — cIDR is not a token contract. It is a classic
  Stellar asset, so it gets the order book, path payments and anchor compatibility for free.
  Writing a SEP-41 token contract instead would have *removed* all three.
- **Protocol-level compliance** — the cIDR issuer carries `AUTH_REVOCABLE` and
  `AUTH_CLAWBACK_ENABLED`. A rupiah-pegged asset has to be freezable and reversible, and
  Stellar provides that without a line of contract code. `AUTH_REQUIRED` is deliberately
  *not* set: it would land every new trustline unauthorized and break path payments until a
  SEP-8 approval server exists.
- **SEP-1** — [`stellar.toml`](https://castelpay.vercel.app/.well-known/stellar.toml) publishes
  the asset and the accounts.
- **Soroban** — used only where no protocol primitive exists: a hashlocked escrow that holds
  the tourist's rupiah on-chain until the agent proves possession of the pickup code. Custom
  logic where custom logic is warranted, and nowhere else.

---

## Security

The WhatsApp number is **identity, not authority**. A session comes from an HMAC token the
server signed, obtainable only by proving control of the number — an OTP delivered over
WhatsApp, or a signed magic link. No route reads a caller-supplied phone number.

Spending requires a **6-digit PIN** (argon2) that is never typed into a chat, so an attacker
who takes over the victim's WhatsApp still cannot move money. Setting it is **mandatory
onboarding**: a brand-new user's first sign-in lands not on the wallet but on a required
"one last step" PIN screen, and weak PINs are rejected at set time — sequential runs
(`123456`) and repeated digits (`111111`).

A **forgotten PIN** is recovered without a support ticket: the user asks for a reset, and a
**single-use, 15-minute link is delivered over WhatsApp** — never returned in an API
response, so receiving it *is* the proof of number ownership. The link opens `/reset-pin` on
the web wallet, which clears the old PIN hash and sets the new one. Five wrong PINs lock
spending and route the user to that same forgot-PIN reset.

An account can be **frozen**: the "your PIN was changed" WhatsApp alert can be answered
`BLOCK`, after which every spend is refused until the owner messages the bot to unfreeze —
a kill switch the attacker cannot reach because it lives in the chat, not the wallet.

Tier 0 = **Simplified CDD**, enforced in code: a single transaction *and* a **rolling 30-day
total** are both capped — FATF Rec. 16's de-minimis together with its aggregation rule,
because a per-transaction cap on its own is meaningless.

Threat model, the verified attack table, and an honest list of what is still broken:
**[SECURITY.md](./SECURITY.md)**.

---

## Legal position

Using crypto as a means of payment is **illegal in Indonesia**. Castel is built so that it
is not one:

> **The merchant is always paid in Indonesian rupiah, by a licensed payment provider. The
> Stellar asset is never presented as a means of payment.**

The tourist holds a balance, Castel converts it, the merchant is settled in fiat. Crypto is
the rail, not the tender.

---

## Honest limits

The things a judge would find, listed before they do:

- **cIDR has no fiat backing.** Testnet asset, self-seeded liquidity. In production the
  issuer must be an OJK-licensed provider holding rupiah 1:1.
- **Custodial keys are stored in plaintext.** One database dump is every user's funds. The
  fix (envelope encryption under a KMS-held key) is understood, not built.
- **The escrow's `release()` has no `require_auth`** on the agent. The API requires the
  pickup code, so it is not exploitable through Castel — but on-chain it should be dual
  control.
- **Card fees exceed our FX edge.** Stripe takes ~2.9% (and ~4.4% on a foreign-issued card);
  our rate advantage over a money changer is under 1%. Castel is **not the cheapest** way to
  get rupiah — it is the only one available to a tourist with no Indonesian bank account. We
  do not claim otherwise.
- **The money-changer comparison is an estimate.** The reference rate is live, but the
  "typical money changer" is modelled as mid minus Rp 200/USD. The UI labels it as an
  estimate rather than dressing an assumption up as a measurement.

---

## Run it

```bash
bun install
cp .env.example .env      # Stellar keys, Twilio, Stripe, Xendit, Neon Postgres
bun run src/index.ts      # :3001
```

> **Cold start.** The API runs on a free tier that sleeps when idle. Any page load pings it
> to wake it, and the sign-in "Send code" button waits until the backend answers ("Waking the
> server…") before requesting an OTP — so the first code arrives instantly instead of being
> lost while the server boots.

Bootstrap a fresh testnet environment:

```bash
bun run scripts/issue-cidr.ts       # issue cIDR; fund issuer, distributor, treasury
bun run scripts/harden-issuer.ts    # AUTH_REVOCABLE + clawback + home_domain
bun run scripts/seed-liquidity.ts   # two-sided USDC/cIDR market on the DEX
bun run scripts/refresh-market.ts   # re-price the book against the live USD/IDR mid
```

The last two scripts power the **optional USDC-exchange path only** — the DEX book that a
user with held USDC swaps across. The primary card, quick-pay, native-XLM and Circle-USDC
rails do not touch the DEX; they credit rupiah directly at the reference rate, so they need
no seeded liquidity.

On that USDC-exchange path, Stellar has **no peg mechanism** — a swap executes at whatever
the order book says. The rate only tracks reality because a market maker keeps re-posting:
that is `refresh-market.ts`, and it is the off-chain half of an anchor. Run it on a schedule.
(An *on-chain* oracle would only be needed if a **contract** had to read the price; path
payments read the order book, so the price feed belongs off-chain.)

Tests:

```bash
bun run test        # unit
bun run test:e2e    # the whole journey against Stellar testnet, in-process
```

Manual test plan: **[E2E-CHECKLIST.md](./E2E-CHECKLIST.md)**.

---

## Roadmap

**Out of custody.** Stellar multisig (2-of-2, Castel as co-signer rather than owner) →
**SEP-30 Recoverable Wallets**, whose identity model already supports `phone_number`. The
WhatsApp number that is the *account* today becomes the *recovery identity* tomorrow.

**Become an anchor.** Bali's money changers already hold exactly the float an inbound
remittance corridor needs — hard currency in, rupiah out. Tourist FX bootstraps agent
liquidity; the same rails then serve remittance recipients and unbanked locals. Indonesia
receives **~$15.6B a year in remittances**, **~48% of adults are unbanked (~97.7M people)**,
and there is **no Stellar anchor in Indonesia today**.

**Multi-currency.** Adding cSGD, cAUD or cJPY is a configuration change, not an architecture
change — path payments route across currencies through the protocol's own order book,
subject to liquidity on each hop.
