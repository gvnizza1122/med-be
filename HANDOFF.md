# HANDOFF — eClaim / medaudit.my.id (backend `eclaim-pro-be`, frontend `eclaim-production`)

Ditulis 2026-09-30 saat pindah dari Claude Code ke Codex. Bahasa kerja dengan pemilik produk: **Bahasa Indonesia**.
Aplikasi: pra-validasi klaim BPJS RS Lestari Raharja. Stack: Node/Express + PostgreSQL (backend), Next.js 16 (frontend), Docker Compose + nginx. Server: `ssh appx`, container `eclaim_api` (:60131), `eclaim_frontend` (:3000), `eclaim_postgres` (user `dbxadmin`, DB `eclaim`), compose service API = `api` di `~/eclaim/be`. `AI_MODEL` dibaca dari `.env` saat container dibuat (ganti perlu `docker compose up -d --force-recreate --no-deps api`); sekarang `gpt-6-luna`.

## Aturan keras (jangan dilanggar)
- Jangan pernah mengarang kode ICD. Diagnosis = **ICD-10 WHO** (tabel `icd10_who_codes`), prosedur = **ICD-9-CM** (`icd9_cm_procedures`). BPJS tidak memakai ICD-10-CM.
- Yang tidak tertulis di berkas tidak boleh dikodekan (mis. SpO2 88% tidak berarti oksigen diberikan).
- Kode ICD-9 di `kamusPenunjang.json` hanya USULAN (`kode_terverifikasi=false`), belum disahkan koder.
- Tidak ada gerbang "menunggu review koder" untuk pembacaan atau status pending. Persetujuan koder hanya untuk: aktivasi rule berversi (`rule_versi`) dan draf jawaban pending.
- Jangan tampilkan persentase keyakinan.
- `bpjs_pending_responses.jawaban_rs_manual` = data manual tak tergantikan; jangan pernah ditimpa.
- Backup rekap pending lama: `/home/appx/cadangan_rekap_pending_20260930_1055.sql` (berisi SEP + nomor kartu; jangan dikirim lewat chat/email).
- Verifikasi deploy dengan `grep` di image hasil build, bukan timestamp/exit code (build Docker pernah hang di SSH).
- Frontend: wajib `npm run build` sebelum push (gate JSX pakai literal `false` pernah merusak build produksi; `key` React yang sama di dua call site pernah membekukan render).
- Repo Windows/CRLF: edit berbasis baris, jaga EOL; hindari heredoc panjang dan regex dengan backslash lewat shell.
- Jest sesi Codex 2026-09-30: baseline sebelum perubahan awal 56 suite lulus / 11 gagal; sesudah item A 1089 tes lulus / 48 gagal; sesudah perbaikan label `A Diagnosa` 1091 tes lulus / 48 gagal (56 suite lulus / 11 gagal). Tidak muncul tes gagal baru. Tes terarah pagar + bagian: 134/134 lulus. OCR flaky tidak gagal pada eksekusi penuh yang tercatat.

## Status (main terakhir: `7f857b5`, sudah di-push; perbaikan pagar `A Diagnosa` sedang lokal)
Backend main berisi: pengelompokan `/claim-files/kelompok`, kamus penunjang, pemetaan WHO, pagar pasca-AI, tindakan berbasis posisi, fondasi dua model, alur pending. Frontend `aa3667e`: Riwayat Upload dikelompokkan (BELUM dilihat di browser).
Item A selesai pada commit lokal `f1b118b` (bentuk `kode_luar_kamus` dirapikan di `7f857b5`): `pastikanDiagnosisWhoService` memeriksa setiap kode DIAGLIST terhadap `icd10_who_codes` sebelum jalur keluar awal.
Perbaikan insiden SUMIDAH: `bagianTemuanService` mengenali prefiks assessment SOAP `A ` pada label diagnosis dan diagnosis banding. Tes halaman sintetis membuktikan saran `R10.4` lolos pagar dan masuk DIAGLIST; tes anamnesis tetap menolak diagnosis yang hanya disebut sebagai riwayat. Belum di-commit atau di-deploy.
**Belum tentu sudah di-deploy** — cek dulu.

### Sudah aktif di alur live (setelah deploy)
- Pemetaan kode diagnosis non-WHO → WHO (`kodeDiagnosisWhoService`, `annotateKamusValid`).
- Pagar pasca-AI (`pagarPascaAiService`): kutipan wajib ada di teks halaman, negasi (`disangkal:true`), anamnesis ≠ diagnosis, tulisan tangan ditandai, singkatan ambigu ditandai, petunjuk resep. Hasil di `ai_review.pagar_temuan` dan `ai_review.petunjuk_resep`. Saklar env: `PAGAR_TEMUAN_AKTIF` (induk; `0` = perilaku lama), `PAGAR_KUTIPAN_AKTIF`, `PAGAR_NEGASI_AKTIF`, `PAGAR_PERAN_AKTIF`, `PAGAR_TULISAN_TANGAN_AKTIF`, `PAGAR_KAMUS_PENUNJANG_AKTIF`, `PETUNJUK_RESEP_AKTIF`, `PAGAR_OCR_AMBANG_CEK` (70).
- Pembacaan label–isi berbasis posisi (mupdf word box) untuk resume PDF digital; pengecekan silang resep/triase ↔ tindakan; KW-01 (jam triase >6 jam), KD-12, KD-13; perbaikan bug KD-08 ("o2" cocok dengan "SpO2"); OCR untuk halaman ber-lapisan-teks sampah.
- Skema baru dibuat saat start (`init.js` memanggil `ensureSchema`): `kamus_penunjang`, `kamus_variasi`, `varian_belum_dikenali`, `router_model`, `catatan_panggilan_model`, `rule_versi`, `kotak_regulasi`, `aturan_koding_rs`, `pending_alasan_peta`, `pending_triase`, `draft_jawaban_pending`. **Cek log start untuk `[init] Skema ... gagal` / `Seed kamus penunjang gagal`** — semua SQL baru hanya diuji dengan DB tiruan, belum pernah jalan di Postgres asli.

### Ada tapi BELUM tersambung
- `kamusPenunjangService` (normalisasi, singkatan bertabrakan) belum dipanggil pipeline pembacaan.
- `bacaLabService` (baris lab + pemeriksa kewajaran): hook di `syaratPenunjangService` default MATI (`SYARAT_PAKAI_BACA_LAB=true` untuk menyalakan; validasi dengan PDF asli dulu).
- Router model / penyamaran (`gatewayModelService.panggilModel`): belum ada caller lama yang disambung (target: `bpjsPending.js callAi`, `aiReviewService`, `aiValidationService`, `kodeDiagnosisWhoService`, `kodeTindakanBaruService`, `kimiClient`). Kirim `dikenal` (nama, kartu, NIK, RM, SEP, alamat, telepon) dari `claim_records`. Kimi hanya diuji dengan tiruan.
- `evaluasiAkurasiService` + `scripts/evaluasiKunciJawaban.js`: alat ukur siap, belum ada kunci jawaban.
- Alur pending (`/api/v1/pending-jawaban/*`, `src/routes/jawabPending.js`): backend selesai; frontend BELUM dibuat; rekap pending kosong.
- `aturan_koding_rs`: tidak ada UI untuk mengisi.

## Pekerjaan berikutnya (urut saran)
1. **Diagnosis selalu WHO — item A selesai.** Validasi per kode ada di `src/services/pastikanDiagnosisWhoService.js`; kode asing tak terpetakan tetap ditandai di `ai_review`.
2. **Insiden SUMIDAH: klasifikasi `A Diagnosa` — perbaikan lokal selesai, belum deploy.** Sesudah deploy minta pemilik membaca ulang SEP `0170R0110826V003045`: DIAGLIST harus `R10.4`, dan `ai_review.pagar_temuan.ditolak` tidak memuat kutipan `A Diagnosa kolik abdomen` dengan alasan `hanya_riwayat_anamnesis_bukan_diagnosis`. Pastikan tes riwayat anamnesis tetap tertolak.
3. **Prosedur "jangan pernah kosong".** Tidak bisa dijamin harfiah (prosedur fiktif = risiko temuan fraud). Yang bisa: kosong tidak pernah diam-diam — tampilkan alasan eksplisit + kandidat (tindakan/penunjang terdeteksi tanpa kode pasti, mis. infus; penunjang lab/radiologi usulan) agar koder isi satu klik. Mengisi otomatis dari kode usulan belum disahkan = keputusan pemilik produk (belum diputuskan).
4. Deploy backend + frontend, lalu verifikasi (lihat di bawah).
5. Sambungkan `kamusPenunjangService` + `bacaLabService` ke pembacaan; aktifkan pembaca lab setelah dicoba pada PDF asli.
6. Frontend alur pending (kontrak API di bawah).
7. Aktifkan 4 rule Tipe 3 (KMB-01/06/09/11) setelah kode ICD diputuskan (GTCS G40.3 vs R56.8; trombositopenia D69.6 vs D69.5; pasangan angina; subkode O42).
8. Hapus kata "dokter/casemix/koder" dari artifact laporan klien (https://claude.ai/code/artifact/c78dbda4-7d0d-440e-add5-1657a276e76e) — permintaan lama, belum dikerjakan.
9. Ada ~3.218 berkas / 3,9 GB di uploads vs 45 klaim (PDF yatim). Selidiki read-only dulu; tanyakan kebijakan retensi PDF.

## Verifikasi setelah deploy
- SUMIDAH (SEP 0170R0110826V003045): Baca Ulang harus menghasilkan DIAGLIST `R10.4` (bukan `r10.84`), PROCLIST `99.29`, dan tidak boleh menolak kutipan `A Diagnosa kolik abdomen` sebagai anamnesis.
- MUNAWIR (SEP 0170R0110926V001943): unggah ulang → Tindakan terbaca "Nebulisasi Ventasal", `temuan_tindakan` nebulisasi 93.94 dengan kutipan hal 2/3/5, prosedur tidak kosong. Bandingkan koordinat mupdf vs `pdftotext -bbox` (label "Tindakan" y≈489.6, isi y≈481.5).
- Klaim dengan "Riwayat" di anamnesis: harus tetap muncul di `pagar_temuan.ditolak` dengan alasan `hanya_riwayat_anamnesis_bukan_diagnosis`. Diagnosis sah pada baris `A Diagnosa` harus lolos; bila gagal, periksa klasifikasi bagian dan jangan mematikan `PAGAR_PERAN_AKTIF`.
- Riwayat Upload: header kelompok (bulan terbaru terbuka), angka header = jumlah baris saat dibuka (Agustus rajal 25/25, ranap 9/9 di produksi), pencarian memaksa daftar datar, mode arsip.

## Uji coba akurasi (backtest) — rencana yang disepakati
Tujuan: casemix mengunggah ulang klaim lama yang hasil BPJS-nya sudah diketahui, lalu membandingkan aplikasi dengan kenyataan.
1. **Dua kelompok**: berkas yang dulu pending (positif) DAN berkas yang dulu lolos (negatif, untuk mengukur alarm palsu). Seimbang (~20/20), campuran rajal/ranap. Hanya pending = ukuran tak berguna (menandai semua akan terlihat sempurna).
2. **Bandingkan alasannya**, bukan hanya pending/tidak. Satu baris per klaim: alasan BPJS (rekap; sumber: cadangan SQL di atas), aplikasi menandai?, alasan aplikasi, alasan sama? Label: cocok penuh / pending tapi alasan beda / terlewat / alarm palsu.
3. **Bagi dua**: separuh untuk melihat kegagalan & memperbaiki, separuh disimpan tak tersentuh untuk ujian akhir (jangan menyetel aturan sampai berkas ujian lolos).
4. **Tandai "terlewat"**: bisa dilihat dari berkas, atau mustahil (verifikator/sistem BPJS di luar berkas).
5. **Aturan sesuai tanggal pelayanan**: selisih akibat aturan yang lebih baru dari saat verifikasi bukan kesalahan aplikasi.
6. Empat angka: tertangkap, alarm palsu, alasan cocok, terlewat yang mustahil dari berkas.
Kendala data: klaim Jan–Mei sudah terhapus (cari PDF di arsip RS / folder uploads server); 96 baris rekap lama menunjuk klaim yang tak ada.
Pekerjaan yang bisa dibuat: skrip/ekspor pembanding (lembar per klaim dengan 4 kolom di atas) memakai tabel `bpjs_pending_files/responses` + `pending_alasan_peta` + `ai_review`. Set kunci jawaban 30 klaim (disahkan koder) untuk `scripts/evaluasiKunciJawaban.js` tetap terpisah dan dibutuhkan; jangan dipakai sebagai contoh di prompt.

## Kontrak API alur pending (`/api/v1/pending-jawaban`, semua wajib login)
Error: `{error, kode?}` — 400 kategori/kotak tak valid, 401, 404 `tidak_ada`, 409 (`perlu_pengakuan`, `bukti_gugur`, `status_tidak_sah`), 422 (`belum_dipetakan`, `kotak_belum_ada`), 500.
- `GET /sep/statistik?pending_file_id&periode&rincian` → `{total, cocok, cocok_persis, cocok_normalisasi, klaim_tidak_ada, format, per_periode[], penjelasan, rincian[]}`
- `POST /sep/tautkan-ulang {pending_file_id?}`
- `POST /alasan/petakan {pending_file_id?, ulang?, pakai_ai?}`; `GET /alasan/ringkasan`; `PATCH /alasan/:pendingId {kategori}` (manual, tak ditimpa)
- `POST /triase/hitung`; `GET /triase/ringkasan`; `PATCH /triase/:pendingId {kotak:'A'|'B'|'C'|'D'|null, catatan}`
- `GET /daftar?pending_file_id&kotak&kategori&jenis_rawat&status_draft&search&page&limit`
- `GET /item/:pendingId` → `{pending, triase, draft, kolom:{alasan_pending, jawaban, bukti[]}, riwayat_versi}` (tiga kolom berdampingan)
- `POST /item/:pendingId/draft {pakai_ai?}`; `GET /item/:pendingId/draft`; `POST /draft/:draftId/setujui {catatan?, akui_poin_tanpa_bukti?}`; `POST /draft/:draftId/tolak`
Urutan frontend: import rekap → `/sep/statistik` → `/alasan/petakan` → `/triase/hitung` → `/daftar` → `/item/:id` → `/draft` → `/setujui`.
Aturan draf: tiap poin membawa halaman+kutipan terverifikasi; tanpa bukti = teks persis "bukti tidak ditemukan di berkas"; model hanya memilih nomor kutipan, tidak menulis teks. Kotak A/B/C/D dihitung deterministik dengan kriteria tersimpan (tanpa persentase). Aturan kata kunci & kriteria triase masih kerja awal, belum dikalibrasi.

## Keputusan yang masih milik pemilik produk
- Boleh atau tidak kode ICD-9 usulan (90.59, 87.44, 88.76, dst.) diisi otomatis ke PROCLIST sebelum disahkan koder?
- Ambang tebakan: baca-kedua (tarif Rp10 juta, keyakinan 0,7), pergeseran pending (2× rata-rata, +10 poin, ≥5 kasus), jam triase 6 jam.
- Kamus obat (`src/data/kamusObat.json`, 32 entri; Narfoz/Vometa/Gastrolan `terverifikasi:false`) perlu ditinjau apoteker/koder.
- Nama tugas model untuk `kodeDiagnosisWhoService`/`kodeTindakanBaruService` belum ada di router.

## Peta modul baru (src/services/)
`kamusPenunjangService`, `pagarTemuanService`, `pagarPascaAiService`, `negasiTemuanService`, `bagianTemuanService`, `bacaLabService`, `resepPetunjukService`, `keputusanSumberHalamanService`, `evaluasiAkurasiService`, `pdfWordBoxService`, `pasanganLabelPosisiService`, `aturanKodingRsService`, `konsistensiWaktuService`, `penyamaranService`, `routerModelService`, `gatewayModelService`, `catatanPanggilanModelService`, `ruleVersiService`, `kotakRegulasiService`, `bacaKeduaService`, `pemantauPergeseranPendingService`, `sepCocokService`, `petaAlasanPendingService`, `triasePendingService`, `buktiBerkasPendingService`, `draftJawabanPendingService`, `alurJawabPendingSchema`. Data: `src/data/kamusPenunjang.json`, `kamusObat.json`, `konsistensiAntarData.json` (KD-01..13), `syaratPenunjangDiagnosis.json`. Rute: `src/routes/jawabPending.js`, `claimFiles.js` (`/kelompok`, isi otomatis kode).
