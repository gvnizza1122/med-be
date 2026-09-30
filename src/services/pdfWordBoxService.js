/**
 * Kotak kata (word box) per halaman PDF digital — {text, x0, x1, top, bottom}.
 *
 * KENAPA ADA
 * Jalur teks biasa (pdf-parse -> string) membuang koordinat. Pada tabel resume
 * medis SIMRS, label sel ("Tindakan") diletakkan di TENGAH sel secara vertikal
 * sedangkan isinya menempel di ATAS sel. Urutan baca murni lalu memberi
 * "Tindakan" tanpa isi, dan isinya menempel ke label sel di atasnya. Untuk
 * memasangkan label dengan isinya kita butuh posisi, bukan urutan.
 *
 * Diambil dengan mupdf (sudah terpasang dan dipakai pdfRenderWorker.js) lewat
 * StructuredText.walk — TIDAK ada dependensi baru. Koordinat: titik, asal di
 * kiri-atas, y membesar ke bawah (sama dengan `pdftotext -bbox`).
 *
 * Best-effort: kalau mupdf gagal dimuat / PDF rusak / halaman hasil scan
 * (tanpa lapisan teks), kembalikan peta kosong dan pemanggil jatuh ke jalur
 * teks lama. Tidak pernah melempar galat.
 */

/**
 * Pecah rangkaian karakter mupdf menjadi kata. Kata berakhir pada spasi atau
 * pergantian baris.
 * @param {Array<{c:string, quad:number[]}>} karakterPerBaris
 * @returns {Array<{text:string,x0:number,x1:number,top:number,bottom:number}>}
 */
function karakterKeKata(karakterPerBaris) {
  const kata = [];
  for (const baris of karakterPerBaris) {
    let saat = null;
    const tutup = () => {
      if (saat && saat.text) kata.push(saat);
      saat = null;
    };
    for (const { c, quad } of baris) {
      if (/\s/.test(c)) { tutup(); continue; }
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      const x0 = Math.min(...xs), x1 = Math.max(...xs);
      const top = Math.min(...ys), bottom = Math.max(...ys);
      if (!saat) saat = { text: c, x0, x1, top, bottom };
      else {
        saat.text += c;
        saat.x0 = Math.min(saat.x0, x0);
        saat.x1 = Math.max(saat.x1, x1);
        saat.top = Math.min(saat.top, top);
        saat.bottom = Math.max(saat.bottom, bottom);
      }
    }
    tutup();
  }
  return kata;
}

/**
 * @param {Buffer|Uint8Array} bufferPdf
 * @param {number[]} [nomorHalaman] 1-based; kosong = semua halaman
 * @returns {Promise<Map<number, Array>>} nomor halaman -> kata; peta kosong bila gagal
 */
async function ekstrakKotakKata(bufferPdf, nomorHalaman) {
  const hasil = new Map();
  let doc = null;
  try {
    const mupdf = await import('mupdf');
    doc = mupdf.Document.openDocument(bufferPdf, 'application/pdf');
    const jumlah = doc.countPages();
    const target = Array.isArray(nomorHalaman) && nomorHalaman.length
      ? nomorHalaman
      : Array.from({ length: jumlah }, (_, i) => i + 1);
    for (const n of target) {
      if (!Number.isInteger(n) || n < 1 || n > jumlah) continue;
      try {
        const halaman = doc.loadPage(n - 1);
        const stext = halaman.toStructuredText('preserve-whitespace');
        const baris = [];
        let sekarang = null;
        stext.walk({
          beginLine() { sekarang = []; },
          onChar(c, _origin, _font, _size, quad) { if (sekarang) sekarang.push({ c, quad }); },
          endLine() { if (sekarang) baris.push(sekarang); sekarang = null; },
        });
        const kata = karakterKeKata(baris);
        if (kata.length) hasil.set(n, kata);
      } catch (_) { /* satu halaman gagal tidak menggagalkan yang lain */ }
    }
  } catch (_) {
    return new Map();
  } finally {
    try { doc && doc.destroy && doc.destroy(); } catch (_) { /* abaikan */ }
  }
  return hasil;
}

module.exports = { ekstrakKotakKata, karakterKeKata };
