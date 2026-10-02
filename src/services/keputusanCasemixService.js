/**
 * Keputusan casemix final -- aplikasi BELAJAR DARI SETIAP KASUS.
 *
 * Agen & aplikasi adalah casemix RUJUKAN; keputusan akhir ada pada casemix RS.
 * Saat casemix RS mencatat koding finalnya untuk satu berkas, aplikasi:
 *   1. membandingkannya dengan rekomendasi aplikasi (pola_beda_casemix --
 *      dasar metrik akurasi, sama seperti berkas berlembar grouper);
 *   2. menyimpan pasangan istilah resume -> kode pilihan casemix
 *      (pola_casemix_contoh -- petunjuk agen tinjau & pemeriksa kritis);
 *   3. menyusun PELAJARAN untuk kasus berikutnya: kode yang berulang kali
 *      dihapus/ditambah casemix RS (dipakai penalaran diagnosis, laporan, dan
 *      agen tanya-jawab). Pelajaran dari berkas itu sendiri tidak pernah
 *      dipakai untuk menilai berkas itu.
 *
 * Data klaim (DIAGLIST/PROCLIST) TIDAK diubah; keputusan disimpan terpisah.
 * Semua tanpa AI; kegagalan pencatatan tidak menggagalkan apa pun.
 */
const { deskripsiDiagnosis, deskripsiProsedur } = require('./kamusKodeService');
const { bandingkanCasemix } = require('./saranKodingService');
const { catatPolaBeda, golongkanBeda } = require('./polaBedaCasemixService');
const { pelajari } = require('./pembelajaranCasemixService');

async function ensureSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS keputusan_casemix (
      record_id TEXT PRIMARY KEY,
      jenis_klaim VARCHAR(20),
      dx TEXT, px TEXT, inacbg VARCHAR(20), tarif NUMERIC,
      rekomendasi_dx TEXT, rekomendasi_px TEXT, rekomendasi_inacbg VARCHAR(20), rekomendasi_tarif NUMERIC,
      kategori_beda TEXT, catatan TEXT,
      diputuskan_oleh TEXT,
      diputuskan_pada TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}
let skemaSiap = null;
function pastikanSkema(db) {
  if (!skemaSiap) skemaSiap = Promise.resolve().then(() => ensureSchema(db)).then(() => true).catch(e => { skemaSiap = null; throw e; });
  return skemaSiap;
}

const POLA_DX = /^[A-Z]\d{2}(?:\.\d{1,2})?$/;
const POLA_PX = /^\d{2}(?:\.\d{1,2})?$/;
/** "O42.1; z370 ,O82.1" -> ['O42.1','Z37.0','O82.1'] */
function rapikanKode(isi, jenis) {
  const daftar = Array.isArray(isi) ? isi : String(isi || '').split(/[;,\n]+/);
  const hasil = [];
  for (const mentah of daftar) {
    let k = String(mentah || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!k) continue;
    if (jenis === 'dx' && /^[A-Z]\d{3,4}$/.test(k)) k = `${k.slice(0, 3)}.${k.slice(3)}`;
    if (jenis === 'px' && /^\d{3,4}$/.test(k)) k = `${k.slice(0, 2)}.${k.slice(2)}`;
    if (!hasil.includes(k)) hasil.push(k);
  }
  return hasil;
}

function grup(hitung, record, dx, px) {
  if (!dx.length || typeof hitung !== 'function') return { kode: null, tarif: null };
  const h = hitung(dx, px, record.jenis_klaim || record.JENIS_KLAIM, record.kelas_rawat || record.KELAS_RAWAT, null);
  return { kode: h && h.inacbgResult ? h.inacbgResult.code : null, tarif: h && h.tarifResult && h.tarifResult.amount != null ? Number(h.tarifResult.amount) : null };
}

/**
 * @param {object} p
 * @param {object} p.saran hasil susunSaranKoding (rekomendasi aplikasi yang ditampilkan)
 * @returns {Promise<object>} ringkasan perbandingan + peringatan
 */
async function simpanKeputusan({ db, record, saran, pages, dx, px, catatan, oleh, hitungInacbgDanTarif }) {
  const kodeDx = rapikanKode(dx, 'dx');
  const kodePx = rapikanKode(px, 'px');
  if (!kodeDx.length) return { galat: 'Diagnosis final casemix wajib diisi (minimal diagnosis utama).' };
  const formatSalah = [...kodeDx.filter(k => !POLA_DX.test(k)), ...kodePx.filter(k => !POLA_PX.test(k))];
  if (formatSalah.length) return { galat: `Format kode tidak dikenali: ${formatSalah.join(', ')}.` };
  // Casemix RS adalah keputusan akhir: kode di luar kamus aplikasi tetap disimpan, diberi catatan.
  const diLuarKamus = [...kodeDx.filter(k => !deskripsiDiagnosis(k)), ...kodePx.filter(k => !deskripsiProsedur(k))];

  const final = grup(hitungInacbgDanTarif, record, kodeDx, kodePx);
  const rekDx = ((saran && saran.diagnosis) || []).map(d => d.kode);
  const rekPx = ((saran && saran.prosedur) || []).map(p => p.kode);
  const rekInacbg = saran && saran.inacbg ? { kode: saran.inacbg.kode, tarif: saran.inacbg.tarif } : grup(hitungInacbgDanTarif, record, rekDx, rekPx);
  const lembar = {
    diagnosis: kodeDx.map((kode, i) => ({ kode, peran: i === 0 ? 'utama' : 'sekunder' })),
    prosedur: kodePx.map(kode => ({ kode })),
    inacbg: { kode: final.kode, tarif: final.tarif },
  };
  const banding = bandingkanCasemix(lembar, rekDx.map(kode => ({ kode })), rekPx.map(kode => ({ kode })), rekInacbg);
  if (banding) banding.sumber = 'Keputusan casemix RS';
  const kategori = golongkanBeda(banding);

  await pastikanSkema(db);
  await db.run(`INSERT INTO keputusan_casemix (record_id, jenis_klaim, dx, px, inacbg, tarif, rekomendasi_dx, rekomendasi_px,
      rekomendasi_inacbg, rekomendasi_tarif, kategori_beda, catatan, diputuskan_oleh)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (record_id) DO UPDATE SET jenis_klaim = EXCLUDED.jenis_klaim, dx = EXCLUDED.dx, px = EXCLUDED.px, inacbg = EXCLUDED.inacbg,
      tarif = EXCLUDED.tarif, rekomendasi_dx = EXCLUDED.rekomendasi_dx, rekomendasi_px = EXCLUDED.rekomendasi_px,
      rekomendasi_inacbg = EXCLUDED.rekomendasi_inacbg, rekomendasi_tarif = EXCLUDED.rekomendasi_tarif, kategori_beda = EXCLUDED.kategori_beda,
      catatan = EXCLUDED.catatan, diputuskan_oleh = EXCLUDED.diputuskan_oleh, diputuskan_pada = CURRENT_TIMESTAMP`, [
    String(record.id), record.jenis_klaim || null, kodeDx.join(';'), kodePx.join(';'), final.kode, final.tarif,
    rekDx.join(';'), rekPx.join(';'), rekInacbg.kode || null, rekInacbg.tarif ?? null,
    (kategori.length ? kategori : ['cocok']).join(';'), String(catatan || '').slice(0, 1000) || null, oleh || null,
  ]);

  // Belajar (best-effort): metrik akurasi + pasangan istilah -> kode.
  const belajar = { pola_beda: false, pasangan: 0 };
  try { await catatPolaBeda(db, record.id, record.jenis_klaim, banding); belajar.pola_beda = true; } catch (e) { console.warn('[KeputusanCasemix] pola beda gagal:', e.message); }
  try { belajar.pasangan = (await pelajari(db, record.id, record.jenis_klaim, pages || [], lembar)).length; } catch (e) { console.warn('[KeputusanCasemix] pasangan gagal:', e.message); }

  return {
    tersimpan: true,
    final: { diagnosis: kodeDx, prosedur: kodePx, inacbg: final.kode, tarif: final.tarif },
    rekomendasi: { diagnosis: rekDx, prosedur: rekPx, inacbg: rekInacbg.kode || null, tarif: rekInacbg.tarif ?? null },
    cocok: kategori.length === 0,
    perbedaan: kategori,
    dihapus_casemix: { diagnosis: banding ? banding.diagnosis.hanya_ai : [], prosedur: banding ? banding.prosedur.hanya_ai : [] },
    ditambah_casemix: { diagnosis: banding ? banding.diagnosis.hanya_casemix : [], prosedur: banding ? banding.prosedur.hanya_casemix : [] },
    selisih_tarif: rekInacbg.tarif != null && final.tarif != null ? final.tarif - rekInacbg.tarif : null,
    di_luar_kamus: diLuarKamus,
    belajar,
  };
}

async function ambilKeputusan(db, recordId) {
  try {
    await pastikanSkema(db);
    const b = await db.get('SELECT * FROM keputusan_casemix WHERE record_id = ?', [String(recordId)]);
    if (!b) return null;
    const pecah = s => String(s || '').split(';').filter(Boolean);
    return { diagnosis: pecah(b.dx), prosedur: pecah(b.px), inacbg: b.inacbg, tarif: b.tarif == null ? null : Number(b.tarif),
      perbedaan: pecah(b.kategori_beda).filter(k => k !== 'cocok'), catatan: b.catatan, diputuskan_oleh: b.diputuskan_oleh, diputuskan_pada: b.diputuskan_pada };
  } catch (_) {
    return null;
  }
}

const MIN_KASUS = 2;
/**
 * Pelajaran dari keputusan casemix RS pada kasus LAIN (lembar grouper +
 * keputusan final), untuk kode yang sedang direkomendasikan.
 * Hanya pola yang berulang (>= MIN_KASUS dan >= 50%) agar satu kasus
 * tidak langsung jadi aturan.
 * @returns {Promise<Array<{kode, jenis, pola, kasus, jumlah, pesan, pengganti?}>>}
 */
async function pelajaranRelevan(db, { dx = [], px = [], recordId = null, jenisKlaim = null } = {}) {
  if (!db || (!dx.length && !px.length)) return [];
  let baris;
  try {
    // Unggahan ulang berkas yang sama (SEP sama) bukan "kasus lain".
    baris = await db.all(`SELECT dx_aplikasi, dx_casemix, px_aplikasi, px_casemix, jenis_klaim FROM pola_beda_casemix
      WHERE record_id <> ?
        AND record_id NOT IN (SELECT c2.id FROM claim_records c1 JOIN claim_records c2 ON c2.sep = c1.sep
          WHERE c1.id = ? AND COALESCE(c1.sep, '') <> '')
      ORDER BY dibuat DESC LIMIT 2000`, [String(recordId || ''), String(recordId || '')]);
  } catch (_) {
    return []; // tabel belum ada: belum ada yang dipelajari
  }
  if (jenisKlaim) baris = baris.filter(b => !b.jenis_klaim || b.jenis_klaim === jenisKlaim);
  const set = s => new Set(String(s || '').split(';').filter(Boolean));
  const hasil = [];
  const nilai = (kode, jenis, kolomApp, kolomCm) => {
    const relevan = baris.map(b => ({ app: set(b[kolomApp]), cm: set(b[kolomCm]) })).filter(b => b.app.has(kode));
    if (relevan.length < MIN_KASUS) return;
    const dihapus = relevan.filter(b => !b.cm.has(kode));
    if (dihapus.length >= MIN_KASUS && dihapus.length / relevan.length >= 0.5) {
      const ganti = new Map();
      for (const b of dihapus) for (const k of b.cm) if (!b.app.has(k)) ganti.set(k, (ganti.get(k) || 0) + 1);
      const pengganti = [...ganti.entries()].filter(([, n]) => n >= MIN_KASUS).sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 2);
      hasil.push({ kode, jenis, pola: 'sering_dihapus', kasus: relevan.length, jumlah: dihapus.length, pengganti,
        pesan: `Pada ${dihapus.length} dari ${relevan.length} kasus lain, casemix RS tidak mengode ${kode}${pengganti.length ? ` (memakai ${pengganti.join(', ')})` : ''}.` });
    }
    const tambah = new Map();
    for (const b of relevan) for (const k of b.cm) if (!b.app.has(k)) tambah.set(k, (tambah.get(k) || 0) + 1);
    for (const [k, n] of tambah) {
      if (n >= MIN_KASUS && n / relevan.length >= 0.5 && !dx.includes(k) && !px.includes(k)) {
        hasil.push({ kode: k, jenis, pola: 'sering_ditambah', bersama: kode, kasus: relevan.length, jumlah: n,
          pesan: `Pada ${n} dari ${relevan.length} kasus lain dengan ${kode}, casemix RS menambahkan ${k}. Periksa apakah dokumentasinya ada di berkas ini.` });
      }
    }
  };
  for (const k of dx) nilai(k, 'diagnosis', 'dx_aplikasi', 'dx_casemix');
  for (const k of px) nilai(k, 'prosedur', 'px_aplikasi', 'px_casemix');
  return hasil.filter((h, i, a) => a.findIndex(x => x.kode === h.kode && x.pola === h.pola) === i).slice(0, 8);
}

module.exports = { simpanKeputusan, ambilKeputusan, pelajaranRelevan, rapikanKode, ensureSchema };
