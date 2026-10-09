// Membuktikan tindakan cairan terjadi; tidak menilai kecukupan resusitasi
// atau menetapkan syok dari terapi saja. Kutipan selalu potongan asli berkas.
const CAIRAN = /\b(?:cairan|inf(?:us)?|asering|ringer|RL|NS|NaCl|kristaloid|koloid)\b/i;
const RESUS = /\b(?:resusitasi(?:\s+cairan)?|bolus|loading(?:\s+cairan)?|fluid\s+loading)\b/i;
const AKSI = /\b(?:melakukan|dilakukan|diberikan|pemberian|telah|terpasang|selesai|habis)\b/i;
const RAGU = /\b(?:tidak|belum|tanpa|rencana|direncanakan|disarankan|anjuran|akan|usul|jika|bila|pertimbangkan|ditunda|dibatalkan)\b/i;
const VOLUME = /^\s*\d+(?:[.,]\d+)?\s*(?:cc|ml|mL|liter)\b/i;
function cariBuktiResusitasi(pages = []) {
  const bukti = [];
  for (const p of pages) {
    const lines = String(p.ocr_text || p.text || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      // Satu klausa utuh mempertahankan negasi, jenis cairan, dan tindakan.
      if (/^\s*(?:rencana|instruksi|anjuran|jika|bila)\b/i.test(lines[i - 1] || '')) continue;
      const clause = lines[i].split(/[;|]/).find(s => RESUS.test(s) && CAIRAN.test(s) && AKSI.test(s) && !RAGU.test(s));
      if (!clause) continue;
      let quote = clause.trim();
      if (VOLUME.test(lines[i + 1] || '') && !RAGU.test(lines[i + 1])) quote += '\n' + lines[i + 1].trim();
      bukti.push({ page_number: p.page_number || null, kutipan: quote, jenis_halaman: p.jenis,
        cakupan: 'tindakan_tercatat', catatan: 'Bukti pemberian/loading cairan; kecukupan volume, respons dan diagnosis dinilai terpisah.' });
      break;
    }
  }
  return { id: 'resusitasi', nama: 'Catatan resusitasi cairan', status: bukti.length ? 'bukti_ditemukan' : 'bukti_belum_cukup', bukti: bukti.slice(0, 8) };
}
module.exports = { cariBuktiResusitasi };
