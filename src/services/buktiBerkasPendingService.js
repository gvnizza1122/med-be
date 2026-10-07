/**
 * Pencari bukti di halaman berkas klaim untuk alur jawaban pending.
 *
 * Setiap kutipan yang keluar dari sini diambil LANGSUNG dari teks halaman
 * (satu baris, atau jendela di sekitar kecocokan) lalu DIVERIFIKASI ulang
 * dengan pagarTemuanService.verifikasiKutipan terhadap halaman yang sama.
 * Kutipan yang tidak lolos dibuang. Jadi apa pun yang dikembalikan modul ini
 * benar-benar ada di halaman yang disebut; tidak ada kutipan karangan.
 *
 * Sumber halaman: tabel ocr_results (halaman scan hasil OCR dan halaman teks
 * asli yang disimpan simpanHalamanNative). Halaman "Berkas Klaim Individual"
 * (sumber ekstraksi DIAGLIST/PROCLIST) sengaja tidak ada di tabel itu, jadi
 * kode yang hanya tertulis di sana tidak dihitung sebagai bukti.
 */

const { verifikasiKutipan } = require('./pagarTemuanService');
const { classifyPageDocumentType } = require('./pdfPageClassifier');
const { isLembarGrouper } = require('./lembarGrouperService');

const PANJANG_MAKS_KUTIPAN = 240;

async function muatHalaman(db, recordId) {
  if (!recordId) return [];
  const rows = await db.prepare(`
    SELECT page_number, ocr_text FROM ocr_results WHERE record_id = ? ORDER BY page_number ASC
  `).all(recordId);
  return (rows || [])
    .map((r) => ({ page_number: Number(r.page_number), ocr_text: r.ocr_text == null ? '' : String(r.ocr_text) }))
    .filter((r) => r.ocr_text.trim().length > 0);
}

function potongSekitar(baris, indeks, panjang) {
  if (baris.length <= PANJANG_MAKS_KUTIPAN) return baris.trim();
  const awal = Math.max(0, indeks - Math.floor(PANJANG_MAKS_KUTIPAN / 2));
  return baris.slice(awal, awal + PANJANG_MAKS_KUTIPAN).trim();
}

/**
 * Cari kutipan untuk satu pola.
 * @param {Array<{page_number:number, ocr_text:string}>} halaman
 * @param {RegExp} pola
 * @param {{maks?:number}} [opsi]
 * @returns {Array<{halaman:number, kutipan:string, terverifikasi:true}>}
 */
function cariKutipan(halaman, pola, opsi = {}) {
  const maks = opsi.maks || 2;
  const cari = new RegExp(pola.source, 'gi');
  const hasil = [];
  const terlihat = new Set();
  for (const h of halaman || []) {
    const teks = String(h.ocr_text || '');
    if (opsi.klinis && (isLembarGrouper(teks)
      || ['rincian_biaya', 'sep'].includes(classifyPageDocumentType(teks)))) continue;
    // Nama pemeriksaan pada instruksi/tagihan belum merupakan dokumen hasil.
    // Hasil negatif tetap hasil pemeriksaan, sehingga tidak memakai pagar
    // afirmatif (yang diperlukan untuk gejala/diagnosis/tindakan).
    if (opsi.hasilPemeriksaan && !/\b(?:kesan|kesimpulan|interpretasi|impression|temuan|normal|abnormal|irama|sinus|infiltrat|echogen|hiperekoik|fraktur|hemoglobin|leukosit|hematologi)\b|\d+(?:[.,]\d+)?\s*(?:mg\/dl|g\/dl|mmol\/l|u\/l)\b/i.test(teks)) continue;
    const baris = String(h.ocr_text || '').split(/\r?\n/);
    for (const b of baris) {
      cari.lastIndex = 0;
      let m, diterima = null;
      while ((m = cari.exec(b))) {
        if (!m[0].length) break;
        const sebelum = b.slice(0, m.index);
        const sesudah = b.slice(m.index + m[0].length);
        const klausa = b.slice(Math.max(sebelum.lastIndexOf(';'), sebelum.lastIndexOf(',')) + 1)
          .split(/[;,]/)[0];
        const rencana = /\b(?:rencana|direncanakan|akan|usul|anjuran|jika|bila perlu|belum dilakukan|tidak dilakukan|belum diperiksa|tidak diperiksa|dibatalkan|ditunda)\b/i.test(klausa);
        const negasi = /\b(?:tanpa|tidak|tdk|tak|belum|bukan)\s+(?:(?:ada|mengalami|ditemukan|tampak|perlu|dilakukan|diberikan)\s*)?(?:(?:bukti|tanda|gejala)\s*)?$/i.test(sebelum)
          || /^\s*(?:(?:[:=]\s*)?(?:\(-\)|negatif\b)|disangkal\b|tidak\b|belum\b|ditiadakan\b)/i.test(sesudah);
        if ((opsi.afirmatif && (negasi || rencana)) || (opsi.hasilPemeriksaan && rencana)) continue;
        diterima = m;
        break;
      }
      if (!diterima) continue;
      const kutipan = potongSekitar(b, diterima.index);
      if (kutipan.length < 3) continue;
      const kunci = `${h.page_number}|${kutipan.toLowerCase()}`;
      if (terlihat.has(kunci)) continue;
      const cek = verifikasiKutipan(kutipan, h.page_number, halaman);
      if (!cek.valid) continue;
      terlihat.add(kunci);
      hasil.push({ halaman: h.page_number, kutipan, terverifikasi: true });
      if (hasil.length >= maks) return hasil;
    }
  }
  return hasil;
}

/** Ambil kode ICD (mis. A09, I10, 89.03) dari teks bebas atau daftar kode klaim. */
function ambilKode(teks, jenis) {
  const s = String(teks == null ? '' : teks).toUpperCase();
  const re = jenis === 'prosedur' ? /\b\d{2}\.\d{1,2}\b/g : /\b[A-Z]\d{2}(?:\.\d{1,2})?\b/g;
  return [...new Set(s.match(re) || [])];
}

function polaKode(kode) {
  const k = String(kode).replace('.', '\\.?');
  return new RegExp(`(^|[^A-Za-z0-9])${k}([^0-9]|$)`, 'i');
}

module.exports = { muatHalaman, cariKutipan, ambilKode, polaKode, PANJANG_MAKS_KUTIPAN };
