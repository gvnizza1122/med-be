const { PDFParse } = require('pdf-parse');
const fs = require('fs');

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

// Pembatas jumlah panggilan classifyPdfPages() yang boleh jalan bersamaan.
// PDFParse().getText() (pdf-parse) mem-parse SELURUH struktur PDF secara
// CPU-berat di thread utama Node (bukan cuma tunggu I/O) — dipanggil untuk
// SETIAP file yang diupload (malah 2x per file: sekali di
// pdfExtractionPipeline.js buat ekstraksi utama, sekali lagi di
// gatherEvidencePool untuk evidence pool audit). Dengan BATCH_AI_CONCURRENCY
// tinggi (20), sebelumnya bisa sampai puluhan panggilan classifyPdfPages
// jalan "bersamaan" — tapi karena Node satu-thread, kerja sinkron itu tetap
// dieksekusi berurutan dan memblokir event-loop sepanjang durasinya,
// termasuk request lain seperti login (dikonfirmasi: hang total production
// terjadi lagi 26 Aug 2026 walau OCR fallback SAMA SEKALI TIDAK terpicu —
// membuktikan classifyPdfPages, bukan OCR/Tesseract, penyebab sesungguhnya).
// Batasi ke angka kecil supaya CPU tetap tersisa untuk melayani request lain.
const CLASSIFY_JOB_LIMIT = Math.max(1, parseInt(process.env.CLASSIFY_JOB_CONCURRENCY || '3', 10));
let classifyJobsRunning = 0;
const classifyJobWaiters = [];
async function acquireClassifySlot() {
  if (classifyJobsRunning < CLASSIFY_JOB_LIMIT) {
    classifyJobsRunning++;
    return;
  }
  await new Promise((resolve) => classifyJobWaiters.push(resolve));
  classifyJobsRunning++;
}
function releaseClassifySlot() {
  classifyJobsRunning--;
  const next = classifyJobWaiters.shift();
  if (next) next();
}

async function classifyPdfPages(filePath) {
  await acquireClassifySlot();
  try {
    return await _classifyPdfPagesImpl(filePath);
  } finally {
    releaseClassifySlot();
  }
}

async function _classifyPdfPagesImpl(filePath) {
  const result = {
    success: false, pages: [], claimDataPages: [], claimDataText: '',
    totalPages: 0, summary: { nativeCount: 0, scanCount: 0 }, errors: [],
  };
  try {
    const data = typeof filePath === 'string' ? fs.readFileSync(filePath) : filePath;
    const parsed = await new PDFParse({ data }).getText();
    const full = parsed.text || '';

    // Split per halaman via marker "-- N of M --" (konsisten dgn pdfParser.js).
    const markers = [...full.matchAll(/--\s*(\d+)\s*of\s*(\d+)\s*--/gi)];
    let chunks;
    if (markers.length) {
      chunks = []; let last = 0;
      for (const m of markers) { chunks.push(full.slice(last, m.index)); last = m.index + m[0].length; }
      const tail = full.slice(last).trim();
      if (tail) chunks.push(tail);
    } else {
      chunks = [full]; // fallback: tak ada marker, treat 1 chunk
    }

    chunks.forEach((chunk, i) => {
      const text = chunk.trim();
      const type = text.length < SCAN_CHAR_THRESHOLD ? 'SCAN' : 'NATIVE';
      const hasClaimData = isClaimDataPage(text);
      // is_primary_source: HANYA halaman "Berkas Klaim Individual" (E-Klaim
      // summary) yang sungguhan — beda dari has_claim_data yang sengaja luas
      // (mencakup halaman SEP/Resume Medis/SPRI supaya field SEP/NOKARTU/DPJP
      // ikut terbaca saat ekstraksi). Dipakai KHUSUS untuk kecualikan halaman
      // dari evidence pool (cegah audit sirkular) — kalau pakai has_claim_data
      // yang luas di situ, halaman Resume Medis/SPRI yang punya bukti klinis
      // ASLI (bukan sumber ekstraksi DIAGLIST/PROCLIST) ikut ter-eksklusi
      // secara tidak sengaja, padahal itu justru bukti yang valid.
      const isPrimarySource = text.toLowerCase().includes(PRIMARY_KEYWORD.toLowerCase());
      const pageNum = i + 1;
      if (hasClaimData) result.claimDataPages.push({ page_num: pageNum, text });
      result.pages.push({ page_num: pageNum, type, text_length: text.length, has_claim_data: hasClaimData, is_primary_source: isPrimarySource, text_sample: text.slice(0, 200), text_full: text });
      if (type === 'NATIVE') result.summary.nativeCount++; else result.summary.scanCount++;
    });
    result.totalPages = chunks.length;

    // Gabung semua halaman claim-data, "Berkas Klaim Individual" (E-Klaim summary) di depan.
    const primary = result.claimDataPages.filter(p => p.text.toLowerCase().includes(PRIMARY_KEYWORD.toLowerCase()));
    const others = result.claimDataPages.filter(p => !p.text.toLowerCase().includes(PRIMARY_KEYWORD.toLowerCase()));
    result.claimDataText = [...primary, ...others].map(p => p.text).join('\n\n---\n\n');

    result.success = true;
  } catch (error) {
    result.errors.push({ type: 'classification_error', message: error.message });
  }
  return result;
}

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

module.exports = { classifyPdfPages, isClaimDataPage, detectJenisKlaim, hasBpjsPageSignal };
