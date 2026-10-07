/**
 * Keputusan sumber teks per halaman: lapisan teks PDF dahulu, OCR hanya bila perlu.
 *
 * Pemeriksaan kode yang ada (2026-09): pdfPageClassifier menandai halaman
 * SCAN bila teks < 50 karakter, selain itu NATIVE. ocrService (mode 'all')
 * memakai teks native untuk halaman NATIVE >= 500 karakter (sumber
 * 'native_text', tanpa render+OCR) dan tetap meng-OCR halaman NATIVE yang
 * berteks sedikit karena bisa campuran teks + tabel gambar. Mode 'auto-scan'
 * hanya meng-OCR halaman SCAN. Jadi "teks dahulu" SUDAH berlaku; yang belum:
 *
 *   1. keputusannya tersebar sebagai angka mentah di ocrService (tak teruji),
 *   2. lapisan teks RUSAK (PDF hasil pindai dengan teks sampah dari pemindai)
 *      dianggap teks nyata sehingga OCR dilewati dan yang dibaca sampah.
 *
 * Modul ini memusatkan keputusan itu di satu fungsi murni yang teruji, dan
 * menambah pemeriksaan mutu lapisan teks. ocrService memanggil
 * punyaLapisanTeksNyata() pada dua titik penyaringan (hook kecil).
 *
 * Ambang sengaja sama dengan yang sudah berlaku (50 dan 500) supaya perilaku
 * halaman normal tidak berubah; hanya halaman ber-teks sampah yang berubah,
 * dari "dianggap teks" menjadi "OCR".
 *
 * Belum teruji pada PDF asli RS; ambang mutu (rasio alfanumerik, rasio kata
 * berbunyi) ditetapkan dari akal sehat, bukan dari pengukuran. Ukur dulu
 * dengan harness evaluasiAkurasiService sebelum mengubah ambang.
 */

const SUMBER = { NATIVE: 'native_text', OCR: 'ocr' };
const ALASAN = {
  TANPA_TEKS: 'tanpa_lapisan_teks',
  TEKS_SAMPAH: 'lapisan_teks_rusak',
  TEKS_SEDIKIT: 'teks_sedikit_kemungkinan_campuran',
  TEKS_CUKUP: 'lapisan_teks_nyata',
};

const AMBANG_HALAMAN_PINDAI = 50; // sama dengan SCAN_CHAR_THRESHOLD pdfPageClassifier
const AMBANG_TEKS_NYATA = 500; // sama dengan NATIVE_TEXT_MIN_CHARS ocrService
const MIN_RASIO_ALFANUMERIK = 0.6;
const MIN_RASIO_KATA_BERBUNYI = 0.5;
const MIN_KATA_UNTUK_UJI_BUNYI = 20;

/** Ukuran mutu lapisan teks. */
function ukurMutuTeks(teks) {
  const t = String(teks || '');
  const tanpaSpasi = t.replace(/\s+/g, '');
  const alfanumerik = (tanpaSpasi.match(/[A-Za-z0-9À-ɏ.,:;/()%\-+]/g) || []).length;
  const rasioAlfanumerik = tanpaSpasi.length ? alfanumerik / tanpaSpasi.length : 0;
  const kata = t.split(/\s+/).filter(k => /[A-Za-z]{2,}/.test(k));
  const berbunyi = kata.filter(k => /[aeiouAEIOU]/.test(k)).length;
  return {
    panjang: t.trim().length,
    rasio_alfanumerik: rasioAlfanumerik,
    jumlah_kata: kata.length,
    rasio_kata_berbunyi: kata.length ? berbunyi / kata.length : 0,
  };
}

function teksRusak(m) {
  if (m.rasio_alfanumerik < MIN_RASIO_ALFANUMERIK) return true;
  return m.jumlah_kata >= MIN_KATA_UNTUK_UJI_BUNYI && m.rasio_kata_berbunyi < MIN_RASIO_KATA_BERBUNYI;
}

// Lapisan teks dengan encoding font bergeser: tiap glyph dipetakan ke karakter
// lain sejumlah tetap (umumnya 29: "$0$16$17262" = "AMAN SANTOSO"). Rasio
// alfanumeriknya tetap tinggi sehingga lolos teksRusak(), padahal isinya tak
// terbaca -- resume medis AMAN SANTOSO (0170R0111225V003405) terbaca sampah
// sehingga diagnosis & tindakan hilang. Deteksi: geser balik, lalu bandingkan
// jumlah kata umum dokumen RS sebelum vs sesudah. Teks hasil geser TIDAK
// dipakai (angka ikut hilang saat ekstraksi); halaman cukup di-OCR.
const KATA_UMUM = /\b(?:rawat|inap|jalan|pasien|diagnos\w*|dokter|resume|medis|tindakan|prosedur|lestari|raharja|obat|kelas|tanggal|nama|alamat|keluhan|terapi|pemeriksaan|rumah|sakit|hasil)\b/gi;
const GESERAN_UMUM = [29, 3];
function hitungKataUmum(t) { return (String(t).match(KATA_UMUM) || []).length; }
function geser(t, n) {
  return String(t).replace(/[!-~]/g, c => {
    const k = c.charCodeAt(0) + n;
    return k >= 33 && k <= 126 ? String.fromCharCode(k) : c;
  });
}
function teksTergeser(teks) {
  const asli = hitungKataUmum(teks);
  for (const n of GESERAN_UMUM) {
    // Kata menempel tanpa spasi pada teks bergeser; pisahkan huruf besar-kecil dulu.
    const g = geser(teks, n).replace(/([a-z])([A-Z])/g, '$1 $2');
    const tergeser = hitungKataUmum(g) + (String(g).match(/(?:rawat|inap|pasien|diagnos|dokter|resume|medis|lestari|raharja)/gi) || []).length;
    if (tergeser >= 3 && tergeser > 2 * (asli + 1)) return true;
  }
  return false;
}

/**
 * Putuskan sumber teks satu halaman.
 *
 * @param {string} teks teks lapisan PDF halaman itu (text_full dari classifier)
 * @param {{mode?: 'all'|'auto-scan'}} [opsi]
 *   'all' (default, perilaku ocrService.ocrPdfPages(..., 'all')): teks dipakai
 *     langsung bila >= 500 karakter dan bermutu; 50-499 tetap di-OCR (bisa
 *     campuran teks + tabel gambar).
 *   'auto-scan': teks dipakai bila >= 50 karakter dan bermutu.
 * @returns {{sumber: 'native_text'|'ocr', alasan: string, metrik: object}}
 */
function putuskanSumberHalaman(teks, { mode = 'all' } = {}) {
  const metrik = ukurMutuTeks(teks);
  if (metrik.panjang < AMBANG_HALAMAN_PINDAI) return { sumber: SUMBER.OCR, alasan: ALASAN.TANPA_TEKS, metrik };
  if (teksRusak(metrik) || teksTergeser(teks)) return { sumber: SUMBER.OCR, alasan: ALASAN.TEKS_SAMPAH, metrik };
  const ambang = mode === 'auto-scan' ? AMBANG_HALAMAN_PINDAI : AMBANG_TEKS_NYATA;
  if (metrik.panjang < ambang) return { sumber: SUMBER.OCR, alasan: ALASAN.TEKS_SEDIKIT, metrik };
  return { sumber: SUMBER.NATIVE, alasan: ALASAN.TEKS_CUKUP, metrik };
}

/** Pintasan boolean untuk hook di ocrService. */
function punyaLapisanTeksNyata(teks, opsi) {
  return putuskanSumberHalaman(teks, opsi).sumber === SUMBER.NATIVE;
}

/**
 * Rencana per dokumen.
 * @param {Array<{page_num?:number, page_number?:number, text_full?:string, text?:string}>} halaman
 * @returns {{native_text: number[], ocr: number[], rincian: Array}}
 */
function rencanakanSumberHalaman(halaman, opsi) {
  const rencana = { native_text: [], ocr: [], rincian: [] };
  for (const h of halaman || []) {
    const no = h.page_num != null ? h.page_num : h.page_number;
    const keputusan = putuskanSumberHalaman(h.text_full != null ? h.text_full : h.text, opsi);
    rencana[keputusan.sumber === SUMBER.NATIVE ? 'native_text' : 'ocr'].push(no);
    rencana.rincian.push({ halaman: no, sumber: keputusan.sumber, alasan: keputusan.alasan });
  }
  return rencana;
}

module.exports = {
  SUMBER, ALASAN, AMBANG_HALAMAN_PINDAI, AMBANG_TEKS_NYATA,
  ukurMutuTeks, putuskanSumberHalaman, punyaLapisanTeksNyata, rencanakanSumberHalaman, teksTergeser,
};
