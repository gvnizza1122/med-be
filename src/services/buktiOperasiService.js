/** Bukti tindakan bedah harus berisi tindakan; judul formulir/anestesi ICU bukan operasi. */
const { classifyPageDocumentType } = require('./pdfPageClassifier');
const { isLembarGrouper } = require('./lembarGrouperService');
const NEG = /\b(?:rencana|direncanakan|belum|tidak\s+(?:dilakukan|ada)|akan|pro\s+operasi)\b/i;
function cariBuktiOperasi(pages = []) {
  for (const p of pages) {
    const text = String(p.ocr_text || p.text || '');
    if (isLembarGrouper(text)) continue;
    const jenis = classifyPageDocumentType(text);
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (NEG.test(line)) continue;
      const tagihan = jenis === 'rincian_biaya' && /\boperasi\s+(?:kecil|sedang|besar|khusus|canggih)\b|\bjasa\s+operator\b|\bsewa\s+(?:ok|kamar\s+operasi)\b/i.test(line) && !/[:=]\s*(?:0|-)\s*$/.test(line);
      const tindakan = /\b(?:ORIF|apendektomi|appendectomy|eksisi|odontektomi|debridemen|laparotomi|histerektomi|mastektomi|herniotomi|herniorafi|seksio|sectio|SC)\b/i;
      const pernyataan = /\b(?:dilakukan|telah|post\s*op|pasca\s*operasi|tindakan\s*(?:operasi|operatif)|jenis\s*operasi)\b/i.test(line) && tindakan.test(line);
      const isiLaporan = jenis === 'laporan_operasi' && /\b(?:insisi|eksisi|diangkat|dijahit|ORIF|apendektomi|debridemen|seksio|sectio)\b/i.test(line);
      if (tagihan || pernyataan || isiLaporan) return { kutipan: line, page_number: p.page_number, jenis_halaman: jenis };
    }
  }
  return null;
}
module.exports = { cariBuktiOperasi };
