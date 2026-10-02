/**
 * RAG jawaban pending BPJS: aplikasi BELAJAR DARI SETIAP KASUS pending, dengan
 * aman.
 *
 * Simpan: setiap versi jawaban (draf AI, jawaban yang diedit/dikirim petugas,
 * jawaban manual RS dari rekap) disimpan beserta sumbernya. Tidak ada kasus
 * yang terlewat.
 *
 * Pakai (tingkat kepercayaan, ditentukan saat dibaca dari data pending terkini):
 *  - terverifikasi : hasil BPJS (diterima/ditolak) dikonfirmasi petugas untuk
 *                    versi jawaban itu. "Ditolak" = peringatan, bukan pola sukses.
 *  - jawaban_rs    : jawaban yang benar-benar dikirim/ditulis RS, hasil BPJS
 *                    belum dikonfirmasi. Dipakai sebagai pola, berlabel jelas.
 *  - draf AI yang tidak pernah dikirim TIDAK PERNAH dipakai (mencegah AI belajar
 *    dari tebakannya sendiri).
 *
 * Tahan error: data disimpan di tabel BARU milik aplikasi (rag_referensi,
 * rag_konfirmasi_hasil) yang dibuat lazy -- tabel lama tidak di-ALTER, jadi
 * aman walau user DB bukan pemilik tabel lama. Bila tabel baru pun tidak bisa
 * dibuat, penyimpanan jatuh ke ai_training_examples (arsip, tetap terkumpul)
 * dan pembacaan mengembalikan [] -- tidak pernah contoh acak, tidak pernah
 * melempar ke pemanggil.
 */
const { v4: uuidv4 } = require('uuid');
const { createHash } = require('crypto');

const MIGRASI = `
CREATE TABLE IF NOT EXISTS rag_referensi (
  id TEXT PRIMARY KEY,
  source_pending_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_hash CHAR(64) NOT NULL,
  kategori_pending TEXT,
  alasan_bpjs TEXT NOT NULL,
  draft_berhasil TEXT NOT NULL,
  poin_kunci TEXT,
  confidence_score NUMERIC,
  jenis_klaim TEXT,
  sep TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_pending_id, source_kind, source_hash)
);
CREATE INDEX IF NOT EXISTS idx_rag_referensi_jenis ON rag_referensi(jenis_klaim, created_at DESC);
CREATE TABLE IF NOT EXISTS rag_konfirmasi_hasil (
  pending_id TEXT PRIMARY KEY,
  verified_by TEXT,
  verified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);`;
const TABEL_WAJIB = ['rag_referensi', 'rag_konfirmasi_hasil'];
const COBA_ULANG_MS = 5 * 60 * 1000;

let statusSkema = null; // { siap:boolean, waktu:number, janji?:Promise }

async function cekTabel(db) {
  const baris = await db.prepare(`SELECT table_name AS k FROM information_schema.tables
    WHERE table_name IN ('rag_referensi', 'rag_konfirmasi_hasil')`).all();
  const ada = new Set(baris.map(b => b.k));
  return TABEL_WAJIB.every(k => ada.has(k));
}

/** Pastikan tabel RAG ada. Tidak pernah melempar; hasil di-cache. */
async function pastikanSkemaRag(db) {
  if (!db || typeof db.prepare !== 'function') return false;
  if (statusSkema && statusSkema.janji) return statusSkema.janji;
  if (statusSkema && (statusSkema.siap || Date.now() - statusSkema.waktu < COBA_ULANG_MS)) return statusSkema.siap;
  const janji = (async () => {
    try {
      if (await cekTabel(db)) return true;
      if (typeof db.query === 'function') await db.query(MIGRASI);
      return await cekTabel(db);
    } catch (e) {
      console.warn('[RAG] Skema referensi belum dapat disiapkan (fitur tetap jalan dengan kolom lama):', e.message);
      return false;
    }
  })();
  statusSkema = { siap: false, waktu: Date.now(), janji };
  const siap = await janji;
  statusSkema = { siap, waktu: Date.now() };
  return siap;
}
function _resetSkema() { statusSkema = null; }

function normalizeOutcome(value) {
  return ({ approved: 'diterima', diterima: 'diterima', rejected: 'ditolak', ditolak: 'ditolak', revisi: 'revisi' })[value] || 'tidak_diketahui';
}
function jenis(value) {
  const v = String(value || '').toUpperCase();
  return ({ RJ: 'RAWAT_JALAN', RI: 'RAWAT_INAP' })[v] || (['RAWAT_JALAN', 'RAWAT_INAP'].includes(v) ? v : null);
}
const STOP = new Set('yang dan atau untuk dengan pada dari dalam pasien klaim bpjs rumah sakit mohon karena adalah sesuai perlu data dokumen konfirmasi'.split(' '));
function terms(value) {
  return new Set(String(value || '').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter(x => x.length > 2 && !STOP.has(x)) || []);
}
const sama = (a, b) => String(a || '').trim() === String(b || '').trim();

/**
 * Tingkat kepercayaan satu baris referensi, dari keadaan pending TERKINI
 * (kolom p_* hasil join). Jawaban yang sudah diedit setelah hasil
 * dikonfirmasi otomatis turun tingkat -- hasil melekat pada versi jawaban.
 */
function tingkatReferensi(r) {
  const jawabanKini = String(r.p_draft || '').trim() || String(r.p_manual || '').trim();
  if (['approved', 'rejected'].includes(r.p_outcome) && r.p_verified_by && sama(r.draft_berhasil, jawabanKini)) {
    return { verification_status: 'verified', outcome: normalizeOutcome(r.p_outcome) };
  }
  if ((r.source_kind === 'rs_manual' && sama(r.draft_berhasil, r.p_manual))
    || (['dikirim', 'diterima', 'ditolak'].includes(r.p_status) && sama(r.draft_berhasil, jawabanKini))) {
    return { verification_status: 'jawaban_rs', outcome: 'tidak_diketahui' };
  }
  return { verification_status: 'unverified', outcome: 'tidak_diketahui' };
}

function layak(r) {
  if (r.verification_status === 'verified') return ['diterima', 'ditolak'].includes(normalizeOutcome(r.outcome));
  return r.verification_status === 'jawaban_rs';
}

function selectReferences(rows, context = {}, limit = 5) {
  const kind = jenis(context.jenis_klaim || context.JENIS_KLAIM);
  if (!kind) return [];
  const query = terms([context.alasanRaw, context.diagnosa_list, context.DIAGLIST, context.prosedur_list, context.PROCLIST,
    ...(context.validationErrors || []).map(e => e.error_message)].filter(Boolean).join(' '));
  const ownSep = context.sep || context.SEP;
  const ranked = rows.filter(r => layak(r) && jenis(r.jenis_klaim) === kind && !(ownSep && r.sep === ownSep)
    && !(context.pendingId && r.source_pending_id === context.pendingId))
    .map(r => {
      const words = terms(r.alasan_bpjs);
      const overlap = [...query].filter(w => words.has(w)).length;
      const categoryMatch = context.kategori_pending && context.kategori_pending !== 'lainnya' && r.kategori_pending === context.kategori_pending;
      const dasar = overlap + (categoryMatch ? 3 : 0);
      return { ...r, outcome: normalizeOutcome(r.outcome), relevance_score: dasar ? dasar + (r.verification_status === 'verified' ? 1 : 0) : 0,
        relevance_reason: categoryMatch ? 'Jenis klaim dan kategori masalah sama' : 'Jenis klaim sama dan istilah masalah beririsan' };
    }).filter(r => r.relevance_score > 0)
    .sort((a, b) => b.relevance_score - a.relevance_score || String(b.created_at).localeCompare(String(a.created_at)));
  const selected = []; const seen = new Set();
  let chars = 0;
  for (const r of ranked) {
    const key = `${r.alasan_bpjs}|${r.draft_berhasil}|${r.outcome}`;
    if (seen.has(key)) continue;
    const entry = { ...r, alasan_bpjs: String(r.alasan_bpjs || '').slice(0, 600), draft_berhasil: String(r.draft_berhasil || '').slice(0, 900), poin_kunci: String(r.poin_kunci || '').slice(0, 300) };
    const size = formatReferences([entry]).length + (selected.length ? 2 : 0);
    if (chars + size > 6000) continue;
    selected.push(entry); seen.add(key); chars += size;
    if (selected.length >= Math.min(5, Math.max(1, limit))) break;
  }
  return selected;
}

/** Referensi relevan untuk konteks ini. Tidak pernah melempar; [] bila belum ada/skema lama. */
async function getReferences(db, context = {}, limit = 5) {
  const kind = jenis(context.jenis_klaim || context.JENIS_KLAIM);
  if (!kind || !(await pastikanSkemaRag(db))) return [];
  try {
    const rows = await db.prepare(`
      SELECT e.id, e.kategori_pending, e.alasan_bpjs, e.draft_berhasil, e.poin_kunci, e.created_at, e.source_pending_id,
             e.source_kind, e.jenis_klaim, e.sep,
             p.status AS p_status, p.outcome AS p_outcome, k.verified_by AS p_verified_by,
             p.draft_klarifikasi AS p_draft, p.jawaban_rs_manual AS p_manual
      FROM rag_referensi e
      JOIN bpjs_pending_responses p ON p.id = e.source_pending_id
      LEFT JOIN rag_konfirmasi_hasil k ON k.pending_id = p.id
      WHERE e.jenis_klaim = ?
      ORDER BY e.created_at DESC LIMIT 400
    `).all(kind);
    return selectReferences(rows.map(r => ({ ...r, ...tingkatReferensi(r) })), context, limit);
  } catch (error) {
    console.warn('[RAG] Referensi belum tersedia:', error.message);
    return [];
  }
}

const LABEL_TINGKAT = { verified: 'hasil BPJS dikonfirmasi petugas', jawaban_rs: 'jawaban yang dikirim RS, hasil BPJS belum dikonfirmasi' };
function formatReferences(examples = []) {
  return examples.filter(layak)
    .map((e, i) => {
      const hasil = e.verification_status === 'verified' ? normalizeOutcome(e.outcome) : 'belum_dikonfirmasi';
      return `Referensi ${i + 1} [id: ${e.id}; hasil: ${hasil}; tingkat: ${LABEL_TINGKAT[e.verification_status]}; asal: ${e.source_kind || 'tidak_diketahui'}; kategori: ${e.kategori_pending || 'lainnya'}]
Alasan BPJS: ${String(e.alasan_bpjs || '').slice(0, 600)}
Jawaban pada kasus tersebut: ${String(e.draft_berhasil || '').slice(0, 900)}${hasil === 'ditolak' ? '\nPERINGATAN: jawaban ini DITOLAK BPJS -- hindari pola ini.' : ''}
Relevansi: ${e.relevance_reason || 'periksa kesesuaian kasus'}`;
    })
    .join('\n\n') || '(tidak ada referensi yang sesuai)';
}

/**
 * Simpan satu versi jawaban sebagai bahan belajar. Tidak pernah melempar.
 * @returns {Promise<'tersimpan'|'tersimpan_kolom_lama'|'dilewati'|'gagal'>}
 */
async function saveReference(db, { pendingId, sourceKind, alasan, answer, category, points, confidence, jenisKlaim, sep }) {
  if (!db || !alasan || !String(answer || '').trim()) return 'dilewati';
  try {
    if (pendingId && await pastikanSkemaRag(db)) {
      const hash = createHash('sha256').update(JSON.stringify([alasan, String(answer).trim()])).digest('hex');
      // Hasil BPJS tidak disimpan di sini: tingkat kepercayaan dihitung saat dibaca.
      await db.prepare(`INSERT INTO rag_referensi
        (id, kategori_pending, alasan_bpjs, draft_berhasil, poin_kunci, confidence_score,
         source_pending_id, source_kind, jenis_klaim, sep, source_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (source_pending_id, source_kind, source_hash) DO UPDATE SET
          poin_kunci = COALESCE(EXCLUDED.poin_kunci, rag_referensi.poin_kunci),
          confidence_score = COALESCE(EXCLUDED.confidence_score, rag_referensi.confidence_score),
          kategori_pending = CASE WHEN COALESCE(rag_referensi.kategori_pending, 'lainnya') = 'lainnya' THEN EXCLUDED.kategori_pending ELSE rag_referensi.kategori_pending END`)
        .run(uuidv4(), category || 'lainnya', alasan, String(answer).trim(), points || null, confidence ?? null,
          pendingId, sourceKind || 'tidak_diketahui', jenis(jenisKlaim), sep || null, hash);
      return 'tersimpan';
    }
    // Tabel baru tidak tersedia / tanpa sumber pending: tetap diarsipkan agar tidak ada kasus yang hilang,
    // tetapi tidak pernah dipakai sebagai referensi (asal & hasilnya tidak dapat ditelusuri).
    await db.prepare(`INSERT INTO ai_training_examples (id, kategori_pending, alasan_bpjs, draft_berhasil, poin_kunci, outcome, generated_by, confidence_score)
      VALUES (?, ?, ?, ?, ?, 'tidak_diketahui', 'rag-source-v2-lama', ?)`)
      .run(uuidv4(), category || 'lainnya', alasan, String(answer).trim(), points || null, confidence ?? null);
    return 'tersimpan_kolom_lama';
  } catch (error) {
    console.warn('[RAG] Gagal menyimpan bahan belajar (diabaikan):', error.message);
    return 'gagal';
  }
}

/** Catat siapa yang mengonfirmasi hasil BPJS (atau hapus bila hasil dicabut/jawaban diubah). Tidak pernah melempar. */
async function catatKonfirmasiHasil(db, pendingId, { outcome, oleh }) {
  try {
    if (!(await pastikanSkemaRag(db))) return false;
    // Hasil dicabut / jawaban berubah -> konfirmasi lama dihapus.
    if (!outcome) {
      await db.prepare('DELETE FROM rag_konfirmasi_hasil WHERE pending_id = ?').run(pendingId);
      return true;
    }
    await db.prepare(`INSERT INTO rag_konfirmasi_hasil (pending_id, verified_by) VALUES (?, ?)
      ON CONFLICT (pending_id) DO UPDATE SET verified_by = EXCLUDED.verified_by, verified_at = CURRENT_TIMESTAMP`).run(pendingId, oleh || 'petugas');
    return true;
  } catch (error) {
    console.warn('[RAG] Gagal mencatat konfirmasi hasil (diabaikan):', error.message);
    return false;
  }
}

/** Status/outcome berikutnya; mengubah jawaban tanpa outcome baru membatalkan hasil lama. */
function nextPendingState(existing, input) {
  const changed = input.draft_klarifikasi !== undefined && input.draft_klarifikasi !== existing.draft_klarifikasi;
  const explicit = input.outcome !== undefined || ['diterima', 'ditolak'].includes(input.status);
  let outcome = input.outcome !== undefined ? input.outcome
    : input.status === 'diterima' ? 'approved' : input.status === 'ditolak' ? 'rejected' : changed ? null : existing.outcome;
  if ((input.status === 'diterima' && outcome !== 'approved') || (input.status === 'ditolak' && outcome !== 'rejected')
    || (['draft', 'dikirim'].includes(input.status) && ['approved', 'rejected'].includes(outcome) && explicit)) {
    return { error: 'Status dan hasil BPJS bertentangan.' };
  }
  if (['draft', 'dikirim'].includes(input.status) && !explicit) outcome = null;
  return { outcome, explicit, draft: input.draft_klarifikasi !== undefined ? input.draft_klarifikasi : existing.draft_klarifikasi,
    status: outcome === 'approved' ? 'diterima' : outcome === 'rejected' ? 'ditolak'
      : input.status || (changed || input.outcome === null ? 'draft' : existing.status) };
}

module.exports = {
  pastikanSkemaRag, _resetSkema, nextPendingState, normalizeOutcome, jenis, tingkatReferensi, selectReferences,
  getReferences, formatReferences, saveReference, catatKonfirmasiHasil,
};
