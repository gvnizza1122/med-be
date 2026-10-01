# Catatan untuk programmer backend: kode diagnosis di luar kamus

Tanggal pemeriksaan: 1 Oktober 2026. Investigasi dilakukan secara baca saja terhadap PDF, database lokal, dan kode aplikasi. Dokumen ini berisi temuan dan usulan perbaikan; perubahan kode aplikasi dan koreksi diagnosis pasien belum dilakukan.

## Temuan yang sudah terkonfirmasi

Kasus Eifelin, berkas `0170R0110826V000083.pdf`, halaman PDF 2 (Resume Medis IGD):

- Assessment tertulis: `Obs Dyspnea ec Asthma Attack`.
- Daftar diagnosis tercetak: `R06.0 - Dyspnoea` dan `J45.3 - Asthma with Exacerbation (IM)`.
- DIAGLIST di database dan raw_data berisi `R06.0;J45.3`. Teks PDF dan gambar halaman telah diperiksa; J45.3 memang berasal dari dokumen sumber.
- Tabel `icd10_who_codes` lokal berisi 18.542 entri. Dalam kelompok J45 ditemukan J45, J45.0, J45.1, J45.8, dan J45.9; J45.3 tidak ditemukan.
- `code_evidence` untuk J45.3 berisi `found: true` dan `review_status: VALID`, sementara `kode_luar_kamus` menandai kode yang sama bermasalah. Status record saat diperiksa adalah `pending`.
- `suggested_codes` hanya berisi saran prosedur 93.94; tidak ada saran diagnosis.
- Pemeriksaan seluruh 5 record di database lokal menemukan 1 record dengan diagnosis di luar kamus, yaitu kasus ini. Temuan ini belum mewakili berkas lain di lingkungan produksi.

## Penyebab dan celah yang ditemukan

1. **Kode dari dokumen sumber tidak sesuai kamus yang dipakai aplikasi.** Ekstraktor memang diperintahkan menyalin kode yang tertulis. Untuk kasus ini, koreksi harus mencakup pemeriksaan master diagnosis/pemetaan cetakan di SIMRS. Belum ada bukti yang memastikan apakah asalnya kode lokal, salah pemetaan, atau varian ICD lain. Jangan langsung menyebutnya hasil karangan AI.

2. **Konteks diagnosis untuk mencari padanan tidak tersedia pada jalur ini.** Di `src/routes/claimFiles.js`, fungsi `isiKodeDariSaranTervalidasi` membentuk `teksDiagnosis` hanya dari saran diagnosis AI. Pada Eifelin saran diagnosis kosong, padahal assessment dan kutipan kode ada di PDF/code_evidence. Di `src/services/kodeDiagnosisWhoService.js`, terdapat beberapa kandidat J45 dan fungsi mengembalikan null jika teks diagnosis kosong. Akibatnya J45.3 tetap belum terselesaikan.

3. **Bukti tercetak dan keabsahan kode tercampur dalam status.** `src/services/aiReviewService.js` memberikan `review_status: VALID` setelah bukti kode ditemukan, sedangkan pemeriksaan kamus menghasilkan temuan terpisah. Frontend juga memiliki `needsReview = false` pada chip bukti. Pengguna dapat melihat indikator positif pada kode yang sedang ditandai tidak sesuai kamus.

4. **Pemeriksaan kamus belum menjadi validasi seragam di semua jalur.** Pemeriksaan berbasis pola format tidak cukup untuk membuktikan kode ada di kamus. Jalur penyimpanan manual/validasi ulang perlu memakai pemeriksaan kamus yang sama; persetujuan juga perlu memeriksa kondisi record terakhir. Jangan menggantungkan validasi kamus pada keberhasilan layanan AI.

5. **Gangguan kamus berpotensi dianggap sebagai kode tidak dikenal.** `adaDiKamusWho` dalam `pastikanDiagnosisWhoService.js` mengembalikan false ketika query gagal. Tabel kosong juga dapat membuat semua kode tampak tidak dikenal. Selain itu, layanan keterangan kode membaca JSON lokal, sementara validator membaca tabel database; versinya perlu disamakan.

## Perbaikan yang diminta

1. Audit master diagnosis SIMRS untuk J45.3 dan kode lain yang tidak cocok dengan kamus target. Periksa teks diagnosis serta versi/asal kode. Koreksi mapping sumber setelah penetapan oleh koder/penanggung jawab yang berwenang.
2. Buat satu layanan validasi kamus deterministik untuk hasil ekstraksi, saran AI, edit manual, impor, validasi ulang, dan sebelum persetujuan/pengiriman klaim. Diagnosis memakai ICD-10 sesuai versi yang disepakati dengan sistem klaim; prosedur memakai ICD-9-CM yang sesuai. Catat versi, sumber, jumlah entri, dan identitas dataset. Pastikan tabel siap sebelum menyatakan hasil pemeriksaan.
3. Pisahkan hasil `evidence_found`, `dictionary_status` (valid / not_found / unavailable), dan `coding_review_status`. Kode yang tercetak tetapi tidak ditemukan di kamus ditampilkan sebagai **“Tercantum di dokumen; perlu verifikasi kode”**. Gangguan database ditampilkan sebagai **“Validasi kamus belum tersedia”**.
4. Untuk kode bermasalah, ambil konteks dari assessment/diagnosis pada resume medis dan kutipan terkait kode tersebut, bukan hanya `suggested_codes`. Simpan halaman dan kutipannya. Jika menggunakan AI, batasi kandidat pada kamus target dan verifikasi lagi hasilnya. Keanggotaan kamus saja tidak membuktikan kecocokan klinis.
5. Jangan membuat aturan penggantian massal `J45.3 → J45.9`, memotong digit, atau menghapus kode sumber otomatis. Simpan kode dan label asli; usulan kode klaim yang berbeda perlu alasan dan verifikasi koder. Pemetaan yang dipelajari dari AI perlu ditinjau sebelum digunakan ulang otomatis.
6. Setelah koreksi disetujui, perbarui nilai klaim dan tampilan terkait secara konsisten dalam transaksi; hitung ulang validasi, bukti, temuan, ringkasan pending, serta hasil pengelompokan yang terdampak. Pertahankan riwayat kode lama, kode baru, sumber, alasan, petugas, dan waktu. Jangan menimpa arsip ekstraksi asli.
7. Audit ulang klaim lama terhadap kamus yang sama dan buat antrean koreksi. Kode tidak dikenal atau belum terverifikasi tidak boleh memperoleh status siap dikirim. Peringatan baru selesai setelah masalah koding diselesaikan, bukan karena pesannya disembunyikan.

## Skenario penerimaan untuk pengujian programmer

- PDF Eifelin: J45.3 tetap tersimpan sebagai bukti sumber, ditandai tidak ditemukan di kamus target, dan assessment halaman 2 tersedia untuk peninjauan meskipun saran diagnosis AI kosong.
- Kode WHO yang ada, misalnya J45.9: lolos pemeriksaan keberadaan kode; kecocokan klinis tetap diperiksa tersendiri.
- Input manual kode tidak dikenal: dapat disimpan sebagai draf bermasalah, tetapi tidak lolos sebagai kode siap dikirim.
- Kamus kosong/tidak dapat diakses: tampil status unavailable dan tidak menyatakan diagnosis pasien salah atau kode valid.
- Koreksi yang disetujui: seluruh tampilan/status diperbarui, hasil lama tidak tertinggal, dan audit perubahan tersedia.
- Saran AI di luar daftar kandidat serta pemetaan yang belum disetujui: tidak diterapkan otomatis.
- Ulangi pada upload tunggal, batch, impor, edit manual, dan data lama.

## Referensi

- Bukti primer kasus: PDF Eifelin halaman 2 dan data lokal yang diperiksa.
- Permenkes No. 3 Tahun 2023 yang diberikan pengguna: lampiran halaman PDF 32 dan 85 mencantumkan ICD-10 versi tahun 2010 serta ICD-9-CM versi tahun 2010.
- Sumber kamus aplikasi: https://satusehat.kemkes.go.id/platform/docs/id/terminology/icd/icd-10/
- Pembanding varian Amerika: CMS mencantumkan J45.30/J45.31/J45.32 pada ICD-10-CM. Hal ini menunjukkan perlunya membedakan sistem kode, tetapi tidak membuktikan asal J45.3 pada PDF Eifelin: https://www.cms.gov/icd10m/FY2025-NPRM-Version42-fullcode-cms/fullcode_cms/P0113.html

Tidak ditetapkan kode pengganti individual untuk Eifelin dalam investigasi ini.
