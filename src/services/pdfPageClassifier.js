// ponytail: classifier pakai pdf-parse (sudah terpasang) — pdfjs-dist v4 tak jalan di CommonJS.
// 'DPJP' & 'Dokter Penanggung Jawab' ikut: nama dokter ada di layer teks (halaman SPRI/SEP),
// bukan di halaman E-Klaim — tanpa ini kolom DPJP vClaim selalu kosong.
// 'Surat Eligibilitas Peserta' ikut: halaman SEP cetakan RS (bukan "Berkas Klaim
// Individual" E-Klaim) — sering pakai label singkat "No. SEP"/"No. Kartu" yang
// tidak cocok dengan keyword "Nomor SEP"/"Nomor Kartu" di bawah. Tanpa ini,
// halaman SEP tidak ikut masuk claimDataText, jadi AI extraction "buta" nilai
// SEP/NOKARTU walau sebenarnya ada di dokumen — muncul sebagai error "wajib diisi".
const CLAIM_DATA_KEYWORDS = ['Nomor SEP', 'Berkas Klaim Individual', 'INA-CBG', 'Total Tarif', 'Rincian Biaya', 'DPJP', 'Dokter Penanggung Jawab', 'Surat Eligibilitas Peserta'];
// Keyword tambahan untuk format PDF RS yang bervariasi
const EXTRA_KEYWORDS = ['Klaim Individual', 'Data Klaim', 'Resume Medis', 'Ringkasan Pasien Keluar', 'INACBG', 'INA CBG', 'Diagnosa', 'Prosedur', 'Kode ICD', 'Nomor Kartu', 'No. SEP', 'No. Kartu', 'No Kartu'];
// CATATAN AUDIT (belum diperbaiki, sengaja — lihat pertimbangan di bawah):
// is_primary_source dipakai claimFiles.js buat exclude halaman sumber ekstraksi
// DIAGLIST/PROCLIST dari evidence pool (cegah audit sirkular: kode "terbukti"
// cuma karena tertulis di halaman asalnya sendiri). PRIMARY_KEYWORD di bawah
// ('Berkas Klaim Individual') TIDAK PERNAH ditemukan di 150 sampel PDF produksi
// asli (RS Lestari Raharja, Jun-Jul 2026) — dokumen sungguhannya "RESUME MEDIS
// RJ"/"RESUME MEDIS IGD" (assessment dokter S/O/A/P). Sempat dicoba tambahkan
// "Resume Medis RJ/IGD" ke sini supaya exclude-nya sungguhan jalan — TAPI
// DIBATALKAN: untuk klaim rawat jalan biasa, halaman itu SATU-SATUNYA halaman
// berisi konten klinis (tidak ada halaman kedua terpisah seperti Triage IGD di
// kasus gawat darurat) — exclude itu bikin evidence pool jadi KOSONG TOTAL,
// audit malah lebih rusak (semua code_evidence/pending_risk_notes jadi
// found:false, bukan cuma "berpotensi sirkular"). Keputusan: pertahankan
// PRIMARY_KEYWORD apa adanya (circular-exclusion ini pada praktiknya sudah
// tidak pernah aktif untuk RS ini), TAPI catat sebagai known-issue —
// perbaikan yang benar butuh redesain lebih halus (exclude PER-KUTIPAN yang
// persis sama dengan teks asal ekstraksi, bukan exclude SELURUH halaman).
const PRIMARY_KEYWORD = 'Berkas Klaim Individual'; // halaman E-Klaim summary = sumber utama
const SCAN_CHAR_THRESHOLD = 50;

function isClaimDataPage(text) {
  const t = text.toLowerCase();
  if (CLAIM_DATA_KEYWORDS.some(kw => t.includes(kw.toLowerCase()))) return true;
  // Fallback: cocokkan minimal 2 keyword tambahan (menghindari false positive)
  const extraHits = EXTRA_KEYWORDS.filter(kw => t.includes(kw.toLowerCase()));
  return extraHits.length >= 2;
}

// classifyPdfPages() DULU jalan inline di thread utama — pdf-parse mem-parse
// SELURUH struktur PDF secara CPU-berat & sinkron, dipanggil untuk SETIAP
// file diupload (2x per file: pdfExtractionPipeline.js + gatherEvidencePool).
// Sempat dicoba dibatasi pakai semaphore Promise (CLASSIFY_JOB_CONCURRENCY)
// — TERBUKTI GAGAL di testing production 26 Aug 2026: semaphore Promise cuma
// mengatur GILIRAN di thread yang sama, bukan memindahkan kerjanya ke thread
// lain, jadi total waktu blocking event-loop tetap sama persis. Solusi yang
// benar: jalankan pdf-parse di worker_threads (thread OS terpisah) lewat
// workerThreadPool.js — lihat src/workers/pdfClassifyWorker.js untuk isi
// kerjanya (duplikat logika di bawah, sengaja berdiri sendiri di worker).
const path = require('path');
const { createWorkerPool } = require('./workerThreadPool');
const CLASSIFY_POOL_SIZE = Math.max(1, parseInt(process.env.CLASSIFY_WORKER_POOL_SIZE || '3', 10));
let classifyPool = null;
function getClassifyPool() {
  if (!classifyPool) {
    classifyPool = createWorkerPool(path.join(__dirname, '..', 'workers', 'pdfClassifyWorker.js'), CLASSIFY_POOL_SIZE);
  }
  return classifyPool;
}

async function classifyPdfPages(filePath) {
  const pool = getClassifyPool();
  const isBuffer = typeof filePath !== 'string';
  return pool.run({
    filePath: isBuffer ? null : filePath,
    bufferData: isBuffer ? filePath : null,
  });
}

async function shutdownClassifyPool() {
  if (classifyPool) {
    await classifyPool.shutdown();
    classifyPool = null;
  }
}
process.on('SIGTERM', () => { shutdownClassifyPool(); });
process.on('SIGINT', () => { shutdownClassifyPool(); });

/**
 * Deteksi kategori pelayanan (jenis_klaim) dari ISI dokumen — dipakai buat
 * upload batch kategori-campur, supaya verifikator tidak perlu pilih
 * kategori satu-satu per file (lihat detectAndAssignJenisKlaim di
 * pdfExtractionPipeline.js untuk pemanggilnya).
 *
 * Urutan prioritas (dari yang paling pasti ke paling lemah), diverifikasi
 * terhadap 150+ sampel PDF produksi asli RS Lestari Raharja (Jun-Jul 2026):
 * 1. Penanda IGD eksplisit ("RESUME MEDIS IGD", "TRIAGE IGD", klinik
 *    "INSTALASI GAWAT DARURAT"/"UGD") — paling reliabel, selalu ada
 *    kata-kata khas ini di berkas IGD.
 * 2. Field "Jns Rawat" di halaman SEP — dicetak resmi oleh sistem BPJS,
 *    isinya literal "Rawat Jalan" atau "Rawat Inap". CATATAN: field ini
 *    TIDAK membedakan IGD vs rawat jalan biasa (keduanya sama-sama bisa
 *    "Rawat Jalan" di SEP) — makanya cek IGD (poin 1) HARUS didahulukan.
 * 3. Fallback kata kunci umum ("Resume Medis Rawat Inap", "Laporan
 *    Operasi" utk rawat inap; "Resume Medis RJ" utk rawat jalan) —
 *    dipakai kalau field SEP tidak ketemu/tidak terbaca.
 *
 * @param {string} fullText - gabungan teks semua halaman (bukan cuma
 *   claimDataText, supaya penanda IGD di halaman Triage tetap kena walau
 *   halaman itu tidak lolos klasifikasi claim-data).
 * @returns {'RAWAT_JALAN'|'RAWAT_INAP'|'GAWAT_DARURAT'|null} null = tidak yakin.
 */
function detectJenisKlaim(fullText) {
  if (!fullText) return null;

  const igdMarkers = [
    'resume medis igd', 'triage igd', 'instalasi gawat darurat',
  ];
  const lower = fullText.toLowerCase();
  if (igdMarkers.some(k => lower.includes(k))) return 'GAWAT_DARURAT';
  // Klinik : UGD — cek terpisah (bukan cuma substring "ugd" yang gampang
  // false-positive, mis. singkatan lain) — harus persis pola "Klinik : UGD".
  if (/klinik[ \t]*:[ \t]*ugd\b/i.test(fullText)) return 'GAWAT_DARURAT';

  // Field resmi SEP — WAJIB pakai [ \t]* (bukan \s*) sebelum capture group:
  // \s* melahap newline kalau field-nya kosong, jadi nyerempet ke baris
  // berikutnya (bug nyata yang pernah ditemukan & diperbaiki di sesi ini).
  const jnsRawatMatch = fullText.match(/Jns[ \t]*Rawat[ \t]*:[ \t]*([^\n]*)/i);
  if (jnsRawatMatch) {
    const val = jnsRawatMatch[1].trim().toLowerCase();
    if (val.includes('rawat inap')) return 'RAWAT_INAP';
    if (val.includes('rawat jalan')) return 'RAWAT_JALAN';
  }

  if (/resume medis rawat inap|ringkasan pasien pulang|resume pasien pulang|laporan operasi/i.test(fullText)) {
    return 'RAWAT_INAP';
  }
  if (/resume medis rj\b|resume medis rawat jalan/i.test(fullText)) {
    return 'RAWAT_JALAN';
  }

  return null;
}

// Penanda dokumen ini benar-benar punya halaman SEP/BPJS asli (bukan cuma
// dokumen klinis internal RS yang tidak ada kaitan BPJS sama sekali) — dipakai
// RV-01/RV-02 di ruleEngine.js buat bedakan "AI gagal ekstrak NOKARTU dari
// dokumen BPJS asli" (tetap critical) vs "dokumen ini memang bukan klaim
// BPJS" (bukan error). SENGAJA sempit (bukan pakai CLAIM_DATA_KEYWORDS/
// EXTRA_KEYWORDS yang luas di atas) — keyword generik seperti "Diagnosa"/
// "DPJP" bisa muncul di dokumen klinis non-BPJS juga, jadi tidak boleh jadi
// bukti "ada halaman BPJS".
const BPJS_PAGE_MARKERS = ['surat eligibilitas peserta', 'nomor sep', 'no. sep', 'bpjs kesehatan'];

function hasBpjsPageSignal(fullText) {
  if (!fullText) return false;
  const lower = fullText.toLowerCase();
  return BPJS_PAGE_MARKERS.some(kw => lower.includes(kw));
}

// Penanda dokumen ini sudah menyertakan Laporan Operasi Eksisi / Hasil PA --
// dipakai RV-12 (ruleEngine.js, BA 1247/2024: diagnosis tumor + prosedur
// eksisi wajib lampiran ini) buat bedakan "genuinely belum dilampirkan" vs
// "sudah ada, RV-12 jangan salah tuduh". Ditemukan 18 Sep 2026: RV-12
// SEBELUMNYA selalu fire begitu kode diagnosis+prosedur cocok, TANPA pernah
// cek isi dokumen -- klaim yang laporannya SUDAH lengkap tetap selalu
// "Error". SENGAJA berdiri sendiri dari BPJS_PAGE_MARKERS (marker beda
// konteks) -- "laporan operasi" cukup luas dipakai apa adanya (jarang
// false-positive di dokumen klinis RS ini), "patologi anatomi"/"hasil pa"/
// "histopatologi" sbg penanda tambahan PA spesifik.
const OPERATION_REPORT_MARKERS = ['laporan operasi'];
const PA_RESULT_MARKERS = ['patologi anatomi', 'hasil pa', 'histopatologi', 'histopatologis'];

function hasLaporanOperasiSignal(fullText) {
  if (!fullText) return false;
  const lower = fullText.toLowerCase();
  return OPERATION_REPORT_MARKERS.some(kw => lower.includes(kw));
}

function hasHasilPaSignal(fullText) {
  if (!fullText) return false;
  const lower = fullText.toLowerCase();
  return PA_RESULT_MARKERS.some(kw => lower.includes(kw));
}

// Penanda dokumen memiliki Laporan Operasi — dipakai sbg fallback sumber vital signs
// ketika Triase IGD tidak ada (task 19 Sep 2026: fallback OCR extraction)
const LAPORAN_OPERASI_MARKERS = ['laporan operasi', 'laporan tindakan operatif', 'laporan operasi eksisi'];

function hasLaporanOperasiVitalSigns(fullText) {
  if (!fullText) return false;
  const lower = fullText.toLowerCase();
  return LAPORAN_OPERASI_MARKERS.some(kw => lower.includes(kw)) &&
         /vital\s*sign|sistole|diastole|nadi|respirasi|suhu|spo2|tekanan\s*darah/i.test(lower);
}

// Penanda dokumen memiliki Hasil Pemeriksaan Laboratorium — dipakai sbg fallback
// sumber lab results ketika Triase IGD tidak ada
const LAB_RESULTS_MARKERS = ['hasil pemeriksaan laboratorium', 'pemeriksaan laboratorium', 'hasil lab', 'laboratorium hasil', 'patologi klinik'];

function hasLabResultsData(fullText) {
  if (!fullText) return false;
  const lower = fullText.toLowerCase();
  return LAB_RESULTS_MARKERS.some(kw => lower.includes(kw)) &&
         /hematologi|kimia|glukosa|creatinine|bilirubin|hemoglobin|wbc|rbc|platelet/i.test(lower);
}

// Penanda dokumen memiliki Hasil Pemeriksaan Radiologi
const RADIOLOGY_MARKERS = ['hasil pemeriksaan radiologi', 'radiologi', 'ct scan', 'x-ray', 'mri', 'ultrasound', 'sonografi'];

function hasRadiologyData(fullText) {
  if (!fullText) return false;
  const lower = fullText.toLowerCase();
  return RADIOLOGY_MARKERS.some(kw => lower.includes(kw)) &&
         /diagnosis\s+radiologi|findings|impressions|temuan radiologi|kesimpulan/i.test(lower);
}

/**
 * Klasifikasi TIPE DOKUMEN satu halaman -- ditambah 19 Sep 2026 (fix item 7:
 * provenance evidence code_evidence/suggested_codes SEBELUMNYA selalu
 * dilabeli "Dari Resume Medis" di frontend TANPA CEK tipe dokumen
 * sebenarnya -- lihat generateCodingExplanation.ts). Deterministik murni
 * (regex keyword terhadap teks halaman), TIDAK memakai AI -- provenance
 * WAJIB dari metadata halaman, bukan teks bebas LLM (lihat catatan tugas).
 *
 * Urutan pengecekan SENGAJA dari paling spesifik/pasti ke paling umum --
 * satu halaman bisa memuat >1 keyword (mis. halaman Rincian Biaya juga
 * menyebut "Diagnosa"), jadi urutan menentukan tipe mana yang menang.
 * @param {string} text - teks OCR/native satu halaman
 * @returns {'rincian_biaya'|'spri'|'sep'|'resume_medis'|'triase_igd'|'lab_results'|'laporan_operasi'|'radiology'|'ekg'|'berkas_eklaim'|'lainnya'}
 */
function classifyPageDocumentType(text) {
  if (!text) return 'lainnya';
  const t = text.toLowerCase();

  // Spesifik dokumen terlebih dahulu (urutan terpenting ke kurang penting)
  if (/rincian\s*biaya/i.test(t)) return 'rincian_biaya';
  if (/triage\s+igd|skrining\s+awal\s+pasien\s+igd/i.test(t)) return 'triase_igd';
  if (/laporan\s+operasi|laporan\s+tindakan\s+operatif/i.test(t)) return 'laporan_operasi';
  if (/hasil\s+pemeriksaan\s+radiologi|radiologi\s+hasil|laporan\s+radiologi|ct\s+scan|x[\s-]?ray|mri|ultrasound|sonografi/i.test(t)) return 'radiology';
  if (/hasil\s+pemeriksaan\s+laboratorium|pemeriksaan\s+laboratorium|hasil\s+lab|laboratorium\s+hasil|hematologi|kimia\s+darah|urinalisis|patologi\s*klinik/i.test(t)) return 'lab_results';
  if (/ekg|elektrokardiogram|electrocardiogram|rekam\s+jantung/i.test(t)) return 'ekg';

  if (/surat\s*perintah\s*rawat\s*inap/i.test(t)) return 'spri';
  if (/berkas\s*klaim\s*individual/i.test(t)) return 'berkas_eklaim';
  if (/surat\s*eligibilitas\s*peserta|no\.?\s*sep\b|nomor\s*sep\b/i.test(t)) return 'sep';
  if (/resume\s*medis/i.test(t)) return 'resume_medis';
  return 'lainnya';
}

// ===== OCR Phase 1: Critical page prioritization (19 Sep 2026) =====
// Client menyetujui batas waktu OCR keras 3 menit/180000ms (turun dari
// budget sebelumnya) -- lihat OCR_ENHANCEMENT_TIMEOUT di ocrService.js &
// ocrIntegration.js. Dalam budget sesempit itu, dokumen scan tebal (SPRI +
// SEP + Rincian Biaya + Resume Medis + Triage, dst) bisa kehabisan waktu
// sebelum sampai ke halaman yang paling bernilai. TRIAGE IGD & RESUME MEDIS
// dipilih sebagai "CRITICAL" karena keduanya SATU-SATUNYA sumber vital
// signs/diagnosis/prosedur klinis (lihat extractClinicalFields() di
// ocrEnhancement.js) -- halaman lain (SEP/rincian biaya/SPRI) berguna tapi
// tidak fatal kalau ke-skip, field-nya sering sudah bisa didapat dari teks
// NATIVE (non-scan). is_critical dipakai ocrService.js buat mengurutkan
// antrean OCR (critical duluan) dan melewati halaman non-critical begitu
// waktu sudah mepet -- lihat prioritizePagesForOcr()/CRITICAL_PAGE_TIMEOUT_
// MARGIN_MS di sana.
const CRITICAL_PAGE_MARKERS = [
  /triage\s+igd/i,
  /skrining\s+awal\s+pasien\s+igd/i,
  /resume\s*medis/i,
];

function isCriticalPage(text) {
  if (!text) return false;
  return CRITICAL_PAGE_MARKERS.some(re => re.test(text));
}

// Halaman SEP tidak pernah memuat vital signs/temuan klinis — isinya
// administratif (nomor SEP, no kartu, jenis rawat). Dipakai ocrService.js
// buat membuang halaman SEP dari antrean OCR enhancement, TAPI hanya kalau
// teks native halaman itu sudah terbaca (type NATIVE): untuk dokumen
// full-scan, OCR adalah SATU-SATUNYA cara membaca nomor SEP/no kartu, jadi
// di sana halaman SEP tetap wajib di-OCR (lihat catatan di kepala file soal
// 'Surat Eligibilitas Peserta' & error "wajib diisi").
//
// Guard isCriticalPage() di depan BUKAN basa-basi: di
// classifyPageDocumentType() cek 'sep' jatuh SEBELUM 'resume_medis', jadi
// halaman RESUME MEDIS yang mencantumkan "No. SEP" (lazim — resume medis
// dicetak lengkap dengan identitas klaim) akan dikembalikan sebagai 'sep'.
// Tanpa guard ini halaman paling bernilai untuk vital signs justru yang
// terbuang duluan. Halaman critical TIDAK PERNAH dianggap SEP.
function isSepPage(text) {
  if (!text) return false;
  if (isCriticalPage(text)) return false;
  return classifyPageDocumentType(text) === 'sep';
}

module.exports = {
  classifyPdfPages,
  isClaimDataPage,
  detectJenisKlaim,
  hasBpjsPageSignal,
  hasLaporanOperasiSignal,
  hasHasilPaSignal,
  hasLaporanOperasiVitalSigns,
  hasLabResultsData,
  hasRadiologyData,
  classifyPageDocumentType,
  isCriticalPage,
  isSepPage
};
