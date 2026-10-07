// Hanya catatan pelaksanaan dengan periode eksplisit. Resep/tagihan bukan bukti durasi.
const OBAT = /\b(?:ceftriaxon[e]?|cefotaxim[e]?|ceftazidim[e]?|cefazolin|ampicillin|amoxicillin|gentamicin|metronidazol[e]?|levofloxacin|ciprofloxacin|meropenem|azithromycin)\b/i;
const TANGGAL = '(\\d{1,2})/(\\d{1,2})/(\\d{4})\\s+(\\d{1,2}):(\\d{2})';
function waktu(match, offset) {
  const [d, m, y, h, min] = match.slice(offset, offset + 5).map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, h, min));
  return t.getUTCDate() === d && t.getUTCMonth() === m - 1 && t.getUTCHours() === h && min < 60 ? t.getTime() : null;
}
function bacaPemberianAntibiotik(halaman) {
  let petunjuk = null;
  for (const p of halaman || []) {
    const teks = String(p.ocr_text || p.text || '');
    const jenis = require('./pdfPageClassifier').classifyPageDocumentType(teks);
    if (['resep', 'rincian_biaya', 'lembar_grouper', 'claim_data'].includes(jenis)) continue;
    for (const baris of teks.split(/\r?\n/)) {
      if (!OBAT.test(baris) || !/\b(?:iv|intravena|intravenous)\b/i.test(baris)) continue;
      if (/\b(?:rencana|akan|belum|batal|riwayat|tidak)\b/i.test(baris)) continue;
      if (!/\b(?:diberikan|pemberian|telah\s+mendapat|administration)\b/i.test(baris)) continue;
      const bukti = { kutipan: baris.trim(), page_number: p.page_number };
      petunjuk = bukti;
      // "Mulai ... sampai ..." harus menyatakan periode pemberian obat yang sama.
      const m = new RegExp('(?:mulai|sejak)\\s*:?[ \\t]*' + TANGGAL + '\\s*(?:sampai|hingga|s\\.d\\.?|selesai)\\s*:?[ \\t]*' + TANGGAL, 'i').exec(baris);
      if (!m) continue;
      const mulai = waktu(m, 1), selesai = waktu(m, 6);
      if (mulai == null || selesai == null || selesai < mulai) continue;
      return { ...bukti, durasi_jam: (selesai - mulai) / 3600000 };
    }
  }
  return petunjuk;
}
module.exports = { bacaPemberianAntibiotik };
