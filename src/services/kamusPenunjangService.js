/**
 * Kamus penunjang & prosedur: tulisan apa adanya di berkas -> istilah baku.
 *
 * TIGA ATURAN YANG TIDAK BOLEH DILONGGARKAN
 *
 *   1. Kode ICD-9-CM di kamus hanyalah USULAN. Hasil pencocokan membawa
 *      `kode_usulan` dan `kode_terverifikasi: false`; tidak ada jalur di sini
 *      yang mengisi kode ke klaim. Sebelum koder RS mengesahkan, kode hanya
 *      boleh tampil sebagai usulan.
 *
 *   2. Singkatan bertabrakan (DC, CT, HT, UR, UA, PT, BT, AL, RM, TC) tidak
 *      diputuskan sendiri. Hanya bila tepat SATU arti yang cocok dengan bagian
 *      berkas atau kata di sekitarnya, artinya dipilih. Selain itu hasilnya
 *      `perlu_konfirmasi` beserta kandidat. Salah tafsir DC menjadi kateter
 *      berarti prosedur yang tidak pernah dilakukan — itu temuan fraud.
 *
 *   3. Yang tidak dikenali tidak dibuang diam-diam: masuk antrean
 *      `varian_belum_dikenali` beserta jumlah kemunculannya.
 *
 * Batas pemindaian teks bebas: singkatan pendek (<= 2 huruf, mis. "AT", "NK",
 * "Ca", "SC") dan kata yang juga kata biasa ("gram", "uap") hanya dikenali bila SATU sel/baris memuat persis itu, bukan
 * ketika terselip di dalam kalimat. Di dalam kalimat, "at" atau "sc" terlalu
 * sering bukan pemeriksaan, dan salah kenali di sini berarti prosedur palsu.
 */

const DATA = require('../data/kamusPenunjang.json');

const BATAS_PANJANG_PINDAI = 3;
// Kata yang juga kata biasa / satuan ("1 gram", "lampu led"): hanya dikenali
// bila satu sel memuat persis itu, tidak dipindai dari dalam kalimat.
const LEWATI_PINDAI = new Set(['gram', 'uap', 'ana', 'led']);
const MAKS_KATA_FRASA = 5;
const LEBAR_KONTEKS = 40;

/**
 * Samakan bentuk tulisan: huruf kecil, huruf beraksen dilucuti (röntgen ->
 * rontgen), titik dan tanda hubung jadi spasi, spasi dirapatkan, dan tiga
 * ejaan toraks disatukan. Garis miring dipertahankan karena bermakna
 * ("UR/CR", "BT/CT").
 */
function rapikan(teks) {
  return String(teks || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/β/g, 'beta')
    .replace(/[.\-_,;:()\[\]]/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\b(thoraks|toraks|torak)\b/g, 'thorax')
    .replace(/\b(rontgent|ronsen|rongent)\b/g, 'rontgen')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── indeks ──────────────────────────────────────────────────────────────────
const istilahPerId = new Map();
const indeksVarian = new Map(); // varian_rapi -> [id]
const ambiguPerVarian = new Map(); // varian_rapi -> [kandidat]

function daftarkan(entri) {
  istilahPerId.set(entri.id, entri);
  for (const v of entri.varian || []) {
    const kunci = rapikan(v);
    if (!kunci) continue;
    const ada = indeksVarian.get(kunci) || [];
    if (!ada.includes(entri.id)) ada.push(entri.id);
    indeksVarian.set(kunci, ada);
  }
}
DATA.istilah.forEach(daftarkan);
(DATA.istilah_tambahan || []).forEach(e => istilahPerId.set(e.id, e));
for (const [singkatan, kandidat] of Object.entries(DATA.ambigu)) {
  ambiguPerVarian.set(rapikan(singkatan), kandidat);
}

/** Bentuk hasil yang seragam; kode SELALU berstatus usulan. */
function hasil(entri, ditulis, tambahan = {}) {
  return {
    status: 'dikenali',
    istilah_id: entri.id,
    istilah_baku: entri.baku,
    kategori: entri.kategori,
    kode_usulan: entri.kode || null,
    kode_terverifikasi: false,
    satuan: entri.satuan || null,
    menjadi_syarat: Boolean(entri.syarat),
    ditulis,
    ...tambahan,
  };
}

/**
 * Putuskan arti singkatan bertabrakan. Kembalikan kandidat tunggal atau null.
 * Bagian berkas didahulukan; bila belum memutuskan, kata di sekitarnya.
 */
function putuskanAmbigu(kandidat, { bagian, sekitar } = {}) {
  if (bagian) {
    const cocokBagian = kandidat.filter(k => (k.bagian || []).includes(bagian));
    if (cocokBagian.length === 1) return cocokBagian[0];
  }
  const kunciSekitar = rapikan(sekitar);
  if (kunciSekitar) {
    const cocokPola = kandidat.filter(k => k.pola && new RegExp(k.pola).test(kunciSekitar));
    if (cocokPola.length === 1) return cocokPola[0];
  }
  return null;
}

function perluKonfirmasi(ditulis, kandidat) {
  return {
    status: 'perlu_konfirmasi',
    ditulis,
    kandidat: kandidat.map(k => {
      const e = istilahPerId.get(k.istilah);
      return { istilah_id: k.istilah, istilah_baku: e ? e.baku : k.istilah, bagian: k.bagian || [] };
    }),
    kode_terverifikasi: false,
  };
}

/**
 * Cocokkan SATU tulisan (sel tabel / baris) dengan kamus.
 *
 * @param {string} teks tulisan apa adanya
 * @param {{bagian?: string, sekitar?: string}} [konteks]
 *   bagian: 'lab' | 'radiologi' | 'tindakan' | 'diagnosis' | 'ttv' | 'riwayat' | 'identitas' | 'transfusi'
 *   sekitar: teks di sekeliling tulisan itu
 */
function cocokkan(teks, konteks = {}) {
  const kunci = rapikan(teks);
  if (!kunci) return { status: 'tidak_dikenali', ditulis: String(teks || '') };

  const ambigu = ambiguPerVarian.get(kunci);
  if (ambigu) {
    const pilihan = putuskanAmbigu(ambigu, konteks);
    if (!pilihan) return perluKonfirmasi(teks, ambigu);
    return hasil(istilahPerId.get(pilihan.istilah), teks, { dipilih_dari_konteks: true });
  }

  const ids = indeksVarian.get(kunci);
  if (!ids) return { status: 'tidak_dikenali', ditulis: String(teks) };
  if (ids.length > 1) {
    // Varian yang sama terdaftar di dua istilah: tidak boleh ditebak.
    return perluKonfirmasi(teks, ids.map(id => ({ istilah: id, bagian: [] })));
  }
  return hasil(istilahPerId.get(ids[0]), teks);
}

/**
 * Pindai teks bebas dan kembalikan semua pemeriksaan/tindakan yang dikenali.
 * Frasa terpanjang menang ("ct scan kepala" mengalahkan "ct"). Singkatan
 * pendek dan bertabrakan dilewati di sini — lihat catatan di kepala berkas.
 */
function temukanDalamTeks(teks, konteks = {}) {
  const kata = rapikan(teks).split(' ').filter(Boolean);
  const temuan = [];
  const dipakai = new Set();

  for (let panjang = Math.min(MAKS_KATA_FRASA, kata.length); panjang >= 1; panjang--) {
    for (let i = 0; i + panjang <= kata.length; i++) {
      if ([...Array(panjang).keys()].some(n => dipakai.has(i + n))) continue;
      const frasa = kata.slice(i, i + panjang).join(' ');
      if (frasa.length < BATAS_PANJANG_PINDAI || LEWATI_PINDAI.has(frasa)) continue;
      const ids = indeksVarian.get(frasa);
      if (!ids) continue;
      for (let n = 0; n < panjang; n++) dipakai.add(i + n);
      if (ids.length > 1) {
        temuan.push(perluKonfirmasi(frasa, ids.map(id => ({ istilah: id, bagian: [] }))));
      } else {
        temuan.push(hasil(istilahPerId.get(ids[0]), frasa, konteks.bagian ? { bagian: konteks.bagian } : {}));
      }
    }
  }
  return temuan;
}

// ── antrean varian belum dikenali ───────────────────────────────────────────
async function catatVarianBelumDikenali(db, teks, klaimId = null) {
  const kunci = rapikan(teks).slice(0, 80);
  if (!kunci || kunci.length < 2) return null;
  await db.run(
    `INSERT INTO varian_belum_dikenali (varian_rapi, jumlah_muncul, contoh_klaim_id, terakhir_muncul)
     VALUES (?, 1, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (varian_rapi) DO UPDATE
       SET jumlah_muncul = varian_belum_dikenali.jumlah_muncul + 1,
           terakhir_muncul = CURRENT_TIMESTAMP`,
    [kunci, klaimId],
  );
  return kunci;
}

// ── seed ke basis data ──────────────────────────────────────────────────────
/** Isi tabel dari berkas data. Idempoten: entri yang sudah ada tidak diubah. */
async function seedKamusPenunjang(db) {
  const semua = [...DATA.istilah, ...(DATA.istilah_tambahan || [])];
  for (const e of semua) {
    await db.run(
      `INSERT INTO kamus_penunjang (id, istilah_baku, kategori, kode_icd9, kode_terverifikasi, satuan, menjadi_syarat)
       VALUES (?, ?, ?, ?, FALSE, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [e.id, e.baku, e.kategori, e.kode || null, e.satuan || null, Boolean(e.syarat)],
    );
    for (const v of e.varian || []) {
      await db.run(
        `INSERT INTO kamus_variasi (istilah_id, varian, varian_rapi, ambigu)
         VALUES (?, ?, ?, FALSE)
         ON CONFLICT (varian_rapi, istilah_id) DO NOTHING`,
        [e.id, v, rapikan(v)],
      );
    }
  }
  for (const [singkatan, kandidat] of Object.entries(DATA.ambigu)) {
    for (const k of kandidat) {
      const konteks = `${(k.bagian || []).join('/') || 'kata sekitar'}: ${k.pola}`.slice(0, 120);
      await db.run(
        `INSERT INTO kamus_variasi (istilah_id, varian, varian_rapi, ambigu, konteks_pembeda)
         VALUES (?, ?, ?, TRUE, ?)
         ON CONFLICT (varian_rapi, istilah_id) DO NOTHING`,
        [k.istilah, singkatan, rapikan(singkatan), konteks],
      );
    }
  }
}

module.exports = {
  rapikan,
  cocokkan,
  temukanDalamTeks,
  putuskanAmbigu,
  catatVarianBelumDikenali,
  seedKamusPenunjang,
  SINGKATAN_BERTABRAKAN: [...ambiguPerVarian.keys()],
};
