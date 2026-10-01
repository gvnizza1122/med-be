# Luna–Sol untuk rawat jalan dan rawat inap

Pengaturan lokal yang aktif:

```env
AI_MODEL=gpt-6-luna
AI_REVIEW_MODEL=gpt-6.1-sol
AI_HYBRID_SOL_ENABLED=true
AI_SOL_SAMPLE_PERCENT=5
AI_USD_IDR=18000
```

Gateway mengirim `reasoning_effort: medium` pada analisis Luna dan `high`
pada Sol. Ekstraksi PDF memakai Luna `low`. Model lain tidak diberi parameter
effort yang belum diketahui dukungannya. Rute database yang sudah dikonfigurasi
tetap berlaku; tugas lanjutan terpisah bernama `tinjau_kasus_lanjutan`.

Setelah seluruh pemeriksaan Luna dan aturan selesai, aplikasi memanggil Sol
sekali per review yang memiliki salah satu tanda berikut:

- Diagnosis atau urutan utama–sekunder perlu klarifikasi.
- Dukungan diagnosis belum jelas atau hasil awal gagal diverifikasi.
- Diagnosis bertentangan dengan bukti atau ada konflik tindakan/prosedur berkutipan.
- Ada pola risiko klinis yang memerlukan penafsiran atau kriteria IGD borderline.
- Putusan awal perlu dicek dengan alasan klinis yang memiliki bukti.
- Permintaan pemeriksaan lanjutan oleh coder.

Selain itu, 5% hasil diagnosis yang jelas dipilih sebagai sampel kualitas
berdasarkan hash ID internal dan jenis pelayanan. Pemilihan stabil; kedua
kelompok pelayanan dinilai terpisah. Angka 20% adalah skenario anggaran,
bukan kuota: kasus ambigu tidak dihentikan setelah jumlah tersebut tercapai.
Jumlah diagnosis sendiri, field administratif kosong, atau label UMUM pada
resume dengan SEP BPJS bukan pemicu khusus Sol.

Sol menerima halaman resume, semua halaman klinis yang dikenali dan halaman
yang dirujuk oleh bukti. Teks halaman dikirim utuh, mempertahankan angka dan
negasi. Halaman administrasi yang tidak relevan dapat dikecualikan. Tidak ada
ekstraksi PDF ulang. Jika bukti resume tidak tersedia/terbaca, keluaran meminta
melengkapi atau memperbaiki pembacaan berkas; pemeriksaan tidak dianggap lulus.

Sol menilai diagnosis dan memilih alasan pending dari daftar kandidat yang
sudah tersedia. Kamus kode serta kecocokan kutipan/halaman divalidasi lagi.
Jika hasil Sol gagal, hasil awal dan tanda risiko tetap berlaku. Jika kedua
model berbeda dalam pilihan diagnosis yang sudah ditetapkan, rekomendasi kode
ditahan dan kedua alasan disimpan untuk coder. Bila putusan berbeda, alasan
risiko awal tidak dihapus. Aturan wajib dan aturan kombinasi pada kode klaim
yang belum direvisi tetap dipertahankan. Data klaim tidak otomatis diganti.

POST `/api/v1/claim-files/records/:recordId/tinjauan-diagnosis` menjalankan
pratinjau Luna dan Sol selektif pada berkas lama. Body opsional
`{"paksa_sol":true}` meminta pemeriksaan lanjutan. Pratinjau tidak menulis
kode, status klaim atau putusan pending tersimpan. Membuka tab/GET tidak
memanggil model. Upload dan analisis ulang menyimpan hasil review seperti
alur sebelumnya. Berkas lama tidak otomatis diproses ulang setelah restart.

Setiap panggilan gateway mencatat metadata ke `catatan_panggilan_model`:
model, effort, tugas, waktu, jenis klaim bila tersedia, token input/output,
cached input, token penalaran, estimasi USD/IDR dan kurs. Isi dokumen maupun
jawaban tidak dicatat. Token penalaran sudah termasuk completion, sehingga
tidak dihitung dua kali. Penggunaan respons yang gagal diparse tetap dicatat
jika penyedia mengembalikan usage. Penggunaan yang tidak tersedia tidak dapat
dianggap sebagai biaya nol. Baris audit lama tidak diisi dengan angka dugaan.

Pada database yang memakai akun aplikasi dengan izin DML saja, jalankan
`src/database/migrations/2026-10-02-ai-model-usage.sql` menggunakan pemilik tabel
atau akun migrasi sebelum menjalankan versi ini. Akun aplikasi tidak perlu
diberi hak DDL atau superuser. Migrasi lokal sudah dijalankan sebagai pemilik
tabel karena migrasi umum saat startup terhenti pada ALTER tabel users yang
dimiliki akun berbeda. Tidak ada perubahan hak akses atau data klaim.

Estimasi memakai tarif Standard teks per satu juta token:

| Model | Input | Cached input | Output termasuk penalaran |
| --- | ---: | ---: | ---: |
| Luna | $0.10 | $0.01 | $0.50 |
| Sol | $2.00 | $0.10 | $10.00 |

Input di atas 272 ribu token memakai pengali tarif sesuai dokumentasi.
Estimasi tidak mencakup pajak, tools, premium regional/fast, penulisan cache
eksplisit atau biaya penyedia selain OpenAI. Kurs Rp18.000 adalah asumsi
konfigurasi, bukan kurs pasar. Batas completion menyediakan ruang untuk
penalaran dan JSON: minimum 8.000 pada medium dan 16.000 pada high. Ini batas
atas per request, bukan jumlah token yang pasti dihabiskan.

Keberhasilan tes membuktikan alur dan pagar validasi, belum membuktikan
penurunan pending BPJS. Evaluasi bersama coder dan hasil BPJS tetap diperlukan.

Sumber resmi, diperiksa 1 Oktober 2026:

- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://developers.openai.com/api/docs/models/gpt-6.1-sol
- https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
