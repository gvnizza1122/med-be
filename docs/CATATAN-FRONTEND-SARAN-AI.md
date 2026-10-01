# Catatan untuk tim: tab "Saran AI" di Diagnosis & Prosedur

Backend dan frontend **sudah diterapkan** (frontend: branch `update` di `eclaim-production`). Catatan ini berisi kontrak API, perilaku di layar, dan hal yang masih perlu ditindaklanjuti.

## Tujuan

Koder melihat **susunan kode yang paling mungkin diterima BPJS** berdasarkan isi berkas, lengkap dengan INA-CBG dan tarifnya, lalu membandingkannya dengan data klaim saat ini. Contoh kasus MUNAWIR (SEP 0170R0110926V001943): data klaim `J44.9; J18.9` disarankan menjadi **`J44.0`**, sesuai Berita Acara 2018 (aturan KMB-12).

Tab ini **hanya menampilkan saran**. Tidak ada yang mengubah DIAGLIST/PROCLIST. Kalau koder setuju, penerapannya lewat **Edit data** seperti biasa.

## Endpoint

```
GET /api/v1/claim-files/records/:recordId/saran-koding
Authorization: Bearer <token>   (sama seperti API klaim lain)
```

- Dihitung dari data tersimpan, **tanpa panggilan AI**. Cepat, dan bisa dipanggil berulang.
- Klaim lama langsung bisa dipakai tanpa Baca Ulang.
- `404` kalau record tidak ada, `500` kalau gagal disusun.

### Contoh respons (MUNAWIR)

```json
{
  "diagnosis": [
    {
      "kode": "J44.0",
      "deskripsi": "Chronic obstructive pulmonary disease with acute lower respiratory infection",
      "peran": "utama",
      "asal": ["kombinasi"],
      "bukti": [
        { "kutipan": "PPOK,", "halaman": 2, "sumber": "resume_medis" },
        { "kutipan": "Pneumonia", "halaman": 2, "sumber": "resume_medis" }
      ],
      "catatan": "J44.0 sudah mencakup PPOK dengan infeksi saluran napas bawah."
    }
  ],
  "prosedur": [
    {
      "kode": "93.94",
      "deskripsi": "Respiratory medication administered by nebulizer",
      "asal": ["proclist", "resume", "tindakan"],
      "bukti": [
        { "kutipan": "Tindakan Nebulisasi Ventasal", "halaman": 2, "sumber": "resume_medis" },
        { "kutipan": "nebul ventasal 1 ; nacl 2cc", "halaman": 5, "sumber": "triase_igd" }
      ],
      "catatan": null
    }
  ],
  "perubahan": [
    {
      "aturan": "KMB-12",
      "nama": "Pneumonia + PPOK",
      "aksi": "ganti_gabungan",
      "dari": ["J18.9", "J44.9"],
      "menjadi": "J44.0",
      "pesan": "J44.0 sudah mencakup PPOK dengan infeksi saluran napas bawah.",
      "sumber": "Berita Acara Kesepakatan 2018",
      "kutipan_sumber": "BA: J44.0 sudah menggantikan PPOK dengan infeksi saluran napas bawah"
    }
  ],
  "tidak_dipakai": [],
  "inacbg": {
    "kode": "Q-5-43-0",
    "deskripsi": "PENYAKIT KRONISBESAR LAIN-LAIN",
    "tarif": 264100,
    "catatan_tarif": null,
    "sumber": "PMK_3_2023"
  },
  "klaim_saat_ini": {
    "diagnosis": ["J44.9", "J18.9"],
    "prosedur": ["93.94"],
    "inacbg": "Q-5-43-0",
    "tarif": 264100
  },
  "sama_dengan_klaim": false,
  "selisih_tarif": 0,
  "catatan": [
    "Kode digabung/dibuang sesuai aturan kombinasi Berita Acara; terapkan ke DIAGLIST bila koder setuju.",
    "INA-CBG & tarif adalah perkiraan aplikasi (tabel PMK 3/2023), bukan hasil grouper resmi E-Klaim."
  ]
}
```

### Arti field

| Field | Arti |
|---|---|
| `diagnosis[]` | Kode ICD-10 WHO yang disarankan, **berurutan**. Elemen pertama adalah diagnosis utama (`peran: "utama"`), sisanya `"sekunder"`. |
| `prosedur[]` | Kode ICD-9-CM yang disarankan. |
| `asal[]` | Asal kode: `diaglist` / `proclist` (data klaim), `resume` (dibaca dari resume medis), `tindakan` (tindakan terbaca dari resume/triase), `kombinasi` (hasil aturan Berita Acara). Satu kode bisa punya beberapa asal. |
| `bukti[]` | Kutipan dari berkas beserta nomor halaman. `sumber`: `resume_medis` atau `triase_igd`. Resep **tidak pernah** dipakai sebagai bukti tindakan. |
| `perubahan[]` | Aturan Berita Acara yang diterapkan. `aksi` bernilai `ganti_gabungan` (beberapa kode diganti `menjadi` satu kode) atau `buang_pasangan` (kode di `dari` yang terakhir dibuang karena sudah tercakup, `menjadi` = null). |
| `tidak_dipakai[]` | Kode yang sengaja tidak disarankan, beserta `alasan`. Misalnya kode ICD-10-CM yang tidak ada di kamus WHO (J45.3), diagnosis yang disangkal berkas, atau yang belum tervalidasi kamus. |
| `inacbg` | INA-CBG dan tarif **dari kode saran**. Bisa `null` kalau belum ada diagnosis. `tarif` bisa `null` dengan penjelasan di `catatan_tarif`. |
| `klaim_saat_ini` | Kode, INA-CBG, dan tarif dari data klaim sekarang, sebagai pembanding. |
| `sama_dengan_klaim` | `true` kalau urutan diagnosis dan himpunan prosedur sama persis dengan data klaim. |
| `selisih_tarif` | Tarif saran dikurangi tarif klaim (Rp). `null` kalau salah satunya belum terhitung. |
| `catatan[]` | Kalimat penjelasan yang **wajib ditampilkan**, termasuk catatan bahwa INA-CBG adalah perkiraan, bukan grouper resmi. |

## Perilaku di layar

Letaknya di bagian **Diagnosis & Prosedur** (halaman hasil validasi, `results/[fileId]`).

1. Tambahkan dua tab: **Data berkas** (tabel yang sudah ada, default) dan **Saran AI**.
   - Tab kembali ke "Data berkas" setiap kali pindah record.
   - Endpoint dipanggil **saat tab Saran AI dibuka**, bukan saat halaman dimuat.
2. Isi tab Saran AI, dari atas ke bawah:
   - **Status:** hijau "Kode di data klaim sudah sesuai saran." kalau `sama_dengan_klaim`. Kalau tidak, kuning "Saran berbeda dari data klaim. Periksa dengan berkas, lalu terapkan lewat Edit data bila setuju."
   - **Perubahan aturan** (kalau ada): `J18.9 + J44.9 → J44.0`, beserta `pesan` dan "Sumber: Berita Acara Kesepakatan 2018 (KMB-12)".
   - **Diagnosis (ICD-10 WHO)** dan **Prosedur (ICD-9-CM)**, satu baris per kode:
     - kode, deskripsi di sampingnya (tanpa tanda "—", sama seperti tabel Diagnosis & Prosedur);
     - label Utama/Sekunder;
     - label asal, dengan teks: Data klaim / Resume medis / Tindakan terbaca / Aturan Berita Acara;
     - maksimal 3 kutipan bukti, misalnya *Resume hal. 2: "PPOK,"*.
   - **Tidak dipakai** (kalau ada): kode beserta alasannya.
   - **INA-CBG & Tarif:** dua kotak berdampingan, "Data klaim saat ini" dan "Saran AI". Masing-masing berisi daftar kode, kode INA-CBG, deskripsi, dan tarif. Kalau `selisih_tarif` tidak 0, tampilkan selisihnya (hijau kalau positif, kuning kalau negatif).
   - **Catatan:** semua isi `catatan[]` dalam teks kecil di bagian bawah.
3. Teks saat kondisi kosong:
   - memuat: "Menyusun saran koding…"
   - gagal: "Saran koding belum dapat dimuat."
   - diagnosis kosong: "Belum ada diagnosis yang terbaca dari berkas."
   - prosedur kosong: "Tidak ada tindakan yang terbaca dari resume atau triase."

**Jangan** tambahkan tombol "Terapkan saran" yang mengisi DIAGLIST/PROCLIST otomatis sebelum pembahasan DIAGLIST/PROCLIST tim selesai.

## Lokasi kode frontend

- `src/lib/api.ts`: fungsi `getSaranKoding(recordId)`.
- `src/components/SaranKodingPanel.tsx`: isi tab Saran AI.
- `src/app/(dashboard)/results/[fileId]/page.tsx`: tab "Data berkas" / "Saran AI" di `SimplifiedFieldAccordion`.

Belum dikerjakan: tab ini baru ada di tampilan ringkas (default), belum di tampilan **"Lihat tabel lengkap"**.

## Data uji di lokal

| Klaim | Yang diharapkan di tab Saran AI |
|---|---|
| MUNAWIR (0170R0110926V001943) | J44.9 + J18.9 → **J44.0** (KMB-12), prosedur 93.94 dengan bukti resume hal. 2 dan triase hal. 5, Q-5-43-0 Rp264.100, selisih 0 |
| EIFFELIN (0170R0110826V000083) | J45.3 masuk **Tidak dipakai** (kode ICD-10-CM, bukan WHO), diagnosis R06.0, prosedur 93.94 (terbaca dari berkas, belum ada di data klaim), Q-5-42-0 Rp189.200 |
| DJOKO PURNOMO (0170R0110826V000017) | N18.5 + 39.95 (hemodialisis), N-3-15-0, Rp833.000, sama dengan klaim |

## Keterbatasan yang perlu diketahui

- **INA-CBG dan tarif saran adalah perkiraan aplikasi**, bukan hasil grouper resmi E-Klaim. Pemetaan diagnosis ke kelompok rawat jalan masih heuristik; misalnya J44.0 masuk "kronis besar", padahal grouper resmi bisa memberi kelompok "paru akut". Catatan ini selalu ikut di `catatan[]`.
- Saran diagnosis bergantung pada hasil baca resume yang sudah tersimpan. Klaim yang belum pernah dibaca AI tidak punya saran dari resume, dan hanya memakai DIAGLIST.

## Lokasi kode backend

- `src/services/saranKodingService.js`: penyusun saran.
- `src/services/kamusKodeService.js`: kamus ICD-10 WHO / ICD-9-CM bersama.
- `src/routes/claimFiles.js`: route `GET /records/:recordId/saran-koding`.
- `src/__tests__/unit/saranKoding.test.js`: tes.
