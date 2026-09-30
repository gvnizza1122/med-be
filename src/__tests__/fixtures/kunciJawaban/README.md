# Kunci jawaban akurasi pembacaan berkas

Format berkas yang dibaca `scripts/evaluasiKunciJawaban.js` dan
`src/services/evaluasiAkurasiService.js`. Kunci asli (sekitar 30 klaim) dibuat
manusia; berkas ini hanya format dan contoh. `example.json` berisi data tiruan.

## Kunci (dibuat manusia dari berkas klaim)

Sebuah larik. Satu objek per klaim:

```json
{
  "klaim_id": "string, unik",
  "diagnosis_benar": ["J45.9", "I10"],
  "prosedur_benar": ["87.44"],
  "nilai_lab_benar": [
    { "parameter": "Hemoglobin", "nilai": 10.2, "satuan": "g/dL", "tanggal": "2026-03-10" }
  ]
}
```

- Kode diagnosis: ICD-10 WHO. Kode prosedur: ICD-9-CM. Titik dan huruf besar/kecil
  tidak memengaruhi pencocokan (`J45.9` sama dengan `j459`).
- `nilai_lab_benar`: parameter + nilai + satuan; `tanggal` (YYYY-MM-DD) opsional tetapi
  diisi untuk rawat inap yang parameter sama diperiksa beberapa hari. Bila kunci dan
  keluaran sama-sama punya tanggal, tanggalnya harus sama.
- Jangan mengarang kode. Bila tidak yakin, jangan masukkan ke kunci; tulis di catatan.

## Keluaran sistem (ditulis skrip ekspor dari hasil pipeline)

Sebuah larik, dicocokkan dengan kunci menurut `klaim_id`:

```json
{
  "klaim_id": "string",
  "diagnosis": ["J45.9", { "kode": "J45.9", "teks": "asma bronkial", "halaman": 1, "kutipan": "Diagnosa Utama : Asma bronkial", "sumber": "cetak" }],
  "prosedur": ["87.44"],
  "nilai_lab": [{ "parameter": "Hb", "nilai": 10.2, "satuan": "g/dL", "tanggal": "2026-03-10" }],
  "halaman": [{ "page_number": 1, "ocr_text": "teks halaman apa adanya" }]
}
```

`halaman` (teks per halaman) diperlukan untuk mengukur **kode dikarang**. Tanpa itu
hasilnya `dinilai: false`, bukan 0.

## Yang diukur

| Ukuran | Arti |
| --- | --- |
| Tertangkap | kode benar yang ditemukan sistem / seluruh kode benar (recall) |
| Tepat | keluaran sistem yang benar / seluruh keluaran sistem (precision) |
| Tepat kategori | kode salah tetapi kategori sama, dihitung terpisah (`kategori_saja`). Diagnosis: 3 karakter pertama; prosedur: 2 angka pertama |
| Nilai lab tepat | parameter + nilai + satuan semuanya benar / seluruh nilai lab benar |
| Kode dikarang | kode keluaran yang tidak didukung kutipan apa pun di teks berkas. Target: nol |

Setiap ketidakcocokan juga diberi tanda tipe kesalahan bila dapat ditentukan
(1 huruf salah, 2 teks benar tempat salah, 3 salah tafsir, 4 dikarang, 5 tulisan
tangan). Tanda ini heuristik: hipotesis untuk ditinjau manusia.

## Menjalankan

```
node scripts/evaluasiKunciJawaban.js --berkas src/__tests__/fixtures/kunciJawaban/example.json
node scripts/evaluasiKunciJawaban.js --kunci kunci.json --keluaran keluaran.json [--json] [--gagal-bila-dikarang]
```

`--kunci` / `--keluaran` boleh berupa berkas larik atau folder berisi banyak `.json`.
`--berkas` memakai satu berkas berkunci `kunci` dan `keluaran` (seperti `example.json`).
