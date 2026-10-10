/** Hasil Gram sputum harus berupa laporan hasil, bukan order atau daftar pemeriksaan. */
function bacaGramSputum(pages) {
  const hasil = [];
  for (const p of pages || []) {
    const teks = String(p.ocr_text || p.text || '');
    if (!/jenis\s+spesimen\s*:\s*(?:sputum|dahak)|(?:hasil|pemeriksaan)\s+(?:gram\s+sputum|sputum\s+gram)/i.test(teks)) continue;
    const baris = teks.split(/\r?\n/);
    const temuan = baris.filter(b => /gram\s+(?:positif|negatif)(?:\s*:\s*|\s+)(?:coccus|cocci|basil|bacill\w*|ditemukan|tidak\s+ditemukan|positif|negatif|[+\-]|\d)/i.test(b)
      && !/\b(?:belum|menunggu|pending|tidak\s+dilakukan)\b/i.test(b));
    if (!temuan.length) continue;
    hasil.push({ page_number: Number(p.page_number), kode_usulan: '90.41',
      kutipan: temuan.map(b => b.trim()).join('\n'), spesimen: 'Sputum', hasil_terbaca: true });
  }
  return hasil;
}
module.exports = { bacaGramSputum };
