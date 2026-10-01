# Tab sementara Testing Pending

Masuk dari Riwayat Upload → Testing Pending. Tersedia Rawat Jalan dan Rawat Inap.
Memakai klaim aktif yang sudah diunggah. Pilihan Sertakan arsip juga membuka
klaim arsip agar acuan BPJS yang datang belakangan dapat dibandingkan.
Tidak menjalankan AI tambahan. Satu baris adalah satu record unggahan; hindari
menilai unggahan ulang SEP yang sama dua kali bila ingin mengukur kasus unik.

1. Pilih kategori, cari pasien/SEP, lalu buka berkas jika perlu.
2. Klik Nilai kecocokan. Catat hasil acuan, sumber, alasan dan kecocokan alasan.
3. Pilih sumber BPJS hanya jika hasilnya sudah diketahui. Penilaian verifikator
   dihitung sebagai simulasi dalam rekap berbeda.
4. Simpan. Hasil aplikasi/kode saat penyimpanan pertama dikunci dalam snapshot;
   edit acuan berikutnya tidak mengganti patokan. Status/kode/tarif klaim tidak
   berubah. Ini satu penilaian per record, belum berupa beberapa putaran eksperimen.

Ketepatan status = pasangan cocok / pasangan yang memiliki acuan dan prediksi
tegas. Belum diketahui dan prediksi belum pasti dikeluarkan dari pembagi, dengan
jumlah yang ditampilkan agar cakupan pengujian terlihat. Pending terlewat dan
peringatan berlebih dihitung terpisah. Kecocokan alasan hanya dihitung pada
pasangan yang sama-sama pending dan telah dinilai; sesuai sebagian tidak dianggap
sesuai penuh. Rekap mencakup seluruh kategori, pencarian hanya menyaring daftar.

Tidak ada persentase ketepatan sebelum acuan diisi. Jumlah sampel ditampilkan;
hasil sampel kecil bukan jaminan akurasi untuk semua kasus. Klaim yang masih
memerlukan tinjauan atau hanya valid secara format belum otomatis dinyatakan
tidak pending. Kombinasi kode berisiko tetap membawa sign pending.

API GET/PUT `/api/v1/testing-pending`, untuk role admin (termasuk superadmin),
supervisor dan verifikator, dibatasi hospital_code dari akun. Label disimpan pada
`testing_pending`, tidak pada claim_records atau claim_files. Tidak ada data
pasien/prompt yang dikirim ke penyedia AI oleh fitur ini.

Migrasi: jalankan `2026-10-02-testing-pending.sql` sebagai pemilik tabel. Berikan
akun runtime izin SELECT, INSERT, UPDATE pada tabel testing_pending; tidak perlu
superuser. Pada database baru tabel juga dibuat oleh initializeSchema.
