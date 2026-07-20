const { PDFParse } = require('pdf-parse');
const fs = require('fs');

// ponytail: classifier pakai pdf-parse (sudah terpasang) — pdfjs-dist v4 tak jalan di CommonJS.
// 'DPJP' & 'Dokter Penanggung Jawab' ikut: nama dokter ada di layer teks (halaman SPRI/SEP),
// bukan di halaman E-Klaim — tanpa ini kolom DPJP vClaim selalu kosong.
const CLAIM_DATA_KEYWORDS = ['Nomor SEP', 'Berkas Klaim Individual', 'INA-CBG', 'Total Tarif', 'Rincian Biaya', 'DPJP', 'Dokter Penanggung Jawab'];
const PRIMARY_KEYWORD = 'Berkas Klaim Individual'; // halaman E-Klaim summary = sumber utama
const SCAN_CHAR_THRESHOLD = 50;

function isClaimDataPage(text) {
  const t = text.toLowerCase();
  return CLAIM_DATA_KEYWORDS.some(kw => t.includes(kw.toLowerCase()));
}

async function classifyPdfPages(filePath) {
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
      const pageNum = i + 1;
      if (hasClaimData) result.claimDataPages.push({ page_num: pageNum, text });
      result.pages.push({ page_num: pageNum, type, text_length: text.length, has_claim_data: hasClaimData, text_sample: text.slice(0, 200) });
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

module.exports = { classifyPdfPages, isClaimDataPage };
