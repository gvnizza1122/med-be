# Penarik data E-Klaim (khusus baca)

Mengambil koding **INA-CBG dan iDRG**, hasil grouping, dan **tarif resmi** per SEP dari
E-Klaim RS, untuk backtest akurasi eClaim. Alat ini **tidak bisa mengubah** data di
E-Klaim: method selain baca ditolak oleh kodenya sendiri.

## Yang dibutuhkan

1. Komputer di jaringan RS yang bisa membuka E-Klaim di browser.
2. Node.js versi 14 atau lebih baru (`node --version`).
3. Encryption key Web Service E-Klaim (menu Setup / Integrasi SIMRS di E-Klaim).

## Langkah

1. Salin folder `scripts/eklaim` ini ke komputer tersebut.
2. Salin `.env.contoh` menjadi `.env`, lalu isi `EKLAIM_URL` dan `EKLAIM_KEY`.
   **Jangan kirim isi `.env` ke siapa pun.**
3. Uji koneksi:
   ```
   node eklaimBaca.js cek
   ```
   Harus muncul `Koneksi OK`.
4. Buat `daftar_sep.txt` berisi nomor SEP, satu per baris.
5. Tarik data klaim:
   ```
   node eklaimBaca.js klaim daftar_sep.txt
   ```
   Hasil: `hasil_klaim_eklaim.jsonl`. Kalau terhenti, jalankan perintah yang sama lagi:
   SEP yang sudah berhasil dilewati.
6. (Sekali saja) Salin kamus iDRG:
   ```
   node eklaimBaca.js kamus diagnosis
   node eklaimBaca.js kamus prosedur
   ```
7. Serahkan berkas `.jsonl` ke pengelola eClaim lewat jalur yang sama dengan data
   klaim lainnya. Nama pasien, no. kartu, no. RM, dan tanggal lahir sudah dibuang,
   tetapi SEP tetap ada.

## Bila gagal

| Pesan | Artinya |
| --- | --- |
| `EKLAIM_KEY harus 64 karakter hex` | Key belum diisi atau tidak lengkap tersalin |
| `Tanda tangan respons tidak cocok` | Key salah |
| `ECONNREFUSED` / `timeout` | Alamat `EKLAIM_URL` salah atau komputer tidak di jaringan RS |
| `HTTP 404` | Alamat benar tetapi tanpa folder `/E-Klaim/` -- periksa alamat E-Klaim di browser |
