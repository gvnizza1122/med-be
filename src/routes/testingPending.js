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

router.post('/upload', (req, res, next) => {
  require('./claimFiles').pdfUpload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran PDF maksimal 20 MB.' : 'Pilih berkas PDF yang valid.' });
    next();
  });
}, async (req, res) => {
  let started = false;
  try {
    if (!req.file) return res.status(400).json({ error: 'Pilih PDF klaim untuk diuji.' });
    const label = validasiInput({ ...req.body, reason_match: 'belum_dinilai' });
    if (!['pending','diterima'].includes(label.actual_result))
      return res.status(400).json({ error: 'Pilih hasil yang sudah diketahui: ACC atau pending.' });
    const db = getDb();
    const storage = await aksesPenyimpanan(db);
    if (!storage.write || !storage.read) return res.status(503).json({ error: 'Penyimpanan testing belum tersedia.' });
    started = true;
    // Ground truth never enters extraction/review options or model messages.
    const result = await require('./claimFiles').processSinglePdfUpload(db, {
      filePath: req.file.path, originalName: req.file.originalname,
      jenisKlaim: undefined, allowedJenisKlaim: ['RAWAT_JALAN','RAWAT_INAP'], userId: req.user.id,
      hospitalCode: req.user.hospital_code, isTesting: true,
    });
    if (!result.success) return res.status(422).json({ error: result.error });
    try {
      const record = await db.get('SELECT * FROM claim_records WHERE id = ?', [result.record_id]);
      const errors = await db.all('SELECT * FROM validation_errors WHERE record_id = ?', [result.record_id]);
      const snapshot = prediksi(record, errors);
      await db.run(`INSERT INTO testing_pending(record_id,hospital_code,prediction,prediction_snapshot,
        actual_result,reference_source,actual_reason,reason_match,notes,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET
        actual_result=EXCLUDED.actual_result, reference_source=EXCLUDED.reference_source, actual_reason=EXCLUDED.actual_reason, notes=EXCLUDED.notes, updated_by=EXCLUDED.updated_by`,
        [record.id, req.user.hospital_code, snapshot.status, JSON.stringify(snapshot), label.actual_result,
          label.reference_source, label.actual_reason || '', 'belum_dinilai', label.notes || '', req.user.id]);
      res.json({ success: true, file_id: result.file_id, record_id: result.record_id, prediction: snapshot, label_saved: true });
    } catch (err) {
      console.error('[TestingPending] label upload gagal:', err.message);
      res.json({ success: true, file_id: result.file_id, record_id: result.record_id, label_saved: false,
        warning: 'PDF sudah dianalisis. Simpan hasil acuan melalui Edit penilaian di Testing Pending.' });
    }
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Upload testing belum berhasil. Periksa daftar testing sebelum mencoba ulang.' });
  } finally {
    if (!started && req.file?.path) require('fs').promises.unlink(req.file.path).catch(() => {});
  }
});

// Testing jobs use a separate queue/status channel; no operational socket broadcasts.
const jobs = new Map();
function expireJobs() {
  for (const [id, job] of jobs) if (!job.active && Date.now() - job.createdAt > 86400000) jobs.delete(id);
}
router.post('/upload-batch', (req, res, next) => {
  require('./claimFiles').pdfUploadBatch.array('files', 300)(req, res, err => {
    if (err) return res.status(400).json({ error: 'Pilih maksimal 300 PDF, masing-masing maksimal 20 MB.' });
    next();
  });
}, async (req, res) => {
  let queued = false;
  try {
    if (!req.files?.length) return res.status(400).json({ error: 'Pilih minimal satu PDF untuk testing.' });
    let categories;
    try { categories = JSON.parse(req.body.allowed_jenis_klaim); } catch { categories = []; }
    categories = ['RAWAT_JALAN','RAWAT_INAP'];
    const db = getDb();
    const storage = await aksesPenyimpanan(db);
    if (!storage.read || !storage.write) return res.status(503).json({ error: 'Penyimpanan testing belum tersedia.' });
    expireJobs();
    if ([...jobs.values()].some(j => j.active && j.hospitalCode === req.user.hospital_code))
      return res.status(409).json({ error: 'Masih ada batch testing berjalan untuk rumah sakit ini. Tunggu sampai selesai.' });
    const id = require('crypto').randomUUID();
    const job = { id, hospitalCode: req.user.hospital_code, createdAt: Date.now(), active: true,
      total: req.files.length, completed: 0, successful: 0, failed: 0,
      statuses: req.files.map(f => ({ fileName: f.originalname, status: 'waiting' })) };
    jobs.set(id, job); queued = true;
    const { processSinglePdfUpload, runWithConcurrencyLimit, BATCH_AI_CONCURRENCY } = require('./claimFiles');
    const files = req.files.map((file, index) => ({ file, index }));
    // Labels/notes from the request are deliberately ignored. Evaluation happens externally.
    runWithConcurrencyLimit(files, BATCH_AI_CONCURRENCY, async ({ file, index }) => {
      job.statuses[index].status = 'processing';
      let result;
      try {
        result = await processSinglePdfUpload(db, { filePath: file.path, originalName: file.originalname,
          jenisKlaim: undefined, allowedJenisKlaim: categories,
          userId: req.user.id, hospitalCode: req.user.hospital_code, isTesting: true });
      } catch { result = { success: false, error: 'Analisis belum berhasil.' }; }
      job.statuses[index] = { fileName: file.originalname, status: result.success ? 'done' : 'failed',
        error: result.error || null, file_id: result.file_id || null, jenisKlaim: result.jenis_klaim,
        detection: result.jenis_klaim_detection };
      job.completed++; if (result.success) job.successful++; else job.failed++;
    }).then(() => { job.active = false; }).catch(err => {
      console.error('[TestingPending] batch gagal:', err.message); job.active = false;
      job.error = 'Proses batch terputus. Periksa daftar Testing Pending sebelum mengunggah ulang.';
    });
    res.status(202).json({ job_id: id, total_files: job.total });
  } catch (err) {
    console.error('[TestingPending] antre gagal:', err.message);
    res.status(500).json({ error: 'Batch testing belum dapat dimulai.' });
  } finally {
    if (!queued) for (const file of req.files || []) require('fs').promises.unlink(file.path).catch(() => {});
  }
});
router.get('/jobs/:jobId', (req, res) => {
  expireJobs();
  const job = jobs.get(req.params.jobId);
  if (!job || job.hospitalCode !== req.user.hospital_code) return res.status(404).json({ error: 'Progres tidak tersedia. Periksa Testing Pending; jangan langsung upload ulang.' });
  const { hospitalCode, createdAt, ...visible } = job;
  res.json(visible);
});
router.get('/export', async (req, res) => {
  try {
    const db = getDb();
    const category = req.query.jenis_klaim;
    if (category && !['RAWAT_JALAN','RAWAT_INAP'].includes(category)) return res.status(400).json({ error: 'Kategori tidak valid.' });
    const rows = await db.all(`SELECT cr.*, cf.file_name, cf.created_at AS uploaded_at,
      t.prediction, t.prediction_snapshot, t.snapshot_at
      FROM claim_records cr JOIN claim_files cf ON cf.id=cr.file_id
      LEFT JOIN testing_pending t ON t.record_id=cr.id AND t.hospital_code=cf.hospital_code
      WHERE cf.is_testing=TRUE AND cf.hospital_code=? ${category ? 'AND cr.jenis_klaim=?' : ''}
      ORDER BY cf.created_at, cr.id`, category ? [req.user.hospital_code, category] : [req.user.hospital_code]);
    const errors = rows.length ? await db.all(`SELECT * FROM validation_errors WHERE record_id IN (${rows.map(() => '?').join(',')})`, rows.map(r => r.id)) : [];
    const parse = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
    res.json({ schema: 'eclaim-testing-export-v1', exported_at: new Date().toISOString(), total: rows.length,
      guidance: 'Bandingkan per SEP dengan catatan pending BPJS yang disediakan terpisah. Hasil ini adalah prediksi aplikasi, bukan keputusan BPJS. Jangan menebak hasil acuan yang tidak tersedia. Tandai kecocokan status, alasan, bukti pendukung, serta kasus yang belum pasti.',
      records: rows.map(r => ({ record_id: r.id, file_id: r.file_id, file_name: r.file_name,
        uploaded_at: r.uploaded_at, jenis_klaim: r.jenis_klaim, sep: r.sep, nama_pasien: r.nama_pasien,
        diagnosa_list: r.diagnosa_list, prosedur_list: r.prosedur_list,
        validation_status: r.validation_status, validation_errors: errors.filter(e => e.record_id === r.id),
        prediction: parse(r.prediction_snapshot) || prediksi(r, errors.filter(e => e.record_id === r.id)),
        snapshot_at: r.snapshot_at, extracted_claim: parse(r.raw_data), ai_review: parse(r.ai_review) })) });
  } catch (err) {
    console.error('[TestingPending] export gagal:', err.message);
    res.status(500).json({ error: 'Hasil testing belum dapat diekspor.' });
  }
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
    const where = `WHERE cf.is_testing = TRUE AND cf.hospital_code = ? AND COALESCE(cr.jenis_klaim,cf.jenis_klaim) = ?
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
        WHERE cf.is_testing = TRUE AND t.hospital_code = ? AND cf.hospital_code = ? AND COALESCE(cr.jenis_klaim,cf.jenis_klaim) = ?
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
      WHERE cr.id = ? AND cf.is_testing = TRUE AND cf.hospital_code = ?`, [req.params.recordId, req.user.hospital_code]);
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
