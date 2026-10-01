# Penggunaan AI untuk operasional

Halaman `/penggunaan-ai` berada pada menu Administrasi, untuk admin dan superadmin.
Menampilkan total token input/output, estimasi USD/IDR, panggilan AI (termasuk retry),
rincian model/effort, tugas, jenis klaim, hari, dan unduhan CSV. Tombol Perbarui
mengambil data terbaru; membuka halaman tidak memanggil model atau memakai token AI.

API `GET /api/v1/ai-usage?month=2026-10` selalu memakai rumah sakit pada akun,
bukan parameter rumah sakit dari klien. Respons tidak berisi pasien, prompt,
jawaban AI, maupun ID record. Cache respons dinonaktifkan.

## Cara menghitung

- Angka token berasal dari `usage` jawaban penyedia, melalui gateway semua tugas.
- Total memakai `total_tokens` penyedia, atau input + output bila tidak tersedia.
- Cache bagian dari input; reasoning bagian dari output. Keduanya tidak ditambah
  lagi ke total. Tarif cache dipakai ketika penyedia melaporkannya.
- Setiap percobaan tercatat. Jawaban kosong/JSON rusak tetap masuk biaya jika
  sudah ada penggunaan token. Timeout/permintaan gagal tanpa usage tidak dianggap
  memiliki biaya nol; ditampilkan dalam jumlah catatan yang belum lengkap.
- Biaya memakai tarif dan kurs saat panggilan terjadi. Kurs dari `AI_USD_IDR`,
  saat ini 18.000. Riwayat rupiah tidak dihitung ulang ketika kurs berubah.
- Tarif model yang belum dikenal tidak ditebak. Token tetap dihitung, estimasi
  biaya kosong dan cakupannya ditampilkan. Lihat `biayaModelService.js` untuk
  tarif Standard teks yang dipakai. Estimasi bukan tagihan resmi penyedia dan
  tidak mencakup OCR, server, pajak, kredit, maupun biaya alat eksternal.
- Bulan mengikuti waktu panggilan dalam Asia/Jakarta, bukan periode klaim.
  `waktu` audit disimpan sebagai timestamp UTC. Instalasi lokal diperiksa: zona
  waktu PostgreSQL UTC. Rentang bulan diubah ke UTC sebelum filter indeks.
- Satu PDF bisa memakai beberapa panggilan. Jumlah panggilan bukan jumlah PDF.

## Instalasi / migrasi

Jalankan berurutan sebagai pemilik tabel atau akun migrasi:

1. `src/database/migrations/2026-10-02-ai-model-usage.sql`
2. `src/database/migrations/2026-10-02-ai-usage-dashboard.sql`

Jangan memberi superuser pada akun aplikasi. Audit lama yang punya input/output
dapat dijumlahkan. Token yang tidak pernah tercatat tidak dapat dipulihkan.
Migrasi kedua mengaitkan audit lama pada satu rumah sakit hanya bila gabungan
data pengguna dan berkas memiliki tepat satu kode RS. Pada instalasi yang pernah
melayani beberapa RS, jangan jalankan backfill ini tanpa memeriksa riwayat tenant;
biarkan `hospital_code` audit lama kosong jika kepemilikan tidak dapat dipastikan.
Audit tanpa rumah sakit tidak dibagikan lewat laporan rumah sakit mana pun.

Konteks RS diwariskan lewat AsyncLocalStorage per permintaan, dan worker membaca
RS dari file/record tersimpan. Metadata audit tidak dimasukkan ke prompt model.
Audit tetap best-effort: kegagalan pencatatan tidak menghentikan analisis. Pantau
peringatan `[CatatanModel] gagal mencatat` untuk mendeteksi gangguan pencatatan.
