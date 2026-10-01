const express = require('express');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { prediksi, nilaiRingkasan, validasiInput } = require('../services/testingPendingService');
const { tentukanPeriode, labelPeriode } = require('../services/periodeKlaimService');
const router = express.Router();
async function aksesPenyimpanan(db) {
  const izin = await db.get(`SELECT has_table_privilege(current_user, 'testing_pending', 'SELECT') AS can_read,
    has_table_privilege(current_user, 'testing_pending', 'INSERT') AND
    has_table_privilege(current_user, 'testing_pending', 'UPDATE') AS can_write`);
  return { read: izin?.can_read === true, write: izin?.can_write === true };
}
router.use(authenticate, authorize('admin', 'supervisor', 'verifikator'));
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user?.hospital_code) return res.status(403).json({ error: 'Rumah sakit akun belum ditentukan.' });
  next();
});

router.get('/', async (req, res) => {
  try {
    const { jenis_klaim = 'RAWAT_JALAN', search = '' } = req.query;
    if (!['RAWAT_JALAN', 'RAWAT_INAP'].includes(jenis_klaim) || typeof search !== 'string' || search.length > 200)
      return res.status(400).json({ error: 'Kategori atau pencarian tidak valid.' });
    const page = Math.max(1, Math.min(10000, parseInt(req.query.page, 10) || 1));
    const limit = 20;
    const includeArchived = req.query.include_arsip === '1';
    const db = getDb();
    const storage = await aksesPenyimpanan(db);
    const params = [req.user.hospital_code, jenis_klaim, `%${search}%`, `%${search}%`];
    const where = `WHERE cf.hospital_code = ? AND COALESCE(cr.jenis_klaim,cf.jenis_klaim) = ?
      AND (COALESCE(cr.nama_pasien,'') ILIKE ? OR COALESCE(cr.sep,'') ILIKE ?)
      ${includeArchived ? '' : 'AND cf.diarsipkan_pada IS NULL'}`;
    const join = 'FROM claim_records cr JOIN claim_files cf ON cf.id = cr.file_id';
    const evaluationColumns = ['prediction','prediction_snapshot','actual_result','reference_source','actual_reason','reason_match','notes','snapshot_at','updated_at']
      .map(k => storage.read ? `t.${k}` : `NULL AS ${k}`).join(', ');
    const [rows, count, evaluated] = await Promise.all([
      db.all(`SELECT cr.id, cr.file_id, cr.nama_pasien, cr.sep, cr.validation_status, cr.ai_review, cr.raw_data, cr.admission_date,
        cr.diagnosa_list, cr.prosedur_list, cf.file_name, cf.period, cf.diarsipkan_pada,
        ${evaluationColumns}
        ${join} ${storage.read ? 'LEFT JOIN testing_pending t ON t.record_id = cr.id AND t.hospital_code = cf.hospital_code' : ''}
        ${where} ORDER BY cr.created_at DESC, cr.id LIMIT ? OFFSET ?`, [...params, limit, (page-1)*limit]),
      db.get(`SELECT COUNT(*) AS total ${join} ${where}`, params),
      storage.read ? db.all(`SELECT t.prediction, t.actual_result, t.reference_source, t.reason_match
        FROM testing_pending t JOIN claim_records cr ON cr.id=t.record_id JOIN claim_files cf ON cf.id=cr.file_id
        WHERE t.hospital_code = ? AND cf.hospital_code = ? AND COALESCE(cr.jenis_klaim,cf.jenis_klaim) = ?
        ${includeArchived ? '' : 'AND cf.diarsipkan_pada IS NULL'}`,
      [req.user.hospital_code, req.user.hospital_code, jenis_klaim]) : Promise.resolve([]),
    ]);
    const errors = rows.length ? await db.all(`SELECT * FROM validation_errors WHERE record_id IN (${rows.map(() => '?').join(',')})`, rows.map(r => r.id)) : [];
    res.json({ page, limit, total: Number(count?.total || 0), jenis_klaim,
      testing_storage_available: storage.read && storage.write,
      // Ringkasan seluruh kategori terpilih; pencarian hanya menyaring daftar.
      summary: { BPJS: nilaiRingkasan(evaluated.filter(r => r.reference_source === 'BPJS')),
        VERIFIKATOR: nilaiRingkasan(evaluated.filter(r => r.reference_source === 'VERIFIKATOR')) },
      records: rows.map(r => ({ id: r.id, file_id: r.file_id, nama_pasien: r.nama_pasien, sep: r.sep, file_name: r.file_name,
        period: r.period || tentukanPeriode({ sep: r.sep, admissionDate: r.admission_date }).periode,
        period_label: labelPeriode(r.period || tentukanPeriode({ sep: r.sep, admissionDate: r.admission_date }).periode),
        archived: !!r.diarsipkan_pada,
        current_prediction: prediksi(r, errors.filter(e => e.record_id === r.id)),
        evaluation: r.actual_result ? { prediction: r.prediction, prediction_snapshot: r.prediction_snapshot,
          actual_result: r.actual_result, reference_source: r.reference_source, actual_reason: r.actual_reason,
          reason_match: r.reason_match, notes: r.notes, snapshot_at: r.snapshot_at, updated_at: r.updated_at } : null })),
    });
  } catch (err) {
    console.error('[TestingPending] baca gagal:', err.message);
    res.status(500).json({ error: 'Daftar testing belum dapat dimuat. Silakan coba lagi.' });
  }
});

router.put('/:recordId', async (req, res) => {
  try {
    const body = validasiInput(req.body);
    const db = getDb();
    const storage = await aksesPenyimpanan(db);
    if (!storage.read || !storage.write) return res.status(503).json({ error: 'Penyimpanan penilaian testing belum diaktifkan oleh administrator.' });
    const record = await db.get(`SELECT cr.* FROM claim_records cr JOIN claim_files cf ON cf.id=cr.file_id
      WHERE cr.id = ? AND cf.hospital_code = ?`, [req.params.recordId, req.user.hospital_code]);
    if (!record) return res.status(404).json({ error: 'Berkas tidak ditemukan.' });
    const errors = await db.all('SELECT * FROM validation_errors WHERE record_id = ?', [record.id]);
    const snapshot = prediksi(record, errors);
    const saved = await db.run(`INSERT INTO testing_pending(record_id,hospital_code,prediction,prediction_snapshot,actual_result,reference_source,actual_reason,reason_match,notes,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET
      actual_result=EXCLUDED.actual_result, reference_source=EXCLUDED.reference_source,
      actual_reason=EXCLUDED.actual_reason, reason_match=EXCLUDED.reason_match,
      notes=EXCLUDED.notes, updated_by=EXCLUDED.updated_by, updated_at=CURRENT_TIMESTAMP
      WHERE testing_pending.hospital_code=EXCLUDED.hospital_code`,
    [record.id, req.user.hospital_code, snapshot.status, JSON.stringify(snapshot), body.actual_result, body.reference_source,
      body.actual_reason || '', body.reason_match, body.notes || '', req.user.id]);
    if (saved.changes === 0) return res.status(409).json({ error: 'Penilaian sebelumnya memiliki kepemilikan berbeda. Hubungi administrator.' });
    res.json({ success: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[TestingPending] simpan gagal:', err.message);
    res.status(500).json({ error: 'Hasil testing belum tersimpan. Silakan coba lagi.' });
  }
});
module.exports = router;
