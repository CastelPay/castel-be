# Castel — Architecture

How the three repos fit together, and what each one touches. Two views: a high-level map,
then the full breakdown.

- **[castel-fe](https://github.com/CastelPay/castel-fe)** — Next.js web wallet (camera + card only)
- **[castel-be](https://github.com/CastelPay/castel-be)** — Hono/Bun API, custody, FX, settlement
- **[castel-sc](https://github.com/CastelPay/castel-sc)** — Soroban escrow contract (Rust)

---

## Simple view

```mermaid
flowchart LR
    Tourist(["🧳 Tourist"])
    Merchant(["🍜 QRIS merchant"])
    Agent(["🏪 Money changer"])

    WA["💬 WhatsApp<br/>identity + concierge"]
    FE["🖥️ castel-fe<br/>web wallet · camera · card · connect"]
    BE["⚙️ castel-be<br/>API · custody · FX"]
    SC["📜 castel-sc<br/>Soroban escrow"]

    Twilio["📨 Twilio"]
    Stripe["💳 Stripe<br/>card → USD"]
    Wallet["🦊 Freighter<br/>USDC · native XLM"]
    Xendit["🏦 Xendit<br/>→ IDR"]
    Stellar["⭐ Stellar<br/>cIDR · path payment · DEX"]

    Tourist -->|chats| WA
    WA <-->|magic link| Twilio
    Twilio <--> BE
    Tourist -->|scan · pay by card| FE
    Tourist -->|connect wallet| Wallet
    FE <-->|signed session| BE

    BE -->|charge card| Stripe
    Wallet -->|USDC / XLM as reserve| BE
    BE -->|issue cIDR at reference rate · optional USDC swap| Stellar
    BE -->|lock / release| SC --> Stellar
    BE -->|payout| Xendit -->|rupiah| Merchant
    Agent -->|hands cash| Tourist

    classDef castel fill:#dbe4ff,stroke:#4263eb,color:#1a1a2e;
    classDef ext fill:#fff9db,stroke:#f59f00,color:#1a1a2e;
    class FE,BE,SC castel;
    class Twilio,Stripe,Wallet,Xendit,Stellar ext;
```

**The one-line read:** WhatsApp is the account, the web app is a camera, a card form and a
wallet-connect button, the backend holds the keys and moves the money, and Stellar carries
the rupiah asset. A card top-up (or a connected wallet's USDC/XLM) is credited as rupiah
**directly at the reference rate** — the DEX and path payment power only the optional
"exchange held USDC → rupiah" path. The Soroban contract escrows the cash-out. Merchants and
agents always touch **rupiah**, never crypto.

---

## Detailed view

```mermaid
flowchart TB
    Tourist(["🧳 Tourist"])
    Merchant(["🍜 QRIS merchant"])
    Agent(["🏪 Money-changer agent"])

    subgraph FE["🖥️ castel-fe · Next.js 16"]
        direction TB
        Psignin["SignIn — WhatsApp OTP"]
        Pwallet["/wallet — balance · top-up (card · crypto) · limits"]
        Ppay["/pay — camera QRIS scan"]
        Pcash["/cashout — pickup QR"]
        Pagent["/agent — release escrow"]
        Pin["PinPrompt"]
        Papi["lib/api · lib/session<br/><i>Bearer token</i>"]
    end

    subgraph BE["⚙️ castel-be · Hono + Bun"]
        direction TB
        subgraph BAuth["auth"]
            Rauth["/auth/request · /verify · /exchange · /pin/reset"]
            Lauth["lib/auth — HMAC token · OTP · PIN (argon2)<br/><i>mandatory onboarding · strength check · WhatsApp reset · freeze</i>"]
        end
        subgraph BMoney["money routes (requireAuth + PIN + Tier-0)"]
            Rdep["/deposit/create · /confirm · /charge"]
            Rcrypto["/deposit/circle/* · /deposit/xlm/convert"]
            Rquick["/pay/quick/create · /confirm"]
            Rswap["/fx/swap · /fx/quote · /fx/xlm-quote · /deposit/usdc/convert"]
            Rpay["/pay"]
            Rcash["/cashout/request · /redeem"]
            Rme["/me/balance · /history · /limits · /pin/reset-link"]
        end
        subgraph BLib["lib / services"]
            Lstellar["lib/stellar — Horizon · submit · seq-lock"]
            Lsor["lib/soroban — RPC · escrow"]
            Lqris["lib/qris — EMVCo parser"]
            Lxen["lib/xendit — disbursement"]
            Lrates["lib/rates — live USD/IDR"]
            Llim["lib/limits — Tier 0 CDD"]
            Sdep["services/deposit — creditUsdAsRupiah<br/><i>direct cIDR at reference rate (no DEX)</i>"]
            Sfx["services/fx — quoteUsdcToCidr · swapUsdcToCidr<br/><i>path payment · USDC-exchange path only</i>"]
            Scust["services/custody — createWallet"]
        end
        Rwa["/wa/webhook — signature-verified"]
        DB[("🗄️ Neon Postgres<br/>users · transactions<br/>cashouts · rates")]
    end

    subgraph SC["📜 castel-sc · Soroban (Rust)"]
        Escrow["escrow contract<br/>lock · release · refund<br/><i>sha256 hashlock · timelock · 1% fee</i>"]
    end

    subgraph Ext["External services"]
        Twilio["📨 Twilio WhatsApp"]
        Stripe["💳 Stripe Checkout"]
        Freighter["🦊 Freighter / Wallets Kit"]
        Xendit["🏦 Xendit disbursement"]
        FX["📈 exchangerate-api · Coinbase spot"]
    end

    subgraph Chain["⭐ Stellar testnet"]
        direction TB
        Issuer["Issuer — cIDR<br/><i>AUTH_REVOCABLE · clawback</i>"]
        Treasury["Treasury — reserve<br/><i>incoming USDC · XLM counterparty</i>"]
        Dist["Distributor — DEX market maker<br/><i>USDC-exchange path only</i>"]
        UserW["User wallets (custodial + connected)"]
        SAC["cIDR SAC (SEP-41 bridge)"]
        Horizon["Horizon (classic)"]
        SRPC["Soroban RPC"]
    end

    Tourist -->|WhatsApp| Twilio --> Rwa
    Rwa --> Lauth
    Tourist -->|browser| FE
    Papi -->|Bearer token| BAuth
    Papi --> BMoney
    Ppay -.->|scan| Lqris

    Rauth --> Lauth --> DB
    Rauth -.->|OTP| Twilio

    Rdep --> Stripe
    Rdep --> Sdep
    Rquick --> Stripe
    Rquick --> Sdep
    Rcrypto --> Sdep
    Rswap --> Sfx
    Sdep --> Lrates
    Sfx --> Lrates -.->|USD/IDR| FX
    Sdep --> Lstellar
    Sfx --> Lstellar
    Scust --> Lstellar
    Pwallet -.->|connect| Freighter
    Freighter -->|USDC / native XLM| Treasury
    Rpay --> Lqris
    Rpay --> Lstellar
    Rpay --> Lxen --> Xendit
    Rcash --> Lsor
    BMoney --> Llim --> DB
    BMoney --> DB

    Lstellar --> Horizon
    Lsor --> SRPC
    Horizon --> Treasury & Dist & UserW & Issuer
    SRPC --> Escrow
    Escrow --> SAC --> Issuer

    Xendit -->|rupiah| Merchant
    Agent -->|scans pickup QR| Pagent
    Agent -->|cash| Tourist
```

### What each layer is responsible for

| Layer | Owns | Does **not** |
|---|---|---|
| **castel-fe** | Camera scan, card hand-off, PIN entry, showing rupiah | Hold keys, sign transactions, know a phone number is real |
| **castel-be** | Custody (Stellar keys), auth, direct cIDR issuance, USDC-exchange swap, QRIS decode, settlement, limits | Store card numbers (Stripe does), run the AMM (the DEX does) |
| **castel-sc** | Trustless cash-out escrow (hashlock, timelock, fee split) | Anything in the deposit/pay path — that is all Stellar Classic |

### Why the split

- **Keys live only in the backend.** The tourist never holds a seed phrase; the web app
  never sees a secret. The phone number is identity, a signed token is authority.
- **A PIN is mandatory before any spend.** A brand-new user's first sign-in lands on a
  required PIN-creation step, not the wallet; weak PINs are rejected at set time. A forgotten
  PIN is reset by `POST /me/pin/reset-link`, which delivers a **single-use, 15-minute link
  over WhatsApp** (never in the API response) that `/reset-pin` redeems via
  `POST /auth/pin/reset` — receiving it on WhatsApp is itself the proof of number ownership.
  An owner can freeze the account (reply `BLOCK` to the PIN-change alert) to refuse every
  spend until they unfreeze from the chat.
- **The card form and the camera are the only reasons the web app exists** — a chat can do
  neither. Everything else is a WhatsApp message.
- **Deposit credits rupiah directly.** A card top-up (and a connected wallet's USDC or
  native XLM) is credited as cIDR straight to the user at the live reference rate — no DEX,
  no intermediate dollar balance, nothing that can strand. The built-in DEX + path payment is
  Stellar Classic too, but it now powers only the optional "exchange held USDC → rupiah" path.
- **Soroban is used once.** Deposit and pay are Stellar Classic; only the cash-out needs
  custom on-chain logic, so only the cash-out is a contract.
