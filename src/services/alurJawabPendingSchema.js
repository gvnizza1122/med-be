const { pastikanIndeks } = require('../database/schemaIdempotent');
/**
 * Skema tabel "Alur Menjawab Pending BPJS".
 *
 * Sengaja terpisah dari database/init.js. Semua tabel di sini BARU dan
 * berkunci ke bpjs_pending_responses.id lewat kolom biasa (tanpa FK), sama
 * seperti pending_file_id: menghapus file rekap tidak boleh gagal karena tabel
 * turunan, dan kolom jawaban_rs_manual di bpjs_pending_responses TIDAK
 * disentuh sama sekali (itu data pengguna yang tidak tergantikan).
 *
 * Pasang dengan menambahkan 'alurJawabPendingSchema' ke daftar modul
 * ensureSchema di init.js. Sebelum dipasang, rute memanggil ensureSchema
 * sekali secara malas (lihat routes/jawabPending.js) sehingga tetap jalan.
 */

async function ensureSchema(db) {
  // Pemetaan alasan -> kategori + jenis rawat. sumber 'manual' = koreksi koder,
  // tidak pernah ditimpa pemetaan ulang.
  await db.query(`
    CREATE TABLE IF NOT EXISTS pending_alasan_peta (
      pending_id TEXT PRIMARY KEY,
      kategori TEXT NOT NULL,
      sumber TEXT NOT NULL DEFAULT 'aturan',
      aturan_id TEXT,
      kategori_lain TEXT,
      model_ai TEXT,
      jenis_rawat TEXT,
      sumber_jenis TEXT,
      jenis_konflik BOOLEAN DEFAULT FALSE,
      dikoreksi_oleh TEXT,
      dikoreksi_pada TIMESTAMP,
      diperbarui_pada TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pastikanIndeks(db, 'CREATE INDEX IF NOT EXISTS idx_pending_alasan_peta_kategori ON pending_alasan_peta(kategori, jenis_rawat)');

  // Triase empat kotak. kriteria = JSON daftar {id, uraian, terpenuhi, bukti};
  // kotak_manual = putusan koder, dipakai bila ada dan tidak ditimpa hitung ulang.
  await db.query(`
    CREATE TABLE IF NOT EXISTS pending_triase (
      pending_id TEXT PRIMARY KEY,
      kotak TEXT,
      alasan_kotak TEXT,
      kriteria TEXT,
      dokumen_dibutuhkan TEXT,
      jumlah_halaman INTEGER,
      kotak_manual TEXT,
      catatan_manual TEXT,
      diubah_oleh TEXT,
      dihitung_pada TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Draf jawaban. Tidak menggantikan draft_klarifikasi maupun jawaban_rs_manual.
  // poin = JSON daftar {topik, kalimat, jenis_poin, halaman, kutipan, terverifikasi, sumber_kriteria}.
  // status: draft -> siap (hanya lewat persetujuan koder) | ditolak.
  await db.query(`
    CREATE TABLE IF NOT EXISTS draft_jawaban_pending (
      id TEXT PRIMARY KEY,
      pending_id TEXT NOT NULL,
      versi INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      kotak TEXT,
      kategori TEXT,
      teks_draft TEXT,
      poin TEXT,
      jumlah_poin_terbukti INTEGER DEFAULT 0,
      jumlah_poin_tanpa_bukti INTEGER DEFAULT 0,
      dibuat_dengan TEXT,
      dibuat_oleh TEXT,
      dibuat_pada TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      disetujui_oleh TEXT,
      disetujui_pada TIMESTAMP,
      catatan_koder TEXT,
      ditolak_oleh TEXT,
      ditolak_pada TIMESTAMP,
      alasan_tolak TEXT,
      UNIQUE (pending_id, versi)
    )
  `);
  await pastikanIndeks(db, 'CREATE INDEX IF NOT EXISTS idx_draft_jawaban_pending_status ON draft_jawaban_pending(pending_id, status)');
}

let sudah = null;
/** Panggil ensureSchema sekali per proses (dipakai rute bila init.js belum memasangnya). */
function pastikanSekali(db) {
  if (!sudah) {
    sudah = ensureSchema(db).catch((e) => { sudah = null; throw e; });
  }
  return sudah;
}

module.exports = { ensureSchema, pastikanSekali };
