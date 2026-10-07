const { pastikanIndeks, pastikanKolom } = require('../database/schemaIdempotent');
const { perbaruiRisikoTampilan } = require('./risikoKlaimTampilanService');
const SCHEMA = `ALTER TABLE claim_files ADD COLUMN IF NOT EXISTS is_testing BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS testing_pending (
  record_id TEXT PRIMARY KEY REFERENCES claim_records(id) ON DELETE CASCADE,
  hospital_code TEXT NOT NULL,
  prediction TEXT NOT NULL,
  prediction_snapshot JSONB NOT NULL,
  actual_result TEXT NOT NULL CHECK(actual_result IN ('pending','diterima','belum_diketahui')),
  reference_source TEXT NOT NULL CHECK(reference_source IN ('BPJS','VERIFIKATOR')),
  actual_reason TEXT NOT NULL DEFAULT '',
  reason_match TEXT NOT NULL CHECK(reason_match IN ('sesuai','sebagian','tidak_sesuai','belum_dinilai')),
  notes TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES users(id),
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_testing_pending_rs ON testing_pending(hospital_code);`;
async function ensureSchema(db) {
  await pastikanKolom(db,'claim_files',{is_testing:'BOOLEAN NOT NULL DEFAULT FALSE'});
  await db.query(SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE'), SCHEMA.indexOf('CREATE INDEX')));
  await pastikanIndeks(db,'CREATE INDEX IF NOT EXISTS idx_testing_pending_rs ON testing_pending(hospital_code)');
}

function prediksi(record, errors = []) {
  const review = perbaruiRisikoTampilan(record, errors);
  const putusan = review.putusan_pending;
  let status = 'belum_pasti';
  if (putusan?.status === 'berisiko_pending' || review.kesiapan_koding?.status === 'berisiko_pending'
    || (!putusan && record.validation_status === 'pending')) status = 'pending';
  else if (putusan?.status === 'tidak_ditemukan_alasan' && record.validation_status === 'valid') status = 'tidak_pending';
  return { status, alasan: putusan?.alasan || review.kesiapan_koding?.alasan || [],
    ringkasan: putusan?.ringkasan || (status === 'pending' ? 'Status klaim saat ini pending.' : 'Hasil aplikasi belum cukup untuk menentukan pending.'),
    validation_status: record.validation_status,
    diagnosa_list: record.diagnosa_list || '', prosedur_list: record.prosedur_list || '' };
}
function nilaiRingkasan(rows) {
  const n = { evaluated: 0, labeled: 0, uncertain: 0, correct: 0, true_pending: 0, true_clear: 0, missed_pending: 0, false_alarm: 0, reason_rated: 0, reason_exact: 0, reason_partial: 0 };
  for (const r of rows) {
    if (!['pending', 'diterima'].includes(r.actual_result)) continue;
    n.labeled++;
    if (!['pending', 'tidak_pending'].includes(r.prediction)) { n.uncertain++; continue; }
    n.evaluated++;
    if (r.prediction === 'pending' && r.actual_result === 'pending') {
      n.correct++; n.true_pending++;
      if (r.reason_match !== 'belum_dinilai') {
        n.reason_rated++;
        if (r.reason_match === 'sesuai') n.reason_exact++;
        if (r.reason_match === 'sebagian') n.reason_partial++;
      }
    } else if (r.prediction === 'tidak_pending' && r.actual_result === 'diterima') { n.correct++; n.true_clear++; }
    else if (r.actual_result === 'pending') n.missed_pending++;
    else n.false_alarm++;
  }
  return { ...n, accuracy: n.evaluated ? n.correct / n.evaluated * 100 : null,
    pending_recall: n.true_pending + n.missed_pending ? n.true_pending / (n.true_pending + n.missed_pending) * 100 : null,
    reason_accuracy: n.reason_rated ? n.reason_exact / n.reason_rated * 100 : null };
}
function validasiInput(body) {
  if (!body || !['pending','diterima','belum_diketahui'].includes(body.actual_result)
    || !['BPJS','VERIFIKATOR'].includes(body.reference_source)
    || !['sesuai','sebagian','tidak_sesuai','belum_dinilai'].includes(body.reason_match)) {
    const e = new Error('Pilih hasil acuan, sumber, dan kecocokan alasan yang valid.'); e.status = 400; throw e;
  }
  for (const key of ['actual_reason', 'notes']) {
    if (body[key] !== undefined && (typeof body[key] !== 'string' || body[key].length > 4000)) {
      const e = new Error('Alasan dan catatan maksimal 4.000 karakter.'); e.status = 400; throw e;
    }
  }
  return { ...body, reason_match: body.actual_result === 'pending' ? body.reason_match : 'belum_dinilai' };
}
module.exports = { SCHEMA, ensureSchema, prediksi, nilaiRingkasan, validasiInput };
