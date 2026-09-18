/**
 * Fixture REDAKSI (bukan dokumen pasien asli) berdasarkan kasus regresi
 * hyperemesis gravidarum rawat inap (item 4-9, 18-19 Sep 2026) -- semua nama,
 * nomor kartu/SEP, alamat, telepon DIGANTI placeholder generik. Struktur teks
 * per halaman meniru pola narasi yang dilaporkan (form Triase IGD tanpa
 * kolom SpO2, KEADAAN kepala/leher/thorak/abdomen/ekstremitas, tindakan
 * IVFD asering loading, ESI 2, dehidrasi sedang di SPRI, mukosa kering di
 * Resume Medis, elektrolit Cl (H) di Lab, "USG Obgyn" di Rincian Biaya)
 * SUPAYA test regresi tetap valid tanpa menyimpan data pasien sungguhan.
 *
 * SENGAJA diletakkan di src/testFixtures/ (BUKAN di dalam src/__tests__/) --
 * default Jest testMatch mencocokkan SEMUA file .js di dalam folder
 * __tests__ manapun sebagai test suite (bukan cuma *.test.js), jadi fixture
 * data murni di dalam __tests__/ ikut "dijalankan" sebagai suite kosong dan
 * gagal ("must contain at least one test").
 *
 * page_number MENGACU ke evidencePool -- dipakai bersama di semua test yang
 * butuh kasus regresi ini (aiReviewService, diagnosisConsistencyService).
 */

const TRIASE_IGD_TEXT = `FORMULIR TRIAGE IGD
Nama Pasien: PASIEN CONTOH
No. RM: XXXXXXX

VITAL SIGN
TD 100/70 mmHg
Heart Rate 96 x/mnt
RR 20 x/mnt
Temp 36,8 C
ESI: 2

PRIMARY SURVEY
Airway: Clear
Breathing: Clear, RR 20x/mnt
Circulation: Akral hangat, CRT <2 detik
Disability: GCS 15 (E4V5M6), Compos Mentis
Exposure: Clear, tidak ada jejas/luka

KEADAAN UMUM
Leher : Tidak ada pembesaran KGB/tiroid, kaku kuduk (-)
Thorak : Simetris, tidak ada retraksi
Abdomen : Supel, BU (+) normal
Ekstremitas : Tidak ada kelainan bentuk/gerak, akral hangat

KESADARAN PASIEN / GCS
Buka mata (E): 4, Respon Verbal (V): 5, Respon Motorik (M): 6
Hasil: Compos Mentis

Skala Nyeri: NRS 3/10

TINDAKAN KEPERAWATAN
- IVFD asering loading 250cc lanjut 20tpm
- Inj omeprazole 40mg IV
- Inj ondansetron 4mg IV

Keluhan: mual muntah hebat sejak 3 hari, tidak bisa makan minum`;

const SPRI_TEXT = `SURAT PERINTAH RAWAT INAP
Nama Pasien: PASIEN CONTOH
Indikasi rawat inap: hiperemesis gravidarum dengan dehidrasi sedang, perlu terapi cairan IV dan observasi ketat.`;

const RESUME_MEDIS_TEXT = `RESUME MEDIS RAWAT INAP
Nama Pasien: PASIEN CONTOH

Diagnosis Utama: Hyperemesis Gravidarum

Pemeriksaan Fisik:
Keadaan umum: tampak lemas, kesadaran compos mentis
mukosa kering+, abd supel bu+

Terapi: IVFD, antiemetik, observasi.`;

const LAB_TEXT = `HASIL LABORATORIUM
Nama Pasien: PASIEN CONTOH

DARAH RUTIN
Hb 12.1 g/dL
Leukosit 9.800/uL

ELEKTROLIT
Na 138 mmol/L
K 3.6 mmol/L
Cl 120 (H) mmol/L`;

const RINCIAN_BIAYA_TEXT = `RINCIAN BIAYA
Nama Pasien: PASIEN CONTOH

1. Akomodasi Kelas 1 x 3 hari
2. Konsultasi Dokter Spesialis Obgyn
3. USG Obgyn
4. Pemeriksaan Darah Rutin
5. Obat-obatan`;

const BERKAS_EKLAIM_TEXT = `BERKAS KLAIM INDIVIDUAL
Nomor SEP: XXXXXXXXXXXXXXXXXXXX
DPJP: dr. CONTOH, Sp.OG
Diagnosa: O21.0
Prosedur: 88.78;90.59`;

const evidencePool = [
  { page_number: 1, ocr_text: BERKAS_EKLAIM_TEXT },
  { page_number: 2, ocr_text: SPRI_TEXT },
  { page_number: 3, ocr_text: TRIASE_IGD_TEXT },
  { page_number: 4, ocr_text: RESUME_MEDIS_TEXT },
  { page_number: 5, ocr_text: LAB_TEXT },
  { page_number: 6, ocr_text: RINCIAN_BIAYA_TEXT },
];

const triagePageNumbers = [3];
const resumeMedisPageNumbers = [4];
const procedureCodes = ['88.78', '90.59'];
const diagnosisCodes = ['O21.0'];
const umurTahun = 28;

module.exports = {
  evidencePool,
  triagePageNumbers,
  resumeMedisPageNumbers,
  procedureCodes,
  diagnosisCodes,
  umurTahun,
  TRIASE_IGD_TEXT,
  SPRI_TEXT,
  RESUME_MEDIS_TEXT,
  LAB_TEXT,
  RINCIAN_BIAYA_TEXT,
  BERKAS_EKLAIM_TEXT,
};
