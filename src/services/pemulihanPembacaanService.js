// Ulangi hanya halaman yang gagal/kosong sekali, sebelum ekstraksi atau AI.
// Halaman native yang sengaja tidak di-OCR tetap dibaca oleh klasifikasi PDF.
function halamanPerluDipulihkan(ocr = {}) {
  const kandidat = [
    ...(ocr.skipped_pages || []).filter(p => p.reason !== 'sep_page_native_text_available'),
    ...(ocr.errors || []).filter(p => p.page_number),
    ...(ocr.pages || []).filter(p => !String(p.text || '').trim()),
  ];
  const sudah = new Set((ocr.pages || []).filter(p => String(p.text || '').trim()).map(p => Number(p.page_number)));
  return [...new Set(kandidat.map(p => Number(p.page_number)).filter(n => Number.isInteger(n) && n > 0 && !sudah.has(n)))];
}
async function pulihkanPembacaan(ocr, baca) {
  const halaman = halamanPerluDipulihkan(ocr);
  if (!halaman.length) return ocr;
  let ulang;
  try { ulang = await baca(halaman); } catch (_) { return { ...ocr, pemulihan_otomatis: { dicoba: halaman, pulih: [], belum_terbaca: halaman } }; }
  const pages = new Map((ocr.pages || []).map(p => [Number(p.page_number), p]));
  const pulih = [];
  for (const p of ulang?.pages || []) {
    if (halaman.includes(Number(p.page_number)) && String(p.text || '').trim()) {
      pages.set(Number(p.page_number), p); pulih.push(Number(p.page_number));
    }
  }
  return { ...ocr, success: ocr.success || pulih.length > 0, pages: [...pages.values()].sort((a, b) => a.page_number - b.page_number),
    errors: (ocr.errors || []).filter(p => !pulih.includes(Number(p.page_number))),
    skipped_pages: (ocr.skipped_pages || []).filter(p => !pulih.includes(Number(p.page_number))),
    pemulihan_otomatis: { dicoba: halaman, pulih, belum_terbaca: halaman.filter(n => !pulih.includes(n)) } };
}
module.exports = { halamanPerluDipulihkan, pulihkanPembacaan };
