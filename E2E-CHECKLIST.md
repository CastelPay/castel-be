# Castel — E2E Test Checklist

Checklist uji end-to-end setelah rombakan auth (tahap 1–5) dan redesign rupiah-first.

- ✅ = sudah diverifikasi otomatis terhadap produksi
- 🔲 = harus diuji manual (butuh browser, kartu, atau WhatsApp)

**Live:** BE `https://castel-be.onrender.com` · FE `https://castelpay.vercel.app`

---

## 0. Pra-flight (wajib sebelum apa pun)

| # | Langkah | Harapan |
|---|---|---|
| 🔲 0.1 | Buka `castel-be.onrender.com` di browser | `{"ok":true}` — **ini yang memanaskan backend** |
| 🔲 0.2 | WhatsApp → chat **+1 415 523 8886** → kirim `join <kode-sandbox>` | *"You are all set!"* |

> ⚠️ Tanpa 0.1, pesan WhatsApp pertama **hilang** — Twilio hanya menunggu 15 detik, sedangkan Render butuh 30–60 detik untuk bangun dari idle.
>
> ⚠️ Tanpa 0.2, OTP **tidak akan pernah sampai**. Twilio sandbox hanya mengirim ke nomor yang sudah join.

---

## 1. Auth — 🔲 manual

| # | Langkah | Harapan |
|---|---|---|
| 🔲 1.1 | Buka `castelpay.vercel.app/wallet` | Layar **"Welcome to Castel"**, meminta nomor WhatsApp |
| 🔲 1.2 | Isi nomor (format `+628…`) → *Send code on WhatsApp* | Kode 6 digit **masuk ke WhatsApp** |
| 🔲 1.3 | Masukkan kode **salah** | ❌ `wrong code` |
| 🔲 1.4 | Masukkan kode **benar** | **User baru:** langsung ke langkah **wajib** buat PIN (lihat §2), **bukan** wallet. **User lama:** masuk ke wallet |
| 🔲 1.5 | Coba pakai kode yang **sama** lagi | ❌ ditolak — OTP sekali pakai |
| 🔲 1.6 | Chat bot WhatsApp: `hi` | Menu muncul — **tanpa kata "USDC" atau "exchange"** |
| 🔲 1.7 | Chat bot: `topup` → **tap link**-nya | Langsung masuk wallet + panel top-up terbuka (tanpa OTP lagi) |

---

## 2. PIN — wajib saat onboarding — 🔲 manual

> 🎯 Buat PIN kini **wajib sebelum wallet bisa dipakai**. Setelah sign-in pertama, user baru mendarat di layar **"One last step"** yang memaksa buat PIN 6 digit — bukan wallet. Tanpa PIN, tidak ada transaksi.

| # | Langkah | Harapan |
|---|---|---|
| 🔲 2.1 | Setelah kode OTP benar (user baru) | 🎯 Layar wajib **"One last step"** meminta buat PIN 6 digit — **bukan** wallet |
| 🔲 2.2 | Isi PIN lemah **`123456`** (berurutan) | ❌ ditolak — PIN mudah ditebak (`pinProblem`) |
| 🔲 2.3 | Isi PIN lemah **`111111`** (angka sama) | ❌ ditolak — angka berulang |
| 🔲 2.4 | Isi PIN berbeda di dua kolom | ❌ *"PINs don't match"* |
| 🔲 2.5 | Isi PIN kuat & sama (6 digit) | ✅ Masuk ke wallet |

### Lupa PIN — reset via link sekali-pakai di WhatsApp — 🔲 manual

> 🎯 Reset PIN **tidak lewat support**. Link reset **dikirim lewat WhatsApp** dan **tidak pernah dikembalikan di respons API** — menerima link di WhatsApp itulah bukti kepemilikan nomor. Sekali pakai, berlaku 15 menit.

| # | Langkah | Harapan |
|---|---|---|
| 🔲 2.6 | Salah PIN **5×** saat bayar | 🎯 Terkunci → diarahkan ke reset lupa PIN (kirim *forgot pin* di WhatsApp) |
| 🔲 2.7 | Minta reset: `POST /me/pin/reset-link` (atau *forgot pin* ke bot) | Link **sekali-pakai, 15 menit** masuk **ke WhatsApp**; 🎯 **tidak** muncul di respons API |
| 🔲 2.8 | Tap link → `/reset-pin?t=<token>` → isi PIN baru → submit (`POST /auth/pin/reset`) | ✅ PIN baru ter-set, dapat **sesi baru**; hash PIN lama dihapus |
| 🔲 2.9 | Bayar QRIS pakai **PIN lama** | ❌ `wrong pin` — PIN lama tak berlaku; PIN baru berhasil |
| 🔲 2.10 | Buka **link yang sama** lagi | ❌ ditolak — token **sekali pakai** |
| 🔲 2.11 | Balas **`BLOCK`** ke notifikasi WhatsApp *"your PIN was changed"* | 🎯 Akun **frozen** — semua spend ditolak (*"account frozen — message the bot to unfreeze"*) sampai owner buka blokir lewat bot |

---

## 3. Top-up → Rupiah langsung — 🔲 manual

> 🎯 **PALING KRITIS.** Ini satu-satunya jalur yang belum pernah diuji utuh, dan justru inti dari redesign rupiah-first. Membuat sesi Stripe yang benar-benar terbayar butuh browser + kartu, jadi tidak bisa diotomasi.

| # | Langkah | Harapan |
|---|---|---|
| 🔲 3.1 | Tap **"+ Add money"** → isi `100` | Preview: **"You get Rp 1.6xx.xxx"** + **"vs money changer +Rp xx.xxx"** |
| 🔲 3.2 | *Top up with card →* → kartu **4242 4242 4242 4242**, exp `12/34`, CVC `123` | Redirect kembali ke wallet |
| 🔲 3.3 | Lihat saldo | 🎯 Saldo dalam **RUPIAH**. **Kartu hasil** berwarna (bukan toast sekilas): *"Rp 1.6xx.xxx added — Rp xx.xxx more than a money changer"* |
| 🔲 3.4 | Cek tidak ada USDC nyangkut | 🎯 Tidak ada baris *"USDC waiting to be exchanged"*. Tidak ada seksi *"Exchange to rupiah"* — kartu dikreditkan **langsung sebagai rupiah**, tidak ada saldo dolar yang bisa nyangkut |
| 🔲 3.5 | Cek riwayat | `+Rp 1.6xx.xxx` (bukan `+$100`), ada link **"View on-chain ↗"** |
| 🔲 3.6 | Tap link on-chain | Stellar Explorer menampilkan **penerbitan cIDR sungguhan** ke akun kamu (bukan path payment — kartu tidak lewat DEX) |

> Kalau **3.3 gagal** (rupiah tidak masuk), kredit langsung (`creditUsdAsRupiah`) bermasalah — laporkan. Tidak ada lagi tahap auto-swap USDC→cIDR di jalur kartu, jadi tidak ada yang bisa nyangkut di sini.

---

## 3B. On-ramp kripto — connect wallet (Freighter) — 🔲 manual

> 🎯 Jalur untuk pengguna crypto-native: deposit **USDC Circle** atau **XLM native** langsung dari wallet sendiri. Treasury menerima kripto sebagai cadangan lalu menerbitkan cIDR di reference rate (gaya anchor) — **tanpa DEX**. Saldo tetap tampil **rupiah**; tourist biasa tidak perlu jalur ini.

### Pra-flight wallet

| # | Langkah | Harapan |
|---|---|---|
| 🔲 3B.0a | Pasang ekstensi **Freighter** → buka → **switch ke Testnet** | Freighter aktif di jaringan **Test SDF Network ; September 2015** |
| 🔲 3B.0b | Danai akun via **Friendbot** (`friendbot.stellar.org` atau tombol *Fund with Friendbot* di Freighter) | Akun punya saldo **XLM testnet** (mis. 10.000 XLM) |

### Deposit XLM native

| # | Langkah | Harapan |
|---|---|---|
| 🔲 3B.1 | Wallet → **+ Add money** → tab **Crypto** → *Connect wallet* → pilih **Freighter** | Freighter minta approve koneksi; alamat wallet muncul di sheet |
| 🔲 3B.2 | Asset picker → pilih **XLM** → isi jumlah → *Send from wallet* | Freighter minta tanda tangan pembayaran XLM **ke alamat treasury** |
| 🔲 3B.3 | Approve di Freighter | Tx terkirim; sheet konfirmasi *"payment received"* (harga XLM→USD via Coinbase → IDR) |
| 🔲 3B.4 | Lihat saldo | 🎯 Saldo **RUPIAH** naik. Tidak ada saldo XLM/USDC yang tampil ke user |
| 🔲 3B.5 | Cek riwayat → tap **"View on-chain ↗"** | Stellar Explorer menampilkan pembayaran XLM sungguhan ke treasury; cIDR diterbitkan ke akun kamu |
| 🔲 3B.6 | Ulangi `/deposit/xlm/convert` dengan **tx hash yang sama** | 🎯 Idempoten — tidak dobel-kredit |

### Deposit USDC (Circle testnet)

| # | Langkah | Harapan |
|---|---|---|
| 🔲 3B.7 | Ambil USDC testnet dari **`faucet.circle.com`** (jaringan Stellar Testnet) ke alamat Freighter kamu | Saldo USDC Circle (issuer `GBBD47IF…FLA5`) masuk ke wallet |
| 🔲 3B.8 | Tab **Crypto** → pilih **USDC** → *Prepare* | `/deposit/circle/prepare` menambahkan **trustline** cIDR/USDC di alamat Castel kamu |
| 🔲 3B.9 | Kirim USDC dari Freighter ke alamat Castel → *Convert* | `/deposit/circle/convert` mengkredit **cIDR di reference rate**; saldo rupiah naik |
| 🔲 3B.10 | Cek riwayat → link on-chain | Transfer USDC sungguhan + penerbitan cIDR; **tidak lewat DEX** |

> Ini **bukan** jalur `/fx/swap`. Swap DEX (path payment) hanya dipakai untuk menukar **USDC yang sudah dipegang** menjadi rupiah — lihat catatan arsitektur. Deposit XLM/USDC di atas menerbitkan cIDR langsung.

---

## 4. Bayar QRIS — 🔲 manual

| # | Langkah | Harapan |
|---|---|---|
| 🔲 4.1 | Wallet → **Pay QRIS** → *Use sample* | Warung Made Bali · Bali · **Rp 85.000** |
| 🔲 4.2 | Tap **Pay Rp 85.000** | Modal PIN muncul |
| 🔲 4.3 | PIN **salah** | ❌ `wrong pin` |
| 🔲 4.4 | PIN **benar** | ✅ **Paid**, saldo berkurang |
| 🔲 4.5 | Lihat struk | Baris **"Merchant settlement"** → `PENDING` · Xendit · BCA + ID disbursement |
| 🔲 4.6 | Kembali ke wallet | Bar plafon naik: *"Rp 85.000 of Rp 16.500.000 spent"* |

### Jalur cadangan — Quick Pay (scan → bayar tanpa saldo)

| # | Langkah | Harapan |
|---|---|---|
| 🔲 4.7 | Pay QRIS saat saldo **kurang** | 🎯 Muncul *"Not enough balance"* + tombol **"Top up with card →"** (Quick Pay) |
| 🔲 4.8 | Lanjut Quick Pay: bayar tagihan dengan kartu (`4242…`) | Stripe menagih **persis sebesar tagihan**; cIDR diterbitkan **langsung di reference rate** (tanpa DEX) via `/pay/quick/create` → `/pay/quick/confirm` |
| 🔲 4.9 | Cek riwayat | Baris ber-tag **"Quick Pay"** dengan **tx hash Stellar** sungguhan; merchant tetap dibayar rupiah lewat Xendit |

---

## 5. Cash-out (Soroban escrow) — 🔲 manual

| # | Langkah | Harapan |
|---|---|---|
| 🔲 5.1 | Wallet → **Get cash** → `500000` → *Request cash* | Modal PIN |
| 🔲 5.2 | Masukkan PIN | QR pickup muncul |
| 🔲 5.3 | Buka `/agent` di tab lain → scan/paste QR-nya | Tiket: agen terima **Rp 495.000**, fee Rp 5.000 |
| 🔲 5.4 | *Release* | ✅ Dana lepas dari escrow on-chain |
| 🔲 5.5 | Coba release **lagi** | ❌ `already paid out` |

---

## 6. Plafon Tier 0 (Simplified CDD) — ✅ terverifikasi di produksi

| # | Tes | Hasil |
|---|---|---|
| ✅ 6.1 | Top-up `$2000` | `single top-up limit is Rp 16.500.000 — verify your passport to raise it` |
| ✅ 6.2 | Cash-out `Rp 20.000.000` | `403` |
| ✅ 6.3 | Agregasi 30 hari | Rp 0 → bayar Rp 85.000 → `spentIdr: 85000`, `remainingIdr: 16.415.000` |
| ✅ 6.4 | 11 request auth beruntun | `401`×10 lalu **`429`** |
| ✅ 6.5 | `/fund` di atas cap $500 | `400` |

---

## 7. Serangan — ✅ semua terverifikasi di produksi

| # | Serangan | Hasil |
|---|---|---|
| ✅ 7.1 | `GET /me/balance` tanpa token | `401` |
| ✅ 7.2 | `POST /pay {waNumber: "<korban>"}` | `401` — field tidak dibaca sama sekali |
| ✅ 7.3 | Token dipalsukan | `401` |
| ✅ 7.4 | Link-token dipakai sebagai session-token | `401` |
| ✅ 7.5 | Link-token kedaluwarsa | `401` |
| ✅ 7.6 | `POST /wa/webhook` tanpa signature Twilio | `403` |
| ✅ 7.7 | `POST /cashout/redeem {escrowId:1}` **tanpa kode** | `403 invalid pickup code` |
| ✅ 7.8 | Redeem dengan kode ngasal | `403` |

> **7.7 layak didemokan ke juri.** Sebelum diperbaiki, endpoint ini tanpa autentikasi *dan* jatuh balik ke kode pickup yang tersimpan di server sendiri. Karena `escrowId` berurutan, siapa pun bisa menguras seluruh escrow yang pending hanya dengan menghitung naik. Lihat `SECURITY.md`.

---

## Ringkasan

| | Jumlah | Status |
|---|---|---|
| Otomatis (security + plafon) | 13 | ✅ lulus di produksi |
| Manual (browser / kartu / WhatsApp / wallet) | 47 | 🔲 menunggu |

**Prioritaskan bagian 3** (kredit rupiah langsung dari kartu) **dan 3B** (on-ramp kripto lewat Freighter) — keduanya inti arsitektur saat ini. Selebihnya sudah pernah berjalan sebelum rombakan.

## Catatan cepat untuk hari-H

- Panaskan backend sebelum tampil (bagian 0.1).
- Penguji/juri harus `join` sandbox WhatsApp lebih dulu (bagian 0.2).
- Kartu uji: `4242 4242 4242 4242` · exp apa saja di masa depan · CVC apa saja.
- Untuk demo on-ramp kripto (3B): pasang **Freighter**, **switch ke Testnet**, danai via **Friendbot** dulu; USDC testnet dari `faucet.circle.com`.
- Xendit sandbox mengembalikan `PENDING` — itu memang benar. Settlement bersifat asinkron; sebutkan sebagai *"settlement initiated"*, jangan diklaim selesai.
