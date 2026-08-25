const crypto = require('crypto');
const { getDb } = require('../database/init');

// Generate fingerprint untuk dedup: hash dari kategori + normalized alasan
function generateFingerprint(kategoriPending, alasanBpjs) {
  if (!kategoriPending || !alasanBpjs) return null;

  // Normalize: lowercase, trim, remove extra spaces
  const normalized = `${kategoriPending}|${alasanBpjs.toLowerCase().trim().replace(/\s+/g, ' ')}`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// Check apakah training example dengan fingerprint sama sudah ada
async function isDuplicate(fingerprint) {
  if (!fingerprint) return false;

  const db = getDb();
  const existing = await db.prepare(
    'SELECT id FROM ai_training_examples WHERE fingerprint = ? LIMIT 1'
  ).get(fingerprint);

  return !!existing;
}

// Check apakah pasien (SEP) sudah punya contoh untuk kategori + alasan yang sama
async function hasExampleForSepAndCategory(sep, kategoriPending, alasanBpjs) {
  if (!sep || !kategoriPending) return false;

  const db = getDb();
  const fingerprint = generateFingerprint(kategoriPending, alasanBpjs);

  const existing = await db.prepare(
    `SELECT id FROM ai_training_examples
     WHERE sep = ? AND fingerprint = ? LIMIT 1`
  ).get(sep, fingerprint);

  return !!existing;
}

// Find relevant training examples untuk RAG (few-shot learning)
// Filter by kategori_pending dan jenis_klaim untuk contextual relevance
async function findRelevantExamples(kategoriPending, jenisKlaim = null, limit = 5) {
  const db = getDb();

  let query = `
    SELECT kategori_pending, alasan_bpjs, draft_berhasil, poin_kunci
    FROM ai_training_examples
    WHERE kategori_pending = ? AND fingerprint IS NOT NULL
  `;
  const params = [kategoriPending];

  if (jenisKlaim) {
    query += ' AND jenis_klaim = ?';
    params.push(jenisKlaim);
  }

  query += ' ORDER BY ctime DESC LIMIT ?';
  params.push(limit);

  return db.prepare(query).all(...params);
}

// Get all pending records tanpa draft untuk auto-generate RAG
async function getPendingWithoutDraft(periodStartDate = null) {
  const db = getDb();

  let query = `
    SELECT id, sep, mrn, nama_peserta, kategori_pending, alasan_raw, alasan_parsed, jenis_klaim
    FROM bpjs_pending_responses
    WHERE draft_klarifikasi IS NULL OR draft_klarifikasi = ''
  `;
  const params = [];

  if (periodStartDate) {
    query += ' AND tanggal_pending >= ?';
    params.push(periodStartDate);
  }

  query += ' ORDER BY tanggal_pending DESC LIMIT 100';

  return db.prepare(query).all(...params);
}

// Find matching claim record untuk pending via SEP (untuk data enrichment)
async function findClaimBySep(sep) {
  if (!sep) return null;

  const db = getDb();
  return db.prepare(
    `SELECT id, kode_rs, nama_pasien, mrn, diagnosa_list, prosedur_list, jenis_klaim
     FROM claim_records
     WHERE sep = ? LIMIT 1`
  ).get(sep);
}

// Record training example dengan dedup check
async function recordTrainingExample(data) {
  const { kategoriPending, alasanBpjs, draftBerhasil, poinKunci, outcome, sep, jenisKlaim } = data;
  const db = getDb();
  const { v4: uuidv4 } = require('uuid');

  const fingerprint = generateFingerprint(kategoriPending, alasanBpjs);

  // Check dedup
  if (fingerprint && await isDuplicate(fingerprint)) {
    console.log(`[RAG] Skip duplicate: ${fingerprint}`);
    return null;
  }

  // Insert training example
  const id = uuidv4();
  await db.prepare(`
    INSERT INTO ai_training_examples (
      id, kategori_pending, alasan_bpjs, draft_berhasil, poin_kunci, outcome,
      fingerprint, sep, jenis_klaim, ctime
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    id, kategoriPending, alasanBpjs, draftBerhasil, poinKunci, outcome,
    fingerprint, sep, jenisKlaim
  );

  console.log(`[RAG] Recorded training example: ${id}`);
  return id;
}

module.exports = {
  generateFingerprint,
  isDuplicate,
  hasExampleForSepAndCategory,
  findRelevantExamples,
  getPendingWithoutDraft,
  findClaimBySep,
  recordTrainingExample,
};
