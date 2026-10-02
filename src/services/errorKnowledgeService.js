/**
 * Error Knowledge Base — basis pengetahuan pola error & solusi, dikelompokkan
 * per rule_id. Ini BUKAN riwayat percakapan/memory penuh — cuma pola yang
 * sudah digeneralisasi AI (tanpa data pasien) yang disimpan, dan hanya entri
 * untuk rule_id yang relevan dengan error record saat ini yang diikutkan ke
 * prompt AI berikutnya. Tujuannya: AI "belajar" dari histori tanpa membuat
 * konteks membengkak tak terbatas (lihat migrations/003-error-knowledge-base.sql).
 *
 * Growth control: per rule_id dibatasi MAX_ENTRIES_PER_RULE — entri baru
 * selalu di-insert (tidak dedupe by text, rawan gagal cocok karena AI selalu
 * beda kata-kata), lalu entri paling jarang dipakai & paling lama di-prune.
 * Race pruning antar record paralel bisa bikin jumlah entri sedikit melebihi
 * cap sesaat — bukan bug fatal, cuma soft-cap.
 */

const { v4: uuidv4 } = require('uuid');

const MAX_ENTRIES_PER_RULE = 8;
const ENTRIES_PER_RULE_IN_PROMPT = 3;

/**
 * Ambil entri pengetahuan yang relevan untuk sekumpulan rule_id (dipakai
 * sebagai referensi ringkas di prompt AI review).
 * @param {Object} db
 * @param {string[]} ruleIds
 * @returns {Promise<Array<{rule_id, field_name, pattern_summary, solution}>>}
 */
async function getRelevantKnowledge(db, ruleIds) {
  const uniqueRuleIds = [...new Set(ruleIds)].filter(Boolean);
  if (uniqueRuleIds.length === 0) return [];

  // Ambil top-N per rule_id (by hit_count) — query per rule_id sederhana
  // dan aman daripada window function lintas-driver, jumlah rule per record
  // biasanya kecil (<10) jadi tidak masalah query terpisah.
  const results = [];
  for (const ruleId of uniqueRuleIds) {
    const rows = await db.prepare(`
      SELECT rule_id, field_name, pattern_summary, solution
      FROM error_knowledge_base
      WHERE rule_id = ?
      ORDER BY hit_count DESC, created_at DESC
      LIMIT ?
    `).all(ruleId, ENTRIES_PER_RULE_IN_PROMPT);
    results.push(...rows);
  }
  return results;
}

/**
 * Simpan pola baru hasil generalisasi AI + prune entri berlebih per rule_id.
 * Dipanggil best-effort (non-blocking terhadap alur utama upload/review).
 * @param {Object} db
 * @param {Array<{rule_id, field_name, pattern_summary, solution}>} entries
 */
async function recordKnowledge(db, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;

  const affectedRuleIds = new Set();
  for (const entry of entries) {
    const { rule_id, field_name, pattern_summary, solution } = entry;
    if (!rule_id || !pattern_summary || !solution) continue;
    await db.prepare(`
      INSERT INTO error_knowledge_base (id, rule_id, field_name, pattern_summary, solution)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuidv4(), rule_id, field_name || null, pattern_summary.substring(0, 500), solution.substring(0, 500));
    affectedRuleIds.add(rule_id);
  }

  for (const ruleId of affectedRuleIds) {
    await db.prepare(`
      DELETE FROM error_knowledge_base
      WHERE rule_id = ? AND id NOT IN (
        SELECT id FROM error_knowledge_base
        WHERE rule_id = ?
        ORDER BY hit_count DESC, created_at DESC
        LIMIT ?
      )
    `).run(ruleId, ruleId, MAX_ENTRIES_PER_RULE);
  }
}

const BPJS_EXAMPLES_IN_PROMPT = 5;

/**
 * Ambil klarifikasi pending BPJS yang PERNAH terbukti diterima (RAG, lihat
 * routes/bpjsPending.js) untuk diselipkan ke prompt AI review klaim BARU —
 * supaya AI review proaktif mengenali pola yang sebelumnya bikin BPJS
 * mempending klaim (mis. kode tindakan tertentu, kriteria kegawatan) SEBELUM
 * klaim itu diajukan, bukan cuma reaktif setelah dipending.
 * @param {Object} db
 * @returns {Promise<Array<{kategori_pending, alasan_bpjs, draft_berhasil}>>}
 */
async function getRelevantBpjsExamples(db, context = {}) {
  // Referensi kasus pending sejenis (jenis klaim & istilah), berlabel tingkat
  // kepercayaannya. [] bila belum ada / skema lama -- tidak pernah melempar.
  return require('./ragReferenceService').getReferences(db, context, BPJS_EXAMPLES_IN_PROMPT);
}

module.exports = { getRelevantKnowledge, recordKnowledge, getRelevantBpjsExamples, MAX_ENTRIES_PER_RULE };
