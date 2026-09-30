/**
 * Catatan panggilan model — jejak audit "model apa dipanggil untuk tugas apa".
 *
 * SIFAT KEAMANAN
 *  - TIDAK PERNAH menyimpan isi prompt, jawaban, maupun data pasien. Kolom
 *    hanya metadata: tugas, penyedia, model, versi (versi konfigurasi/prompt
 *    yang dilaporkan pemanggil), waktu, durasi, ok. Fungsi catat() menolak
 *    (mengabaikan) field lain, jadi tidak ada jalan tak sengaja memasukkan teks.
 *  - Best-effort: kegagalan mencatat (tabel belum ada, DB mati) TIDAK
 *    menggagalkan panggilan model dan tidak melempar error.
 *  - Tabel dibuat lewat ensureSchema(db) (belum dipasang di init.js).
 */

async function ensureSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS catatan_panggilan_model (
      id BIGSERIAL PRIMARY KEY,
      tugas VARCHAR(40) NOT NULL,
      penyedia VARCHAR(40),
      model VARCHAR(120),
      versi VARCHAR(40),
      waktu TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      durasi_ms INTEGER,
      ok BOOLEAN NOT NULL
    )
  `);
  await db.query(
    'CREATE INDEX IF NOT EXISTS idx_catatan_panggilan_model_tugas_waktu ON catatan_panggilan_model(tugas, waktu DESC)',
  );
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
    await db.run(
      `INSERT INTO catatan_panggilan_model (tugas, penyedia, model, versi, waktu, durasi_ms, ok)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`,
      [
        String(c.tugas).slice(0, 40),
        c.penyedia ? String(c.penyedia).slice(0, 40) : null,
        c.model ? String(c.model).slice(0, 120) : null,
        c.versi ? String(c.versi).slice(0, 40) : null,
        durasi,
        !!c.ok,
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
      `SELECT tugas, penyedia, model, COUNT(*) AS jumlah,
              SUM(CASE WHEN ok THEN 1 ELSE 0 END) AS berhasil,
              ROUND(AVG(durasi_ms)) AS rata_durasi_ms
       FROM catatan_panggilan_model
       WHERE waktu >= CURRENT_TIMESTAMP - (? * INTERVAL '1 day')
       GROUP BY tugas, penyedia, model
       ORDER BY tugas, model`,
      [hari],
    );
  } catch (err) {
    console.warn(`[CatatanModel] gagal membaca ringkasan: ${err.message}`);
    return [];
  }
}

module.exports = { ensureSchema, catat, ringkasan };
