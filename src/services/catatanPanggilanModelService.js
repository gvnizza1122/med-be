const { pastikanIndeks, pastikanKolom } = require('../database/schemaIdempotent');
/**
 * Catatan panggilan model — jejak audit "model apa dipanggil untuk tugas apa".
 *
 * SIFAT KEAMANAN
 *  - TIDAK PERNAH menyimpan isi prompt, jawaban, maupun data pasien. Kolom
 *    hanya metadata: tugas, penyedia, model, versi, waktu, durasi, ok,
 *    effort, jenis klaim, jumlah token dan estimasi biaya. Fungsi catat() menolak
 *    (mengabaikan) field lain, jadi tidak ada jalan tak sengaja memasukkan teks.
 *  - Best-effort: kegagalan mencatat (tabel belum ada, DB mati) TIDAK
 *    menggagalkan panggilan model dan tidak melempar error.
 *  - Skema dan kolom tambahan dibuat idempotent lewat init.js.
 */

async function ensureSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS catatan_panggilan_model (
      id BIGSERIAL PRIMARY KEY,
      tugas VARCHAR(40) NOT NULL,
      penyedia VARCHAR(40),
      model VARCHAR(120),
      versi VARCHAR(40),
      waktu TIMESTAMP NOT NULL DEFAULT timezone('UTC', CURRENT_TIMESTAMP),
      durasi_ms INTEGER,
      ok BOOLEAN NOT NULL
    )
  `);
  await pastikanIndeks(db, 'CREATE INDEX IF NOT EXISTS idx_catatan_panggilan_model_tugas_waktu ON catatan_panggilan_model(tugas, waktu DESC)');
  await pastikanKolom(db, 'catatan_panggilan_model', {
    effort:'VARCHAR(12)',jenis_klaim:'VARCHAR(20)',prompt_tokens:'INTEGER',completion_tokens:'INTEGER',
    cached_tokens:'INTEGER',reasoning_tokens:'INTEGER',estimasi_usd:'DOUBLE PRECISION',
    estimasi_idr:'DOUBLE PRECISION',kurs_usd_idr:'DOUBLE PRECISION',total_tokens:'INTEGER',
    hospital_code:'TEXT',record_id:'TEXT',cache_write_tokens:'INTEGER',
  });
  await pastikanIndeks(db, 'CREATE INDEX IF NOT EXISTS idx_catatan_model_rs_waktu ON catatan_panggilan_model(hospital_code, waktu)');
}

/**
 * @param {object} db
 * @param {{tugas:string, penyedia?:string, model?:string, versi?:string, durasi_ms?:number, ok:boolean}} c
 * @returns {Promise<boolean>} true bila tercatat
 */
async function catat(db, c) {
  try {
    if (!db || !c || !c.tugas) return false;
    const durasi = Number.isFinite(c.durasi_ms) ? Math.round(c.durasi_ms) : null;
    const token = k => Number.isFinite(c.penggunaan?.[k]) ? Math.max(0, Math.round(c.penggunaan[k])) : null;
    await db.run(
      `INSERT INTO catatan_panggilan_model (tugas, penyedia, model, versi, waktu, durasi_ms, ok,
         effort, jenis_klaim, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens,
         estimasi_usd, estimasi_idr, kurs_usd_idr, total_tokens, hospital_code, record_id, cache_write_tokens)
       VALUES (?, ?, ?, ?, timezone('UTC', CURRENT_TIMESTAMP), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(c.tugas).slice(0, 40),
        c.penyedia ? String(c.penyedia).slice(0, 40) : null,
        c.model ? String(c.model).slice(0, 120) : null,
        c.versi ? String(c.versi).slice(0, 40) : null,
        durasi,
        !!c.ok,
        ['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(c.effort) ? c.effort : null,
        ['RAWAT_JALAN', 'RAWAT_INAP'].includes(c.jenis_klaim) ? c.jenis_klaim : null,
        token('prompt_tokens'), token('completion_tokens'), token('cached_tokens'), token('reasoning_tokens'),
        Number.isFinite(c.biaya?.usd) ? c.biaya.usd : null,
        Number.isFinite(c.biaya?.idr) ? c.biaya.idr : null,
        Number.isFinite(c.biaya?.kurs) ? c.biaya.kurs : null,
        token('total_tokens'),
        c.hospital_code ? String(c.hospital_code).slice(0, 40) : null,
        c.record_id ? String(c.record_id).slice(0, 80) : null,
        token('cache_write_tokens'),
      ],
    );
    return true;
  } catch (err) {
    console.warn(`[CatatanModel] gagal mencatat: ${err.message}`);
    return false;
  }
}

/** Ringkasan per tugas/model untuk N hari terakhir (tanpa isi apa pun). */
async function ringkasan(db, hari = 30) {
  try {
    return await db.all(
      `SELECT tugas, penyedia, model, effort, jenis_klaim, COUNT(*) AS jumlah,
              SUM(CASE WHEN ok THEN 1 ELSE 0 END) AS berhasil,
              ROUND(AVG(durasi_ms)) AS rata_durasi_ms,
              SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens,
              SUM(cached_tokens) AS cached_tokens, SUM(reasoning_tokens) AS reasoning_tokens,
              SUM(estimasi_usd) AS estimasi_usd, SUM(estimasi_idr) AS estimasi_idr,
              COUNT(estimasi_usd) AS panggilan_dengan_estimasi
       FROM catatan_panggilan_model
       WHERE waktu >= CURRENT_TIMESTAMP - (? * INTERVAL '1 day')
       GROUP BY tugas, penyedia, model, effort, jenis_klaim
       ORDER BY tugas, model`,
      [hari],
    );
  } catch (err) {
    console.warn(`[CatatanModel] gagal membaca ringkasan: ${err.message}`);
    return [];
  }
}

module.exports = { ensureSchema, catat, ringkasan };
