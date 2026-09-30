/**
 * Kotak regulasi — tempat staf MENGUNGGAH regulasi baru (Permenkes, Juknis,
 * BA Kesepakatan) untuk dibaca model dan dijadikan usulan rule.
 *
 * SIFAT KEAMANAN
 *  - Sengaja TIDAK ada pengambilan otomatis dari internet (tanpa scraping):
 *    satu-satunya jalan masuk adalah unggahan manusia. Modul ini tidak
 *    melakukan permintaan jaringan apa pun.
 *  - Status hanya bergerak maju dan dijaga di kode + UPDATE bersyarat status:
 *        diunggah -> dianalisis -> usulan_dibuat -> selesai
 *    (dianalisis -> selesai boleh bila analisis tidak menghasilkan usulan).
 *    Loncat status atau mundur ditolak.
 *  - Tidak ada gerbang persetujuan di sini: usulan yang dihasilkan tetap harus
 *    melalui ruleVersiService (di situlah koder menyetujui pengaktifan).
 *
 * Tabel dibuat lewat ensureSchema(db) (belum dipasang di init.js).
 */

const crypto = require('crypto');

const STATUS = Object.freeze(['diunggah', 'dianalisis', 'usulan_dibuat', 'selesai']);
const TRANSISI = Object.freeze({
  diunggah: ['dianalisis'],
  dianalisis: ['usulan_dibuat', 'selesai'],
  usulan_dibuat: ['selesai'],
  selesai: [],
});

async function ensureSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS kotak_regulasi (
      id TEXT PRIMARY KEY,
      judul TEXT NOT NULL CHECK (length(btrim(judul)) > 0),
      berlaku_mulai DATE,
      berkas TEXT NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'diunggah'
        CHECK (status IN ('diunggah','dianalisis','usulan_dibuat','selesai')),
      diunggah_pada TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function transisiSah(dari, ke) {
  return (TRANSISI[dari] || []).includes(ke);
}

async function unggah(db, { judul, berlaku_mulai = null, berkas }) {
  if (!judul || !String(judul).trim()) throw new Error('judul wajib diisi');
  if (!berkas || !String(berkas).trim()) throw new Error('berkas wajib diisi');
  let mulai = null;
  if (berlaku_mulai != null && berlaku_mulai !== '') {
    const s = String(berlaku_mulai).slice(0, 10);
    const d = new Date(`${s}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(d) || d.toISOString().slice(0, 10) !== s) {
      throw new Error('berlaku_mulai bukan tanggal valid (YYYY-MM-DD)');
    }
    mulai = s;
  }
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO kotak_regulasi (id, judul, berlaku_mulai, berkas, status)
     VALUES (?, ?, ?, ?, 'diunggah')`,
    [id, String(judul).trim(), mulai, String(berkas).trim()],
  );
  return { id, status: 'diunggah' };
}

async function ubahStatus(db, id, ke) {
  if (!STATUS.includes(ke)) throw new Error(`Status tidak dikenal: ${ke}`);
  const cur = await db.get('SELECT id, status FROM kotak_regulasi WHERE id = ?', [id]);
  if (!cur) throw new Error(`Regulasi ${id} tidak ditemukan`);
  if (!transisiSah(cur.status, ke)) {
    throw new Error(`Transisi status tidak sah: ${cur.status} -> ${ke}`);
  }
  const r = await db.run('UPDATE kotak_regulasi SET status = ? WHERE id = ? AND status = ?', [ke, id, cur.status]);
  if (!r || r.changes === 0) throw new Error('Status regulasi sudah berubah, muat ulang');
  return { id, dari: cur.status, status: ke };
}

async function daftar(db, { status } = {}) {
  if (status && !STATUS.includes(status)) throw new Error(`Status tidak dikenal: ${status}`);
  return status
    ? db.all('SELECT * FROM kotak_regulasi WHERE status = ? ORDER BY diunggah_pada DESC', [status])
    : db.all('SELECT * FROM kotak_regulasi ORDER BY diunggah_pada DESC', []);
}

module.exports = { STATUS, TRANSISI, ensureSchema, transisiSah, unggah, ubahStatus, daftar };
