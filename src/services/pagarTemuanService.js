/**
 * Pagar temuan (kesalahan tipe 4: dikarang).
 *
 * Setiap temuan wajib membawa `kutipan` + `halaman`, dan kutipan itu harus
 * benar-benar ada, huruf demi huruf, di teks halaman tersebut. Pencocokan
 * hanya toleran terhadap spasi/baris baru dan huruf besar-kecil, tidak
 * terhadap kata yang berbeda. Model boleh menjawab "tidak ditemukan"; itu
 * ditolak dengan alasan sendiri, bukan diam-diam.
 *
 * Skema temuan:
 *   { jenis: 'diagnosis'|'prosedur'|'penunjang'|'obat',
 *     teks, halaman, kutipan,
 *     disangkal: boolean,
 *     sumber: 'cetak'|'tulisan_tangan',
 *     yakin: 'tinggi'|'sedang'|'rendah',
 *     kode?: string }            // untuk diagnosis/prosedur bila ada kode
 *
 * Kode diagnosis (icd10_who_codes) dan prosedur (icd9_cm_procedures) harus ada
 * di tabel referensi. Himpunan kode valid disuplai pemanggil (lihat
 * kumpulkanKodeValid) agar fungsi inti tetap murni.
 *
 * Tulisan tangan (sumber 'tulisan_tangan') SELALU ditandai perlu_cek_manusia.
 *
 * STATUS: verifikasiKutipan dipakai alur AI review live lewat
 * pagarPascaAiService (post-processing suggested_codes, saklar
 * PAGAR_KUTIPAN_AKTIF). aiReviewService tetap memakai validateQuotation pada
 * tahap lamanya; keduanya setara untuk kutipan yang sah, dan verifikasiKutipan
 * menambah penolakan kutipan "tidak ditemukan"/terlalu pendek. saringTemuan dan
 * skema temuan penuh belum dipakai live.
 */

const { tandaiNegasi } = require('./negasiTemuanService');

const JENIS = ['diagnosis', 'prosedur', 'penunjang', 'obat'];
const SUMBER = ['cetak', 'tulisan_tangan'];
const YAKIN = ['tinggi', 'sedang', 'rendah'];
const KUTIPAN_MIN = 3; // panjang minimum setelah dinormalkan

const ALASAN = {
  SKEMA: 'skema_tidak_valid',
  KUTIPAN_KOSONG: 'kutipan_kosong',
  HALAMAN_KOSONG: 'halaman_kosong',
  TIDAK_DITEMUKAN: 'model_menjawab_tidak_ditemukan',
  HALAMAN_TAK_ADA: 'halaman_tidak_ada_di_berkas',
  KUTIPAN_TAK_ADA: 'kutipan_tidak_ada_di_halaman',
  KODE_TAK_ADA: 'kode_tidak_ada_di_tabel_referensi',
};

/** Hanya spasi dan huruf besar-kecil yang ditoleransi. */
function normalisasiTeks(teks) {
  return String(teks == null ? '' : teks)
    .normalize('NFC')
    .replace(/[  -​ 　]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalisasiKode(kode) {
  return String(kode || '').trim().toUpperCase();
}

const RE_TIDAK_DITEMUKAN = /^\W*(tidak\s+(di)?temukan|tdk\s+ditemukan|tidak\s+ada|not\s+found|none|null|n\/a|-)\W*$/i;

function teksHalaman(hal) {
  return hal ? (hal.ocr_text != null ? hal.ocr_text : hal.text) : null;
}

/**
 * Apakah kutipan ada, apa adanya, di teks halaman itu.
 * @param {string} kutipan
 * @param {number} nomorHalaman
 * @param {Array<{page_number:number, ocr_text?:string, text?:string}>} halaman
 * @returns {{valid: boolean, alasan: string|null}}
 */
function verifikasiKutipan(kutipan, nomorHalaman, halaman) {
  if (kutipan == null || typeof kutipan !== 'string' || !kutipan.trim()) {
    return { valid: false, alasan: ALASAN.KUTIPAN_KOSONG };
  }
  if (RE_TIDAK_DITEMUKAN.test(kutipan)) return { valid: false, alasan: ALASAN.TIDAK_DITEMUKAN };
  if (nomorHalaman == null || nomorHalaman === '') return { valid: false, alasan: ALASAN.HALAMAN_KOSONG };
  const hal = (halaman || []).find(h => Number(h.page_number) === Number(nomorHalaman));
  const isi = teksHalaman(hal);
  if (!hal || isi == null) return { valid: false, alasan: ALASAN.HALAMAN_TAK_ADA };
  const kunci = normalisasiTeks(kutipan);
  if (kunci.length < KUTIPAN_MIN) return { valid: false, alasan: ALASAN.KUTIPAN_KOSONG };
  return normalisasiTeks(isi).includes(kunci)
    ? { valid: true, alasan: null }
    : { valid: false, alasan: ALASAN.KUTIPAN_TAK_ADA };
}

/**
 * Bentuk seragam sebuah temuan; null bila skema tidak valid.
 * Nilai sumber/yakin yang tidak dikenal diturunkan ke yang paling hati-hati
 * ('tulisan_tangan' / 'rendah'), bukan ke yang paling meyakinkan.
 */
function rapikanTemuan(t) {
  if (!t || typeof t !== 'object') return null;
  if (!JENIS.includes(t.jenis)) return null;
  const teks = typeof t.teks === 'string' ? t.teks.trim() : '';
  if (!teks) return null;
  return {
    ...t,
    jenis: t.jenis,
    teks,
    halaman: t.halaman == null || t.halaman === '' ? null : Number(t.halaman),
    kutipan: typeof t.kutipan === 'string' ? t.kutipan : null,
    disangkal: t.disangkal === true,
    sumber: SUMBER.includes(t.sumber) ? t.sumber : 'tulisan_tangan',
    yakin: YAKIN.includes(t.yakin) ? t.yakin : 'rendah',
  };
}

/**
 * Saring daftar temuan.
 *
 * @param {Array} temuan
 * @param {Array<{page_number:number, ocr_text?:string, text?:string}>} halaman
 * @param {{kodeValid?: {diagnosis?: Set<string>|null, prosedur?: Set<string>|null}}} [opsi]
 *   kodeValid.diagnosis / .prosedur: himpunan kode yang ADA di tabel
 *   referensi. Bernilai null/tidak diberikan berarti tabel tidak dapat
 *   diperiksa; kode lalu lolos dengan tanda `kode_belum_dicek: true` (gagal
 *   periksa bukan berarti salah).
 * @returns {{diterima: Array, ditolak: Array<{temuan:any, alasan:string}>, ringkasan: object}}
 */
function saringTemuan(temuan, halaman, opsi = {}) {
  const kodeValid = opsi.kodeValid || {};
  const diterima = [];
  const ditolak = [];

  for (const mentah of temuan || []) {
    const t = rapikanTemuan(mentah);
    if (!t) { ditolak.push({ temuan: mentah, alasan: ALASAN.SKEMA }); continue; }

    const cek = verifikasiKutipan(t.kutipan, t.halaman, halaman);
    if (!cek.valid) { ditolak.push({ temuan: mentah, alasan: cek.alasan }); continue; }

    let hasil = { ...t };

    if ((t.jenis === 'diagnosis' || t.jenis === 'prosedur') && t.kode) {
      const himpunan = kodeValid[t.jenis];
      if (himpunan instanceof Set) {
        if (!himpunan.has(normalisasiKode(t.kode))) {
          ditolak.push({ temuan: mentah, alasan: ALASAN.KODE_TAK_ADA });
          continue;
        }
      } else {
        hasil.kode_belum_dicek = true;
      }
    }

    hasil = tandaiNegasi(hasil);
    if (hasil.sumber === 'tulisan_tangan') {
      hasil.perlu_cek_manusia = true;
      hasil.alasan_cek = 'tulisan tangan selalu diperiksa manusia';
    }
    diterima.push(hasil);
  }

  const perAlasan = {};
  for (const d of ditolak) perAlasan[d.alasan] = (perAlasan[d.alasan] || 0) + 1;
  return {
    diterima,
    ditolak,
    ringkasan: {
      masuk: (temuan || []).length,
      diterima: diterima.length,
      ditolak: ditolak.length,
      perlu_cek_manusia: diterima.filter(d => d.perlu_cek_manusia).length,
      disangkal: diterima.filter(d => d.disangkal).length,
      alasan_ditolak: perAlasan,
    },
  };
}

/**
 * Bantu pemanggil menyusun kodeValid dari tabel referensi.
 * @param {Array} temuan
 * @param {(tabel: string, kode: string[]) => Promise<Set<string>|null>} lookup
 *   mis. aiReviewService.lookupCodesInTable (mengembalikan null bila gagal).
 */
async function kumpulkanKodeValid(temuan, lookup) {
  const kumpul = (jenis) => [...new Set((temuan || [])
    .filter(t => t && t.jenis === jenis && t.kode).map(t => normalisasiKode(t.kode)))];
  const [diagnosis, prosedur] = await Promise.all([
    kumpul('diagnosis').length ? lookup('icd10_who_codes', kumpul('diagnosis')) : new Set(),
    kumpul('prosedur').length ? lookup('icd9_cm_procedures', kumpul('prosedur')) : new Set(),
  ]);
  return { diagnosis, prosedur };
}

module.exports = {
  JENIS, SUMBER, YAKIN, ALASAN,
  normalisasiTeks, normalisasiKode,
  verifikasiKutipan, rapikanTemuan, saringTemuan, kumpulkanKodeValid,
};
