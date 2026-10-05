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

## Memperbarui kamus & tarif INA-CBG (dari patch resmi)

Dipakai bila Kemenkes merilis patch E-Klaim / PMK tarif baru. Tidak butuh key,
tidak butuh E-Klaim terpasang, dan **tidak membuka berkas terenkripsi** (iDRG
`.iccdb`, grouper ber-ionCube) -- hanya tabel MyISAM terbuka di patch.

1. Unduh patch resmi dari https://inacbg.kemkes.go.id (menu Download).
2. Bongkar bagian data saja (tanpa menjalankan installer):
   ```
   innoextract -s -d x --include app/data --include tmp Patch_E-Klaim_*.exe
   ```
3. Buka tabelnya di MariaDB sementara (Docker) dan ekspor ke TSV:
   tabel `inacbg5.tariff_20230124`, `inacbg5.cclist`, `inacbg5.c51ccex` (salin
   `x/app/data/inacbg5` ke datadir, lalu `REPAIR TABLE` bila ditandai crashed) dan
   `casemix.alt_diagnosis`, `alt_procedures`, `alt_hierarchy1`, `alt_unucbg` (impor
   `x/tmp/casemix_myisam_*.sql`). Ekspor masing-masing dengan
   `mariadb --batch -e "select * from <tabel>" > <tabel>.tsv`.
4. Jalankan importer (profil tarif bisa diganti):
   ```
   node scripts/eklaim/imporReferensiInacbg.js <folder_tsv> --regional reg1 --kodeTarif DS
   ```
5. Jalankan `npm test`, lalu hapus container MariaDB sementara.

Kode tarif: `AP/AS/BP/BS/CP/CS/DP/DS` = kelas RS A–D, P = pemerintah, S = swasta;
`RSAB/RSCM/RSD/RSJP/RSPON` = RS khusus. Regional `reg1`–`reg5`.
