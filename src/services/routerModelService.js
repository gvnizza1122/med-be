/**
 * Router model — tugas -> {penyedia, model}.
 *
 * SIFAT KEAMANAN
 *  1. FALLBACK KE ENV: bila tabel `router_model` tidak punya baris untuk tugas
 *     itu, ATAU tabelnya belum ada, ATAU DB error, hasilnya persis perilaku
 *     hidup hari ini (AI_MODEL / AI_PROVIDER_* untuk 'openai_compat'). Router
 *     tidak pernah melempar error karena tabel hilang.
 *  2. Tidak ada baris yang di-seed. Tabel dibiarkan kosong sampai manusia
 *     mengisinya lewat setModel(); jadi memasang modul ini tidak mengubah
 *     model yang dipakai sistem hidup.
 *  3. Model dengan lulus_uji=false TIDAK diblokir, tetapi setiap resolve()
 *     dan setModel() mengembalikan field `peringatan` agar terlihat.
 *  4. Cache 30 detik (bisa dimatikan) agar tidak menambah query DB per
 *     panggilan model; setModel() dan hapusCache() menyegarkannya.
 *
 * SKEMA BIAYA (klien, 2 Okt 2026): semua pembacaan & pengisian data berkas
 * (ekstrak_pdf, baca_berkas: pemeriksaan fisik, penunjang, tindakan, dst.)
 * memakai AI_MODEL = gpt-6-luna. Hanya tinjau_kasus_lanjutan (analisis
 * mendalam: diagnosis/prosedur membingungkan, INA-CBG/tarif belum pasti,
 * kriteria IGD borderline, alasan pending belum tegas, atau diminta koder)
 * memakai AI_REVIEW_MODEL = gpt-6.1-sol. Pemicunya: tinjauanLanjutanService.ambilPemicu.
 *
 * DEFAULT YANG DIRENCANAKAN (dokumentasi saja — TIDAK di-seed):
 *   baca_berkas              -> luna   (openai_compat)
 *   petakan_alasan_pending   -> kimi   (kimi)
 *   baca_kedua               -> kimi   (kimi)     [hanya klaim berisiko]
 *   rancang_jawaban_pending  -> luna   (openai_compat)
 *   analisis_pending         -> kimi   (kimi)
 *   baca_regulasi            -> kimi   (kimi)
 *
 * Penyedia yang dikenal: 'openai_compat' (env AI_PROVIDER_API_KEY,
 * AI_PROVIDER_BASE_URL, AI_MODEL) dan 'kimi' (env KIMI_API_KEY,
 * KIMI_BASE_URL, KIMI_MODEL — lihat kimiClient.js). Adapter Kimi BELUM
 * diuji terhadap API Kimi K3 sungguhan.
 */

const TUGAS = Object.freeze([
  'baca_berkas',
  'petakan_alasan_pending',
  'baca_kedua',
  'rancang_jawaban_pending',
  'analisis_pending',
  'baca_regulasi',
  'petakan_diagnosis_who',
  'kodekan_tindakan_baru',
  'audit_berkas_field',
  'ringkas_training_pending',
  'putuskan_pending',
  'ekstrak_pdf',
  'tinjau_kasus_lanjutan',
  'agen_tinjau',
]);

const PENYEDIA = Object.freeze(['openai_compat', 'kimi']);

const TTL_CACHE_MS = 30000;
const cache = new Map(); // tugas -> {waktu, nilai}
let peringatanTabelSudahDicetak = false;

function hapusCache() {
  cache.clear();
}

function modelDariEnv(tugas, penyedia = 'openai_compat') {
  if (tugas === 'tinjau_kasus_lanjutan') {
    return { penyedia: 'openai_compat', model: process.env.AI_REVIEW_MODEL || 'gpt-6.1-sol' };
  }
  if (tugas === 'ringkas_training_pending') {
    return { penyedia: 'kimi', model: process.env.KIMI_MODEL || 'kimi-k3' };
  }
  if (penyedia === 'kimi') {
    return { penyedia: 'kimi', model: process.env.KIMI_MODEL || 'kimi-k3' };
  }
  return { penyedia: 'openai_compat', model: process.env.AI_MODEL || 'gpt-4o-mini' };
}

function buatPeringatan(tugas, model, lulusUji) {
  if (lulusUji === false || lulusUji === null || lulusUji === undefined) {
    return `Model "${model}" belum lulus uji untuk tugas "${tugas}". Tetap dipakai, tetapi hasilnya belum teruji.`;
  }
  return null;
}

/**
 * @returns {Promise<{tugas, penyedia, model, sumber:'router_model'|'env', lulus_uji:boolean|null, peringatan:string|null}>}
 */
async function resolve(db, tugas, opsi = {}) {
  const pakaiCache = opsi.cache !== false;
  const sekarang = Date.now();
  if (pakaiCache) {
    const c = cache.get(tugas);
    if (c && sekarang - c.waktu < TTL_CACHE_MS) return { ...c.nilai };
  }

  const env = modelDariEnv(tugas);
  let hasil = {
    tugas, ...env, sumber: 'env', lulus_uji: null, peringatan: null,
  };

  if (!TUGAS.includes(tugas)) {
    hasil.peringatan = `Tugas "${tugas}" tidak dikenal router; memakai konfigurasi env.`;
    return hasil; // sengaja tidak di-cache dan tidak melempar
  }

  try {
    const baris = db ? await db.get(
      'SELECT tugas, penyedia, model, lulus_uji FROM router_model WHERE tugas = ?',
      [tugas],
    ) : null;
    if (baris && baris.penyedia && baris.model) {
      if (!PENYEDIA.includes(baris.penyedia)) {
        hasil.peringatan = `Penyedia "${baris.penyedia}" pada router_model tidak dikenal; memakai env.`;
      } else {
        hasil = {
          tugas,
          penyedia: baris.penyedia,
          model: baris.model,
          sumber: 'router_model',
          lulus_uji: baris.lulus_uji === true,
          peringatan: buatPeringatan(tugas, baris.model, baris.lulus_uji === true),
        };
      }
    }
  } catch (err) {
    // Tabel belum ada / DB bermasalah: perilaku hidup tetap berjalan.
    if (!peringatanTabelSudahDicetak) {
      peringatanTabelSudahDicetak = true;
      console.warn(`[RouterModel] router_model tidak terbaca (${err.message}); memakai env.`);
    }
  }

  if (pakaiCache) cache.set(tugas, { waktu: sekarang, nilai: { ...hasil } });
  return hasil;
}

async function ensureSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS router_model (
      tugas VARCHAR(40) PRIMARY KEY,
      penyedia VARCHAR(40) NOT NULL,
      model VARCHAR(120) NOT NULL,
      lulus_uji BOOLEAN NOT NULL DEFAULT FALSE,
      diubah_pada TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * Ubah model untuk satu tugas. Tidak memblokir model yang belum lulus uji,
 * tetapi mengembalikan `peringatan`.
 */
async function setModel(db, tugas, { penyedia, model, lulus_uji = false }) {
  if (!TUGAS.includes(tugas)) throw new Error(`Tugas tidak dikenal: ${tugas}`);
  if (!PENYEDIA.includes(penyedia)) throw new Error(`Penyedia tidak dikenal: ${penyedia}`);
  if (!model || !String(model).trim()) throw new Error('Nama model wajib diisi');
  await db.run(
    `INSERT INTO router_model (tugas, penyedia, model, lulus_uji, diubah_pada)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (tugas) DO UPDATE SET penyedia = EXCLUDED.penyedia, model = EXCLUDED.model,
       lulus_uji = EXCLUDED.lulus_uji, diubah_pada = CURRENT_TIMESTAMP`,
    [tugas, penyedia, String(model).trim(), !!lulus_uji],
  );
  hapusCache();
  return {
    tugas, penyedia, model: String(model).trim(), lulus_uji: !!lulus_uji,
    peringatan: buatPeringatan(tugas, String(model).trim(), !!lulus_uji),
  };
}

/** Tandai hasil uji suatu tugas (dipanggil setelah uji perbandingan model). */
async function tandaiLulusUji(db, tugas, lulus) {
  if (!TUGAS.includes(tugas)) throw new Error(`Tugas tidak dikenal: ${tugas}`);
  const r = await db.run(
    'UPDATE router_model SET lulus_uji = ?, diubah_pada = CURRENT_TIMESTAMP WHERE tugas = ?',
    [!!lulus, tugas],
  );
  hapusCache();
  return r.changes > 0;
}

/** Hapus baris -> tugas kembali ke perilaku env. */
async function hapusModel(db, tugas) {
  await db.run('DELETE FROM router_model WHERE tugas = ?', [tugas]);
  hapusCache();
}

async function daftar(db) {
  const hasil = [];
  for (const t of TUGAS) hasil.push(await resolve(db, t, { cache: false }));
  return hasil;
}

module.exports = {
  TUGAS, PENYEDIA, ensureSchema, resolve, setModel, tandaiLulusUji, hapusModel, daftar, hapusCache, modelDariEnv,
};
