// Registry jenis field vClaim — fondasi untuk badge status field yang lebih
// akurat dari sekadar "Valid" untuk semua field yang tidak kosong. Secara
// konsep field-field vClaim itu 6 jenis berbeda dengan makna "kosong" yang
// beda-beda:
//
// - salin        : disalin apa adanya dari dokumen. Kosong = OCR/ekstraksi bermasalah.
// - turunan       : dihitung dari field lain (JANGAN diekstrak dari dokumen). Kosong = bug perhitungan.
// - konfigurasi   : dari Profil RS, sama untuk semua klaim (Kode RS, Kelas RS, Payor ID). Tidak pernah dari dokumen.
// - koding        : kalimat klinis -> kode ICD/prosedur. WAJIB persetujuan koder sebelum tersimpan, WAJIB kutipan sumber.
// - fakta_nol     : nilainya memang 0, itu informasi valid (mis. ICU_INDIKATOR=0 untuk pasien tidak masuk ICU) -- beda dari kosong.
// - wajar_kosong  : memang tidak berlaku untuk klaim jenis ini (mis. ADL1/ADL2 untuk kasus non-subakut/kronis).
//
// PENTING: modul ini MURNI data (belum diwiring ke endpoint API/frontend --
// itu tugas terpisah). Kunci HARUS persis sama dengan kunci UPPERCASE di
// raw_data (lihat vclaimSchema.js / VCLAIM_SCHEMA untuk daftar resmi 57
// kolom vClaim yang dipakai aplikasi ini).

/**
 * @typedef {'salin'|'turunan'|'konfigurasi'|'koding'|'fakta_nol'|'wajar_kosong'} FieldJenis
 * @typedef {{ jenis: FieldJenis|null, catatan?: string, perlu_konfirmasi?: boolean }} FieldTypeEntry
 */

/** @type {Record<string, FieldTypeEntry>} */
const FIELD_TYPE_REGISTRY = {
  // ─── salin: disalin apa adanya dari dokumen ──────────────────────────────
  NAMA_PASIEN: { jenis: 'salin' },
  MRN: { jenis: 'salin' },
  BIRTH_DATE: { jenis: 'salin' },
  SEP: { jenis: 'salin' },
  NOKARTU: { jenis: 'salin' },
  DPJP: { jenis: 'salin' },
  // Diklasifikasikan sendiri (tidak ada di tabel pemetaan yang diberikan):
  // ADMISSION_DATE tercetak apa adanya di dokumen (Tanggal Masuk/Tanggal
  // Pelayanan di SEP/Resume Medis), bukan hasil hitung -- sama seperti
  // BIRTH_DATE/DISCHARGE_DATE untuk kasus rawat jalan, lihat catatan di
  // pdfExtractionService.js aturan 8b.
  ADMISSION_DATE: { jenis: 'salin' },

  // ─── turunan: dihitung dari field lain, JANGAN diekstrak dari dokumen ───
  SEX: { jenis: 'turunan' },
  KELAS_RAWAT: { jenis: 'turunan', catatan: 'Dari "Kls Hak" (kelas hak kepesertaan BPJS) untuk rawat jalan/IGD, atau "Kelas Rawat" ruangan untuk rawat inap -- lihat aturan 8 di pdfExtractionService.js.' },
  UMUR_TAHUN: { jenis: 'turunan' },
  UMUR_HARI: { jenis: 'turunan' },
  DISCHARGE_DATE: { jenis: 'turunan' },
  DISCHARGE_STATUS: { jenis: 'turunan' },
  LOS: { jenis: 'turunan' },
  DESKRIPSI_INACBG: { jenis: 'turunan' },
  TARIF_INACBG: { jenis: 'turunan' },
  TOTAL_TARIF: { jenis: 'turunan' },

  // ─── konfigurasi: dari Profil RS, sama untuk semua klaim ────────────────
  KODE_RS: { jenis: 'konfigurasi' },
  KELAS_RS: { jenis: 'konfigurasi' },
  PAYOR_ID: { jenis: 'konfigurasi' },

  // ─── koding: kalimat klinis -> kode ICD/prosedur, wajib persetujuan koder + kutipan ─
  DIAGLIST: { jenis: 'koding' },
  PROCLIST: { jenis: 'koding' },
  INACBG: { jenis: 'koding' },

  // ─── fakta_nol: nol adalah nilai wajar/valid, BUKAN kosong-tidak-ada-data ─
  ICU_INDIKATOR: { jenis: 'fakta_nol' },
  ICU_LOS: { jenis: 'fakta_nol' },
  VENT_HOUR: { jenis: 'fakta_nol' },
  TARIF_POLI_EKS: { jenis: 'fakta_nol' },

  // ─── wajar_kosong: memang tidak berlaku untuk klaim jenis ini ───────────
  BIRTH_WEIGHT: { jenis: 'wajar_kosong', catatan: 'Cuma berlaku untuk neonatus.' },
  ADL1: { jenis: 'wajar_kosong' },
  ADL2: { jenis: 'wajar_kosong' },
  SP: { jenis: 'wajar_kosong' },
  SR: { jenis: 'wajar_kosong' },
  SI: { jenis: 'wajar_kosong' },
  SD: { jenis: 'wajar_kosong' },
  DESKRIPSI_SP: { jenis: 'wajar_kosong' },
  DESKRIPSI_SR: { jenis: 'wajar_kosong' },
  DESKRIPSI_SI: { jenis: 'wajar_kosong' },
  DESKRIPSI_SD: { jenis: 'wajar_kosong' },
  TARIF_SP: { jenis: 'wajar_kosong' },
  TARIF_SR: { jenis: 'wajar_kosong' },
  TARIF_SI: { jenis: 'wajar_kosong' },
  TARIF_SD: { jenis: 'wajar_kosong' },
  IN_SP: { jenis: 'wajar_kosong' },
  IN_SR: { jenis: 'wajar_kosong' },
  IN_SI: { jenis: 'wajar_kosong' },
  IN_SD: { jenis: 'wajar_kosong' },
  SUBACUTE: { jenis: 'wajar_kosong' },
  CHRONIC: { jenis: 'wajar_kosong' },
  // Diklasifikasikan sendiri: TARIF_SUBACUTE/TARIF_CHRONIC tidak eksplisit
  // disebut di tabel yang diberikan, tapi jelas sepasang dengan
  // SUBACUTE/CHRONIC (tarif cuma relevan kalau flag SUBACUTE/CHRONIC aktif)
  // -- penalaran sama seperti TARIF_SP/SR/SI/SD yang eksplisit wajar_kosong.
  TARIF_SUBACUTE: { jenis: 'wajar_kosong' },
  TARIF_CHRONIC: { jenis: 'wajar_kosong' },
  KODE_TARIF: { jenis: 'wajar_kosong', catatan: 'Hanya ada di lembar hasil grouper.' },

  // Diklasifikasikan sendiri: TARIF_RS, CODER_ID, VERSI_INACBG, VERSI_GROUPER,
  // C1-C4 (lihat VCLAIM_SCHEMA source:'system' & VCLAIM_FILLED_COLUMNS di FE)
  // diisi OTOMATIS oleh sistem vClaim BPJS sendiri SAAT SUBMIT -- bukan
  // disalin dari dokumen, bukan dihitung oleh aplikasi ini, dan bukan dari
  // Profil RS. Tidak ada satupun dari 6 jenis yang pas 100% untuk ini; dari
  // sudut pandang "makna kosong", kosong SEBELUM submit ke BPJS adalah wajar
  // (field ini memang belum berlaku/belum terisi sampai proses submit
  // eksternal terjadi) -- itu sebabnya dipetakan 'wajar_kosong', BUKAN
  // 'turunan' (aplikasi ini sendiri tidak menghitungnya).
  TARIF_RS: { jenis: 'wajar_kosong', catatan: 'Diisi otomatis oleh vClaim BPJS saat submit ke sistem eksternal, bukan dihitung/diekstrak aplikasi ini -- kosong sebelum submit adalah wajar.' },
  CODER_ID: { jenis: 'wajar_kosong', catatan: 'Diisi otomatis oleh vClaim BPJS saat submit ke sistem eksternal -- kosong sebelum submit adalah wajar.' },
  VERSI_INACBG: { jenis: 'wajar_kosong', catatan: 'Diisi otomatis oleh vClaim BPJS saat submit ke sistem eksternal -- kosong sebelum submit adalah wajar.' },
  VERSI_GROUPER: { jenis: 'wajar_kosong', catatan: 'Diisi otomatis oleh vClaim BPJS saat submit ke sistem eksternal -- kosong sebelum submit adalah wajar.' },
  C1: { jenis: 'wajar_kosong', catatan: 'Diisi otomatis oleh vClaim BPJS saat submit ke sistem eksternal -- kosong sebelum submit adalah wajar.' },
  C2: { jenis: 'wajar_kosong', catatan: 'Diisi otomatis oleh vClaim BPJS saat submit ke sistem eksternal -- kosong sebelum submit adalah wajar.' },
  C3: { jenis: 'wajar_kosong', catatan: 'Diisi otomatis oleh vClaim BPJS saat submit ke sistem eksternal -- kosong sebelum submit adalah wajar.' },
  C4: { jenis: 'wajar_kosong', catatan: 'Diisi otomatis oleh vClaim BPJS saat submit ke sistem eksternal -- kosong sebelum submit adalah wajar.' },

  // ─── belum jelas jenisnya -- JANGAN ditebak (lihat instruksi tugas) ─────
  PTD: {
    jenis: null,
    perlu_konfirmasi: true,
    catatan: 'Nilainya SELALU 1 di semua klaim yang diperiksa sejauh ini (lihat VCLAIM_SCHEMA default:"1", source:"const") -- kemungkinan tidak pernah benar-benar diekstrak dari dokumen. Jenisnya belum dikonfirmasi, JANGAN ditebak.',
  },
};

module.exports = { FIELD_TYPE_REGISTRY };
