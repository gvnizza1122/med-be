/**
 * Worker thread untuk classifyPdfPages() — lihat workerThreadPool.js untuk
 * alasan kenapa ini HARUS di thread terpisah (pdf-parse CPU-berat & sinkron,
 * sebelumnya memblokir event-loop utama saat banyak file diproses paralel).
 *
 * Duplikasi kecil dari CLAIM_DATA_KEYWORDS/EXTRA_KEYWORDS/isClaimDataPage di
 * pdfPageClassifier.js SENGAJA — worker thread butuh modul sendiri yang
 * berdiri sendiri (tidak import balik ke pdfPageClassifier.js supaya tidak
 * ikut memuat dependency route/service lain yang tidak perlu di worker).
 */
const { isLembarGrouper } = require('../services/lembarGrouperService');
const { parentPort } = require('worker_threads');
const { PDFParse } = require('pdf-parse');
const fs = require('fs');

const CLAIM_DATA_KEYWORDS = ['Nomor SEP', 'Berkas Klaim Individual', 'INA-CBG', 'Total Tarif', 'Rincian Biaya', 'DPJP', 'Dokter Penanggung Jawab', 'Surat Eligibilitas Peserta'];
const EXTRA_KEYWORDS = ['Klaim Individual', 'Data Klaim', 'Resume Medis', 'Ringkasan Pasien Keluar', 'INACBG', 'INA CBG', 'Diagnosa', 'Prosedur', 'Kode ICD', 'Nomor Kartu', 'No. SEP', 'No. Kartu', 'No Kartu'];
const PRIMARY_KEYWORD = 'Berkas Klaim Individual';
const SCAN_CHAR_THRESHOLD = 50;
// Duplikat isCriticalPage()/CRITICAL_PAGE_MARKERS dari pdfPageClassifier.js
// (OCR Phase 1, 19 Sep 2026) -- lihat komentar lengkap di sana. Dipakai
// ocrService.js buat prioritaskan halaman TRIAGE IGD/RESUME MEDIS dalam
// antrean OCR sebelum budget waktu 180s habis.
const CRITICAL_PAGE_MARKERS = [
  /triage\s+igd/i,
  /skrining\s+awal\s+pasien\s+igd/i,
  /resume\s*medis/i,
];

function isClaimDataPage(text) {
  const t = text.toLowerCase();
  if (CLAIM_DATA_KEYWORDS.some(kw => t.includes(kw.toLowerCase()))) return true;
  const extraHits = EXTRA_KEYWORDS.filter(kw => t.includes(kw.toLowerCase()));
  return extraHits.length >= 2;
}

function isCriticalPage(text) {
  if (!text) return false;
  return CRITICAL_PAGE_MARKERS.some(re => re.test(text));
}

async function classify(filePath, bufferData) {
  const result = {
    success: false, pages: [], claimDataPages: [], claimDataText: '', grouperPages: [],
    totalPages: 0, summary: { nativeCount: 0, scanCount: 0 }, errors: [],
  };
  try {
    const data = bufferData || fs.readFileSync(filePath);
    const parsed = await new PDFParse({ data }).getText();
    const full = parsed.text || '';

    const markers = [...full.matchAll(/--\s*(\d+)\s*of\s*(\d+)\s*--/gi)];
    let chunks;
    if (markers.length) {
      chunks = []; let last = 0;
      for (const m of markers) { chunks.push(full.slice(last, m.index)); last = m.index + m[0].length; }
      const tail = full.slice(last).trim();
      if (tail) chunks.push(tail);
    } else {
      chunks = [full];
    }

    chunks.forEach((chunk, i) => {
      const text = chunk.trim();
      const type = text.length < SCAN_CHAR_THRESHOLD ? 'SCAN' : 'NATIVE';
      const hasClaimData = isClaimDataPage(text);
      const isPrimarySource = text.toLowerCase().includes(PRIMARY_KEYWORD.toLowerCase());
      const isCritical = isCriticalPage(text);
      const pageNum = i + 1;
      // Lembar grouper E-Klaim (hasil kerja casemix) BUKAN bahan bacaan AI --
      // hanya disimpan sebagai pembanding (lihat lembarGrouperService.js).
      const isGrouper = isLembarGrouper(text);
      if (isGrouper) result.grouperPages.push({ page_num: pageNum, text });
      else if (hasClaimData) result.claimDataPages.push({ page_num: pageNum, text });
      result.pages.push({ page_num: pageNum, type, text_length: text.length, has_claim_data: hasClaimData, is_primary_source: isPrimarySource, is_lembar_grouper: isGrouper, is_critical: isCritical, text_sample: text.slice(0, 200), text_full: text });
      if (type === 'NATIVE') result.summary.nativeCount++; else result.summary.scanCount++;
    });
    result.totalPages = chunks.length;

    // Dulu halaman "Berkas Klaim Individual" ditaruh PALING DEPAN di sini,
    // sehingga DIAGLIST/PROCLIST/INA-CBG/tarif klaim hanyalah salinan lembar
    // grouper casemix. Sekarang lembar itu tidak ikut sama sekali.
    result.claimDataText = result.claimDataPages.map(p => p.text).join('\n\n---\n\n');

    result.success = true;
  } catch (error) {
    result.errors.push({ type: 'classification_error', message: error.message });
  }
  return result;
}

parentPort.on('message', async ({ taskId, payload }) => {
  try {
    const result = await classify(payload.filePath, payload.bufferData);
    parentPort.postMessage({ taskId, result });
  } catch (error) {
    parentPort.postMessage({ taskId, error: error.message || String(error) });
  }
});
