# eClaim — Status & Rencana Kerja

_Diperbarui: 21 Jul 2026_ · RS Lestari Raharja (Kode RS `3371084`) · target ~5.000 berkas/bulan
_Branch aktif: `feat/ai-ekstraksi-pdf` (3 commit, belum merge ke `master`)_

> **Dokumen ini adalah titik lanjut antar perangkat.** Sesi Claude Code tersimpan lokal di tiap PC dan tidak tersinkron, jadi status kerja dibawa lewat file ini. Baca dari atas; semua task ditulis mandiri agar bisa dikerjakan tanpa konteks sesi sebelumnya.

---

## 🚦 MULAI DARI SINI

**Posisi sekarang: fondasi ekstraksi selesai, fitur inti belum.**
Aplikasi sudah bisa: terima PDF → ekstrak jadi 60 kolom vClaim → simpan.
Aplikasi **belum** bisa: menunjukkan field mana yang bermasalah, dan memberi saran perbaikan.

**Langkah berikutnya (bisa dikerjakan sekarang, tanpa DB & tanpa API berbayar):**
→ **Tahap 2 — Form verifikasi berbasis eksepsi.** Lihat bagian "Rencana" di bawah.

**Dua penghambat yang butuh tindakan user:**
1. **Database** — Docker bermasalah di laptop. Alternatif: pasang PostgreSQL langsung di Windows (tanpa Docker). Tanpa ini, tes E2E (login/upload) tak bisa dijalankan.
2. **API berbayar** — `openrouter/free` memilih model gratis acak; ~10–20% gagal walau sudah retry 3×. Keandalan tak bisa dibuktikan sampai pakai model tetap berbayar.

---

## 🔒 KEPUTUSAN TERKUNCI (jangan dibahas ulang)

1. **Validasi = rule engine.** Deterministik, gratis, tanpa halusinasi. AI tidak dipakai untuk memutuskan valid/tidak.
2. **AI untuk ekstraksi + saran audit**, bukan untuk mengambil keputusan.
3. **Sumber data = halaman "Berkas Klaim Individual"** (output E-Klaim, sudah ter-kode ICD-10/ICD-9/INA-CBG/tarif).
4. **Tidak ada perbaikan otomatis. Tidak ada callback ke SIMRS.** Verifikator/coder yang memutuskan; aplikasi hanya menampilkan.
5. **Jalur utama = PDF** (bukan JSON). Yang dikirim ke vClaim memang PDF; `sample_simrs.json` hanya uji coba.
6. **Audit = model (b):** cek apakah koding didukung dokumen & sudah optimal — bukan menghitung ulang INA-CBG (grouper E-Klaim adalah otoritasnya).
7. **Rambu anti-upcoding (wajib):** saran hanya boleh menunjuk kode yang **ada bukti tertulisnya**, wajib menyebut halaman/kalimat bukti, dan **dilarang menyebut dampak rupiah**.

---

## ✅ SELESAI (branch `feat/ai-ekstraksi-pdf`)

| Commit | Isi |
|---|---|
| `7d9e029` | Klasifikasi halaman + service ekstraksi awal |
| `57582d1` | Skema vClaim + retry + perbaikan classifier |
| `8d89eac` | Sambung pipeline ke endpoint + bersihkan pesan teknis |

**1. Skema vClaim (`be/src/services/vclaimSchema.js`)**
Diturunkan dari **495 record vClaim asli** (file Des 2025 + Jan 2026), bukan tebakan. Terverifikasi: 60 kolom, urutan identik, `DD/MM/YYYY`, separator `;`, placeholder per-kolom (`None`/`-`/`0`). Struktur kedua file **identik** → sah dijadikan acuan.

**2. Klasifikasi halaman (`pdfPageClassifier.js`)**
Pakai `pdf-parse` (sudah terpasang). Halaman <50 karakter = SCAN, sisanya NATIVE. Mengambil halaman ber-keyword klaim + halaman DPJP. Teruji di 5 PDF.

**3. Ekstraksi AI (`pdfExtractionService.js`)**
Retry 3× + backoff + timeout 60 detik. Model diganti lewat env saja. Kolom bersumber sistem **tidak pernah dikarang** model.

**4. Pipeline & endpoint (`pdfExtractionPipeline.js`, `claimFiles.js`)**
`POST /api/v1/claim-files/upload-pdf` kini memakai pipeline yang benar. Tanggal vClaim dikonversi ke ISO untuk kolom DB.

**5. Bahasa awam di seluruh UI**
23 kebocoran `err.message` diganti bahasa awam; 20 `console.error` dikembalikan agar detail teknis tetap masuk log server. `api.ts` diberi pesan cadangan per status + pesan jaringan putus.

**Terverifikasi:** semua file backend lolos `node --check`, semua route termuat, **frontend build sukses** (TypeScript bersih, 14 halaman).

---

## 📊 HASIL UJI NYATA (5 PDF asli)

```
Klasifikasi : 5/5 berhasil
Ekstraksi   : 52/60 kolom terisi
DPJP        : dr. Ronald Sp.OT · dr. Gunawan Sp.OG · dr. Sri Yuni Hartati
              dr. Riza Pahlevi · dr. Jati Rimba Agung
Kode terbukti ada di sumber (bukan halusinasi):
  DIAGLIST  O42.1;O68.0;O82.1;Z37.0 · H26.9;I10 · D21.0 · Z47.0 · D21.2
  PROCLIST  74.1;75.32;90.59;88.78 · 13.71;90.59;89.52 · 78.63;90.59;89.52
Biaya       ~3.500 token/klaim (~$0,001)
Keandalan   ~80–90% (model gratis) — BELUM layak produksi
```

### Batas atas yang realistis: **53/60**, bukan 60/60
7 kolom digenerate sistem E-Klaim saat submit, **tidak ada di dokumen mana pun**:
`CODER_ID`, `VERSI_INACBG`, `VERSI_GROUPER`, `C1`, `C2`, `C3`, `C4`
Ditambah `TARIF_RS` (tarif RS sendiri, berbeda dari `TARIF_INACBG`; tak tercetak di halaman klaim).
→ **Form verifikasi sebaiknya menampilkan 52 kolom**, sisanya ditandai "diisi sistem saat submit".

---

## 🔬 TEMUAN PENTING (jangan diulang risetnya)

**1. Halaman "scan" ternyata dokumen TERCETAK, bukan tulisan tangan.**
Diperiksa visual: lab hematologi, lab HBsAg, EKG, CTG — semua cetak, terbaca ~100%. Tulisan tangan asli hanya di Catatan Pemberian Obat (terbaca sebagian, ragu di dosis/jam).

**2. OCR TIDAK menambah satu pun kolom vClaim.** Halaman scan berisi data klinis (Hb, EKG, obat), bukan kolom klaim. OCR berguna untuk **audit** (bukti pendukung kode prosedur), bukan ekstraksi.
Contoh: `PROCLIST 89.52` (EKG) ← buktinya lembar EKG; `90.59` (lab) ← buktinya hasil lab.
→ Pakai **Tesseract lokal (gratis)**, jangan vision API (biaya naik ~12×, $3–8 → $40–100/bulan).

**3. `pdfjs-dist` v4 tidak jalan di CommonJS.** Sudah dicoba, gagal (`Cannot find module`, lalu `Buffer vs Uint8Array`). Jangan diulang — pakai `pdf-parse`.

**4. Duplikasi berbahaya sudah dihapus.** `geminiExtractionService.js` (62 kolom, `ALAMAT`, `YYYY-MM-DD`, separator `|` — semua salah) dipakai diam-diam oleh `pdfParser.js`. Sudah dihapus dan jalurnya disatukan.

**5. Model gratis membalas teks penalaran, bukan JSON.** Sudah dibentengi system prompt + `response_format` + retry; tetap lolos ~10–20%.

**6. File `.txt` vClaim = acuan FORMAT, bukan acuan NILAI.** Kelima PDF Juni 2026, kedua txt Nov 2025–Jan 2026 → **nol irisan**. Untuk membuktikan nilai ekstraksi benar, perlu txt vClaim periode Juni 2026.

---

## 📋 RENCANA KERJA

### Tahap 1 — Keandalan ekstraksi ⚠️ separuh
- [x] Retry + backoff + timeout
- [x] Model bisa diganti lewat env
- [ ] **Pasang model berbayar** → `AI_MODEL=google/gemini-2.5-flash-lite`, isi saldo OpenRouter $5–10
- [ ] Ukur ulang keandalan (target: ≥99% sukses)

### Tahap 2 — Form verifikasi berbasis eksepsi ❌ **KERJAKAN INI DULU**
Tanpa ini beban verifikator **tidak turun** — 60 field × 5.000 klaim = 300.000 pengecekan.
- [ ] Jalankan rule engine atas record hasil ekstraksi
- [ ] Tandai tiap field: **hijau** (lolos, terlipat) / **merah** (kosong, format salah, tak lolos aturan)
- [ ] UI: tampilkan **hanya yang merah**; hijau disembunyikan di balik "tampilkan semua"
- [ ] Tampilkan 52 kolom; 8 kolom sistem ditandai "diisi sistem saat submit"
- [ ] Verifikator bisa memperbaiki nilai sebelum divalidasi

### Tahap 3 — OCR bukti pendukung ❌
- [ ] Pasang Tesseract (bahasa `ind`)
- [ ] OCR halaman **tercetak** saja (lewati yang tulisan tangan)
- [ ] Simpan teks OCR per halaman sebagai bahan bukti audit

### Tahap 4 — Audit (b) + rambu anti-upcoding ❌
- [ ] Bandingkan `DIAGLIST`/`PROCLIST` dengan bukti dokumen
- [ ] Tampilkan: kode diklaim tanpa bukti · bukti ada tapi belum dikoding
- [ ] **Wajib** sertakan kutipan + nomor halaman sebagai bukti
- [ ] **Dilarang** menyebut nominal rupiah dalam saran
- [ ] Saran tanpa bukti → jangan ditampilkan sama sekali
- [ ] UI menegaskan: ini saran, keputusan tetap di coder/verifikator

### Tahap 5 — Uji menyeluruh ❌ (terhalang DB)
- [ ] Siapkan PostgreSQL (tanpa Docker bila perlu)
- [ ] Login, upload PDF sah, PDF rusak, bukan-PDF, berkas >20 MB
- [ ] Pindah antar menu, refresh di tengah proses, klik ganda
- [ ] Pastikan tak ada halaman kosong & tak ada istilah teknis muncul

### Tahap 6 — Deploy ❌
- [ ] Merge `feat/ai-ekstraksi-pdf` → `master`, push
- [ ] Backup DB produksi dulu
- [ ] Deploy, verifikasi, pantau

---

## 📌 REFERENSI TEKNIS

**Struktur inti (`be/src/services/`)**
| File | Fungsi |
|---|---|
| `vclaimSchema.js` | Skema 60 kolom + `buildRecord()` + `toTSV()` |
| `pdfPageClassifier.js` | Pisah halaman, deteksi SCAN/NATIVE, ambil halaman klaim |
| `pdfExtractionService.js` | Panggil AI + retry, hasilkan 1 record vClaim |
| `pdfExtractionPipeline.js` | Gabungan keduanya + pesan bahasa awam (`PESAN`) |
| `ruleEngine.js` | Validasi deterministik (dipakai Tahap 2) |
| `pdfParser.js` | Parser regex lama — hanya cadangan |

**Env AI (`be/.env`)**
```
OPENROUTER_API_KEY=...          # wajib
AI_BASE_URL=https://openrouter.ai/api/v1
AI_MODEL=openrouter/free        # ganti ke google/gemini-2.5-flash-lite
AI_MAX_ATTEMPTS=3
AI_TIMEOUT_MS=60000
```

**Batas ukuran upload:** `/upload-pdf` 20 MB (`claimFiles.js`), `/upload` 10 MB, `/upload-batch` 50 MB × 200 berkas, `/simrs/ingest` 10 MB.

**Berkas contoh:** `data-claim/data-dari-simrs/` (5 PDF Juni 2026) · `data-claim/data-dari-vclaim/` (2 TXT acuan format) · `data-claim/hasil-ekstraksi-ai.TXT` (keluaran uji)

**Produksi:** server `209.182.237.246`, container `eclaim_api` :60131 · `eclaim_frontend` :60132 · `eclaim_postgres`.
⚠️ **JANGAN sentuh** `~/blue` dan container `blue_*` (sistem lain di server yang sama).
⚠️ `build.sh`/`deploy.sh` **selalu** mencetak "✅ success" walau gagal — periksa exit code, jangan percaya baris itu.

**Aturan kerja:** satu sesi Claude Code aktif dalam satu waktu (sesi paralel pernah saling menimpa file). Satu branch per tugas.
