/** RAG historis: sumber dan hasil eksplisit, relevansi sebelum confidence. */
const { v4: uuidv4 } = require('uuid');
const { createHash } = require('crypto');

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
function selectReferences(rows, context = {}, limit = 5) {
  const kind = jenis(context.jenis_klaim || context.JENIS_KLAIM);
  if (!kind) return [];
  const query = terms([context.alasanRaw, context.diagnosa_list, context.DIAGLIST, context.prosedur_list, context.PROCLIST,
    ...(context.validationErrors || []).map(e => e.error_message)].filter(Boolean).join(' '));
  const ownSep = context.sep || context.SEP;
  const ranked = rows.filter(r => r.verification_status === 'verified' && ['diterima', 'ditolak'].includes(normalizeOutcome(r.outcome))
    && jenis(r.jenis_klaim) === kind && !(ownSep && r.sep === ownSep)
    && !(context.pendingId && r.source_pending_id === context.pendingId))
    .map(r => {
      const words = terms(r.alasan_bpjs);
      const overlap = [...query].filter(w => words.has(w)).length;
      const categoryMatch = context.kategori_pending && context.kategori_pending !== 'lainnya' && r.kategori_pending === context.kategori_pending;
      return { ...r, outcome: normalizeOutcome(r.outcome), relevance_score: overlap + (categoryMatch ? 3 : 0),
        relevance_reason: categoryMatch ? 'Jenis klaim dan kategori masalah sama' : 'Jenis klaim sama dan istilah masalah beririsan' };
    }).filter(r => r.relevance_score > 0)
    .sort((a, b) => b.relevance_score - a.relevance_score || String(b.created_at).localeCompare(String(a.created_at)));
  const selected = [], seen = new Set();
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
async function getReferences(db, context = {}, limit = 5) {
  const kind = jenis(context.jenis_klaim || context.JENIS_KLAIM);
  if (!kind) return [];
  try {
    // Exact source version must still be the answer to which the recorded result applies.
    const rows = await db.prepare(`
      SELECT e.* FROM ai_training_examples e
      JOIN bpjs_pending_responses p ON p.id = e.source_pending_id
      WHERE e.verification_status = 'verified'
        AND e.outcome IN ('diterima', 'ditolak')
        AND p.outcome IN ('approved', 'rejected') AND p.outcome_verified_by IS NOT NULL
        AND ((p.outcome = 'approved' AND e.outcome = 'diterima') OR (p.outcome = 'rejected' AND e.outcome = 'ditolak'))
        AND e.draft_berhasil = COALESCE(NULLIF(p.draft_klarifikasi, ''), p.jawaban_rs_manual)
        AND e.jenis_klaim = ?
      ORDER BY e.created_at DESC LIMIT 300
    `).all(kind);
    return selectReferences(rows, context, limit);
  } catch (error) {
    console.warn('[RAG] Referensi terverifikasi belum tersedia:', error.message);
    return []; // schema lama tidak boleh membuka kembali contoh yang belum terverifikasi
  }
}
function formatReferences(examples = []) {
  return examples.filter(e => e.verification_status === 'verified' && ['diterima', 'ditolak'].includes(normalizeOutcome(e.outcome)))
    .map((e, i) => `Referensi ${i + 1} [id: ${e.id}; hasil: ${normalizeOutcome(e.outcome)}; asal: ${e.source_kind || 'tidak_diketahui'}; kategori: ${e.kategori_pending || 'lainnya'}]\nAlasan BPJS: ${String(e.alasan_bpjs || '').slice(0, 600)}\nJawaban pada kasus tersebut: ${String(e.draft_berhasil || '').slice(0, 900)}\nRelevansi: ${e.relevance_reason || 'periksa kesesuaian kasus'}`)
    .join('\n\n') || '(tidak ada referensi terverifikasi yang sesuai)';
}
async function saveReference(db, { pendingId, sourceKind, alasan, answer, category, points, confidence, jenisKlaim, sep }) {
  if (!pendingId || !alasan || !answer) return;
  // Save originals; model summary/confidence never certifies the BPJS outcome.
  await db.prepare(`INSERT INTO ai_training_examples
    (id, kategori_pending, alasan_bpjs, draft_berhasil, poin_kunci, outcome, generated_by, confidence_score,
     source_pending_id, source_kind, verification_status, jenis_klaim, sep, source_hash)
    VALUES (?, ?, ?, ?, ?, 'tidak_diketahui', 'rag-source-v2', ?, ?, ?, 'unverified', ?, ?, ?)
    ON CONFLICT (source_pending_id, source_kind, source_hash) DO UPDATE SET poin_kunci = COALESCE(EXCLUDED.poin_kunci, ai_training_examples.poin_kunci),
      confidence_score = COALESCE(EXCLUDED.confidence_score, ai_training_examples.confidence_score),
      kategori_pending = CASE WHEN ai_training_examples.kategori_pending = 'lainnya' THEN EXCLUDED.kategori_pending ELSE ai_training_examples.kategori_pending END`)
    .run(uuidv4(), category || 'lainnya', alasan, answer, points || null, confidence ?? null, pendingId, sourceKind, jenis(jenisKlaim), sep || null, createHash('sha256').update(JSON.stringify([alasan, answer])).digest('hex'));
}
async function syncOutcome(db, pendingId, verifiedBy = null) {
  // Revoking/changing an outcome or editing the answer invalidates older versions.
  await db.prepare(`UPDATE ai_training_examples e SET
    outcome = CASE WHEN e.draft_berhasil = COALESCE(NULLIF(p.draft_klarifikasi, ''), p.jawaban_rs_manual) AND p.outcome_verified_by IS NOT NULL AND p.outcome = 'approved' THEN 'diterima'
      WHEN e.draft_berhasil = COALESCE(NULLIF(p.draft_klarifikasi, ''), p.jawaban_rs_manual) AND p.outcome_verified_by IS NOT NULL AND p.outcome = 'rejected' THEN 'ditolak' ELSE 'tidak_diketahui' END,
    verification_status = CASE WHEN e.draft_berhasil = COALESCE(NULLIF(p.draft_klarifikasi, ''), p.jawaban_rs_manual) AND p.outcome IN ('approved', 'rejected') AND p.outcome_verified_by IS NOT NULL THEN 'verified' ELSE 'unverified' END,
    verified_at = CASE WHEN e.draft_berhasil = COALESCE(NULLIF(p.draft_klarifikasi, ''), p.jawaban_rs_manual) AND p.outcome IN ('approved', 'rejected') AND p.outcome_verified_by IS NOT NULL THEN p.outcome_verified_at ELSE NULL END,
    verified_by = CASE WHEN e.draft_berhasil = COALESCE(NULLIF(p.draft_klarifikasi, ''), p.jawaban_rs_manual) AND p.outcome IN ('approved', 'rejected') AND p.outcome_verified_by IS NOT NULL THEN COALESCE(?, p.outcome_verified_by, e.verified_by) ELSE NULL END
    FROM bpjs_pending_responses p WHERE p.id = ? AND e.source_pending_id = p.id`).run(verifiedBy, pendingId);
}
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
  return { outcome, draft: input.draft_klarifikasi !== undefined ? input.draft_klarifikasi : existing.draft_klarifikasi,
    status: outcome === 'approved' ? 'diterima' : outcome === 'rejected' ? 'ditolak'
      : input.status || (changed || input.outcome === null ? 'draft' : existing.status) };
}
module.exports = { nextPendingState, normalizeOutcome, jenis, selectReferences, getReferences, formatReferences, saveReference, syncOutcome };
