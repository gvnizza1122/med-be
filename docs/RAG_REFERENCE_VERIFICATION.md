# Referensi RAG dengan sumber dan hasil terverifikasi

Perubahan ini tidak menghapus arsip lama dan tidak menetapkan outcome dari confidence AI.
Migrasi aditif `src/database/migrations/2026-10-02-rag-reference-verification.sql`
juga dijalankan oleh migrasi startup backend. Restart/deploy backend diperlukan agar
skema dan perilaku ini digunakan di lingkungan tujuan. Belum diterapkan ke produksi.

## Penggunaan referensi

- Draft AI, arsip impor, dan data legacy awalnya `unverified` dan tidak diambil sebagai
  referensi keputusan. Pola error yang digeneralisasi AI juga tidak otomatis diambil.
- Jawaban asli tersimpan dalam `draft_berhasil` (nama kolom legacy); nama ini tidak lagi
  diperlakukan sebagai bukti keberhasilan. Impor PDF menyimpan teks sumber di `source_text`.
- `source_pending_id`, `source_kind`, dan hash alasan+jawaban mempertahankan versi sumber.
  Draft AI, jawaban manual RS, jawaban edit manusia, dan jawaban yang dikonfirmasi dibedakan.
- Petugas menetapkan hasil melalui endpoint status pending yang sudah ada. Status
  `diterima`/`ditolak` atau outcome `approved`/`rejected` menyimpan identitas petugas dan
  waktu konfirmasi. Ini adalah konfirmasi petugas, bukan validasi dokumen hasil otomatis.
- Jawaban yang diedit tanpa hasil eksplisit, pencabutan hasil, atau generate ulang
  membatalkan hasil sebelumnya. Pembaruan status dan sinkronisasi RAG dilakukan dalam
  transaksi; retrieval juga memeriksa versi jawaban dan outcome sumber terbaru.
- Data lama tidak disahkan oleh request kosong. Konfirmasi eksplisit pada kasus sumber
  membuat snapshot jawaban yang dapat digunakan. Jangan mengisi hasil yang belum diketahui.
- Backfill jawaban manual membuat referensi terhubung sumber tanpa bergantung pada Kimi.
  Arsip PDF mandiri tetap perlu dipasangkan ke kasus sumber dan dikonfirmasi sebelum
  dapat digunakan; tidak ada pencocokan otomatis terhadap legacy berdasarkan alasan saja.

## Pemilihan dan batas

Jenis klaim wajib sama (RJ/RAWAT_JALAN atau RI/RAWAT_INAP). Referensi harus memiliki
hasil diterima/ditolak yang dikonfirmasi petugas, serta cocok berdasarkan kategori masalah
atau irisan istilah alasan dengan konteks klaim. Confidence model tidak menentukan peringkat.
Kasus dengan SEP yang sama atau pending ID yang sama dikecualikan. Duplikat isi+hasil
hanya dikirim sekali. Maksimal 5 contoh dan 6.000 karakter teks referensi; draft pending
mengambil maksimal 3 contoh. Anggaran ini karakter, bukan token yang diukur tokenizer.
Pencarian awal dibatasi 300 referensi terverifikasi terbaru per jenis klaim. Belum memakai
pencarian embedding atau pemeriksaan masa berlaku regulasi.

Tidak ada kecocokan berarti review berjalan tanpa referensi historis, tanpa mengambil
contoh acak. Hasil diterima dan ditolak ditulis eksplisit; fakta pasien tetap harus berasal
dari dokumen kasus sekarang. Poin ringkasan AI tidak dikirim sebagai fakta sumber.
Pemeriksaan kutipan dan kamus yang sudah ada tetap digunakan.

## Tinjauan pola error

Admin/supervisor dapat mengesahkan atau mencabut pola setelah memeriksa sumber:

`PATCH /api/v1/records/rag/knowledge/:id/verification`

Body: `{ "verified": true, "note": "Catatan pemeriksaan terhadap sumber/aturan..." }`.
Catatan minimal 10 karakter, disimpan bersama petugas dan waktu. Belum ada tombol UI
baru untuk endpoint ini. Pola terverifikasi dilindungi dari pruning pola otomatis.

## Pengujian dan tindak lanjut

Uji mencakup pemisahan draft/hasil, jenis klaim, relevansi, kasus sendiri, duplikat,
anggaran karakter, label ditolak, versi jawaban, konflik status/outcome, sumber asli,
konfirmasi petugas, dan pola error yang belum ditinjau.
Migrasi SQL belum diuji pada PostgreSQL produksi. Pengujian tidak memanggil API model.

Sesudah deploy, referensi RAG mungkin kosong sampai petugas mengonfirmasi sumber.
Siapkan kasus uji di luar basis referensi dan bandingkan akurasi serta biaya per klaim.
Hasil AI yang sudah tersimpan tidak otomatis dihitung ulang; lakukan review ulang secara
terpilih setelah skema dan sumber terverifikasi siap.
