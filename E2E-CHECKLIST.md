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
| 🔲 1.4 | Masukkan kode **benar** | Masuk ke wallet |
| 🔲 1.5 | Coba pakai kode yang **sama** lagi | ❌ ditolak — OTP sekali pakai |
| 🔲 1.6 | Chat bot WhatsApp: `hi` | Menu muncul — **tanpa kata "USDC" atau "exchange"** |
| 🔲 1.7 | Chat bot: `topup` → **tap link**-nya | Langsung masuk wallet + panel top-up terbuka (tanpa OTP lagi) |

---

## 2. PIN — 🔲 manual

| # | Langkah | Harapan |
|---|---|---|
| 🔲 2.1 | Lihat wallet | Banner kuning **"Set your payment PIN"** |
| 🔲 2.2 | Tap → isi PIN berbeda di dua kolom | ❌ *"PINs don't match"* |
| 🔲 2.3 | Isi PIN sama (6 digit) | ✅ Banner hilang |

---

## 3. Top-up → Rupiah langsung — 🔲 manual

> 🎯 **PALING KRITIS.** Ini satu-satunya jalur yang belum pernah diuji utuh, dan justru inti dari redesign rupiah-first. Membuat sesi Stripe yang benar-benar terbayar butuh browser + kartu, jadi tidak bisa diotomasi.

| # | Langkah | Harapan |
|---|---|---|
| 🔲 3.1 | Tap **"+ Add money"** → isi `100` | Preview: **"You get Rp 1.6xx.xxx"** + **"vs money changer +Rp xx.xxx"** |
| 🔲 3.2 | *Top up with card →* → kartu **4242 4242 4242 4242**, exp `12/34`, CVC `123` | Redirect kembali ke wallet |
| 🔲 3.3 | Lihat saldo | 🎯 Saldo dalam **RUPIAH**. Toast: *"Rp 1.6xx.xxx added — Rp xx.xxx more than a money changer"* |
| 🔲 3.4 | Cek tidak ada USDC nyangkut | 🎯 Tidak ada baris *"USDC waiting to be exchanged"*. Tidak ada seksi *"Exchange to rupiah"* |
| 🔲 3.5 | Cek riwayat | `+Rp 1.6xx.xxx` (bukan `+$100`), ada link **"View on-chain ↗"** |
| 🔲 3.6 | Tap link on-chain | Stellar Explorer menampilkan path payment sungguhan |

> Kalau **3.4 gagal** (USDC nyangkut), auto-swap bermasalah — laporkan.

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

### Jalur cadangan (ide "scan → pay")

| # | Langkah | Harapan |
|---|---|---|
| 🔲 4.7 | Pay QRIS saat saldo **kurang** | 🎯 Muncul *"Not enough balance"* + tombol **"Top up with card →"** |

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
| Manual (browser / kartu / WhatsApp) | 25 | 🔲 menunggu |

**Prioritaskan bagian 3.** Selebihnya sudah pernah berjalan sebelum rombakan.

## Catatan cepat untuk hari-H

- Panaskan backend sebelum tampil (bagian 0.1).
- Penguji/juri harus `join` sandbox WhatsApp lebih dulu (bagian 0.2).
- Kartu uji: `4242 4242 4242 4242` · exp apa saja di masa depan · CVC apa saja.
- Xendit sandbox mengembalikan `PENDING` — itu memang benar. Settlement bersifat asinkron; sebutkan sebagai *"settlement initiated"*, jangan diklaim selesai.
