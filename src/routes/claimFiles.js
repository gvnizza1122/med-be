const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { parseClaimFile, normalizeColumnName } = require('../services/fileParser');
const { validateRecord, determineStatus } = require('../services/ruleEngine');
const { generateExcel } = require('../services/exportService');
const { logAudit } = require('../services/auditService');
const { validateRecordWithAI, runAiAudit, getTotalUsage, extractErrorFields, estimatePromptTokens, estimateCompletionTokens } = require('../services/aiValidationService');

const router = express.Router();

// OCR (tesseract.js) berat di CPU dan makan waktu tak terduga. Sebelumnya tiap
// panggilan ke /ocr-pages yang belum ada hasilnya langsung memicu proses baru
// dengan Promise.race + setTimeout — tapi setTimeout cuma membuat REQUEST-nya
// "gagal" duluan, proses tesseract di baliknya TETAP jalan tak bisa dibatalkan,
// dan hasilnya dibuang (tidak pernah disimpan). Akibatnya: tiap kali user buka
// ulang panel OCR (karena kelihatan gagal), proses baru menumpuk di atas yang
// lama tanpa henti — CPU 100%+ terus-menerus dan tidak pernah ada yang selesai.
// Map ini memastikan HANYA SATU proses OCR berjalan per record: request lain
// yang datang saat proses masih berjalan ikut menunggu proses YANG SAMA, dan
// hasilnya tetap disimpan ke DB begitu selesai — walau request HTTP asal yang
// memicunya sudah keburu timeout duluan di sisi client.
const ocrJobsInFlight = new Map(); // record_id -> Promise<ocrResult>

async function saveOcrResultsToDb(db, recordId, ocrResult) {
  if (!ocrResult.success || !ocrResult.pages || ocrResult.pages.length === 0) return;
  const insertOcrResult = db.prepare(`
    INSERT INTO ocr_results (id, record_id, page_number, ocr_text, confidence, block_count, processing_duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(record_id, page_number) DO UPDATE SET
      ocr_text = excluded.ocr_text,
      confidence = excluded.confidence,
      block_count = excluded.block_count,
      processing_duration_ms = excluded.processing_duration_ms
  `);
  for (const page of ocrResult.pages) {
    await insertOcrResult.run(
      uuidv4(), recordId, page.page_number,
      page.text || '', page.confidence || 0, page.block_count || 0,
      page.duration_ms || 0
    );
  }
}

// Jalankan (atau gabung ke) satu-satunya proses OCR aktif untuk record ini.
// Hasil SELALU disimpan ke DB begitu proses benar-benar selesai, terlepas dari
// apakah request HTTP yang memicunya masih menunggu atau sudah timeout duluan.
function runDedupedOcr(db, recordId, filePath, pageNumbers, ocrPdfPages) {
  let job = ocrJobsInFlight.get(recordId);
  if (!job) {
    job = ocrPdfPages(filePath, pageNumbers)
      .then(async (result) => {
        await saveOcrResultsToDb(db, recordId, result);
        return result;
      })
      .finally(() => ocrJobsInFlight.delete(recordId));
    ocrJobsInFlight.set(recordId, job);
  }
  return job;
}

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // path.basename meniadakan upaya traversal (..\ atau ../) lewat originalname.
    const uniqueName = `${Date.now()}-${uuidv4().substring(0, 8)}-${path.basename(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, 
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.txt', '.tsv', '.csv'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Hanya file TXT, TSV, atau CSV yang diperbolehkan.'));
    }
  }
});


router.post('/upload', authenticate, upload.single('file'), async (req, res) => {
  const io = req.app.get('io');
  let fileId = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File tidak ditemukan.' });
    }

    const db = getDb();
    const { period, description } = req.body;
    fileId = req.body.fileId || uuidv4();

    await db.prepare(`
      INSERT INTO claim_files (id, hospital_code, file_name, file_path, period, status, uploaded_by, description)
      VALUES (?, ?, ?, ?, ?, 'uploaded', ?, ?)
    `).run(fileId, req.user.hospital_code, req.file.originalname, req.file.path, period || null, req.user.id, description || null);

    if (io) io.emit('validation:status', { fileId, status: 'parsing', progress: 10, message: 'Membaca file...' });

    await db.prepare('UPDATE claim_files SET status = ? WHERE id = ?').run('parsing', fileId);
    const parseResult = parseClaimFile(req.file.path);

    if (parseResult.errors.length > 0 && parseResult.records.length === 0) {
      await db.prepare('UPDATE claim_files SET status = ?, error_message = ? WHERE id = ?')
        .run('error', parseResult.errors.map(e => e.message).join('; '), fileId);

      if (io) io.emit('validation:error', { fileId, errors: parseResult.errors });
      return res.status(400).json({ file_id: fileId, status: 'error', errors: parseResult.errors });
    }

    if (io) io.emit('validation:status', { fileId, status: 'validating', progress: 15, message: 'Memproses validasi aturan...' });

    const detectedPeriod = period || parseResult.metadata.period;
    await db.prepare("UPDATE claim_files SET status = ?, total_records = ?, period = ?, column_count = ?, parsed_at = datetime('now') WHERE id = ?")
      .run('validating', parseResult.records.length, detectedPeriod, parseResult.metadata.columnCount, fileId);

    const activeRules = await db.prepare('SELECT * FROM validation_rules WHERE is_active = 1').all();

    let validCount = 0;
    let errorCount = 0;
    let pendingCount = 0;

    await db.transaction(async (tx) => {
      const txInsertRecord = tx.prepare(`
        INSERT INTO claim_records (
          id, file_id, row_number, kode_rs, sep, nokartu, nama_pasien, mrn,
          birth_date, umur_tahun, umur_hari, gender, kelas_rawat, kelas_rs,
          admission_date, discharge_date, discharge_status, los,
          diagnosa_list, prosedur_list, inacbg_code, deskripsi_inacbg,
          tarif_inacbg, tarif_rs, total_tarif, tarif_poli_eks,
          icu_indikator, icu_los, vent_hour, birth_weight,
          dpjp_name, payor_id, coder_id, jenis_rawat,
          jenis_konsultasi, jumlah_episode_klaim, is_same_day,
          histori_obat_kronis_bulan_berturut, status_pasien, flag_rujuk_balik_prb,
          urutan_iterasi, jenis_klaim,
          validation_status, error_count, raw_data
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const txInsertError = tx.prepare(`
        INSERT INTO validation_errors (id, record_id, rule_id, field_name, error_message, expected_value, actual_value, severity)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (let idx = 0; idx < parseResult.records.length; idx++) {
        const record = parseResult.records[idx];
        const recordId = uuidv4();
        const errors = validateRecord(record, activeRules);
        const status = determineStatus(errors);

        if (status === 'valid') validCount++;
        else if (status === 'error') errorCount++;
        else pendingCount++;

        await txInsertRecord.run(
          recordId, fileId, record._rowNumber || idx + 1,
          record.kode_rs || '', record.sep || '', record.nokartu || '',
          record.nama_pasien || '', record.mrn || '',
          record.birth_date || null,
          record.umur_tahun || 0, record.umur_hari || 0,
          record.gender || '', record.kelas_rawat || 0, record.kelas_rs || '',
          record.admission_date || null, record.discharge_date || null,
          record.discharge_status || 0, record.los || 0,
          record.diagnosa_list || '', record.prosedur_list || '',
          record.inacbg_code || '', record.deskripsi_inacbg || '',
          record.tarif_inacbg || 0, record.tarif_rs || 0,
          record.total_tarif || 0, record.tarif_poli_eks || 0,
          record.icu_indikator || 0, record.icu_los || 0,
          record.vent_hour || 0, record.birth_weight || 0,
          record.dpjp_name || '', record.payor_id || '',
          record.coder_id || '', record.jenis_rawat || '',
          record.jenis_konsultasi || '', record.jumlah_episode_klaim || 1,
          record.is_same_day || 0, record.histori_obat_kronis_bulan_berturut || 0,
          record.status_pasien || 'STABIL', record.flag_rujuk_balik_prb || 0,
          record.urutan_iterasi || 0, record.jenis_klaim || 'RAWAT_INAP',
          status, errors.length, JSON.stringify(record._rawData || {})
        );

        // Insert errors
        for (const err of errors) {
          await txInsertError.run(
            uuidv4(), recordId, err.rule_id, err.field_name,
            err.error_message, err.expected_value || '', err.actual_value || '',
            err.severity
          );
        }

        // Progress updates every 50 records (range 15% - 30%)
        if (io && idx % 50 === 0) {
          const progress = 15 + Math.round((idx / parseResult.records.length) * 15);
          io.emit('validation:status', { fileId, status: 'validating', progress, message: `Menjalankan validasi aturan: ${idx}/${parseResult.records.length} rekor` });
        }
      }
    });

    // Run AI validation audit — ONLY error/pending records (skip valid to save tokens)
    if (io) io.emit('validation:status', { fileId, status: 'ai_auditing', progress: 30, message: 'Menghubungkan ke AI Auditor...' });

    const allRecords = await db.prepare('SELECT * FROM claim_records WHERE file_id = ? ORDER BY row_number ASC').all(fileId);
    
    // Mark valid records as AI-valid (skip AI audit to save tokens)
    const validRecords = allRecords.filter(r => r.validation_status === 'valid');
    const recordsToAudit = allRecords.filter(r => r.validation_status !== 'valid');

    // Auto-set AI status for valid records (no AI call needed)
    if (validRecords.length > 0) {
      const updateValidStmt = db.prepare("UPDATE claim_records SET ai_status = 'valid', ai_notes = 'Data valid - tidak ada masalah.' WHERE id = ?");
      for (const r of validRecords) {
        await updateValidStmt.run(r.id);
      }
    }

    if (recordsToAudit.length > 0) {
      const updateRecordStmt = db.prepare('UPDATE claim_records SET ai_status = ?, ai_notes = ?, ai_suggestions = ? WHERE id = ?');

      // ponytail: Extract error fields for field-specific audit (hemat token)
      const errors = await db.prepare('SELECT * FROM validation_errors WHERE record_id IN (SELECT id FROM claim_records WHERE file_id = ?)').all(fileId);
      const errorFieldsByRecord = extractErrorFields(recordsToAudit, [errors]);

      // Log token estimation
      const estimatedPrompt = estimatePromptTokens(recordsToAudit, errorFieldsByRecord);
      const estimatedCompletion = estimateCompletionTokens(recordsToAudit.length);
      console.log(`[AI Audit] Estimated tokens - Prompt: ${estimatedPrompt}, Completion: ${estimatedCompletion}, Total: ${estimatedPrompt + estimatedCompletion}`);
      console.log(`[AI Audit] Per-record avg: ~${Math.round((estimatedPrompt + estimatedCompletion) / recordsToAudit.length)} tokens`);

      const onBatchComplete = async (batchResults, completedCount) => {
        for (const res of batchResults) {
          try {
            await updateRecordStmt.run(res.ai_status, res.ai_notes, res.ai_suggestions || null, res.recordId);
          } catch (dbErr) {
            console.error(`Failed to update DB for record ${res.recordId}:`, dbErr);
          }
        }
        if (io) {
          const progress = 30 + Math.round((completedCount / recordsToAudit.length) * 65);
          io.emit('validation:status', { fileId, status: 'ai_auditing', progress, message: `AI Audit: ${completedCount}/${recordsToAudit.length} record` });
        }
      };

      await runAiAudit(recordsToAudit, onBatchComplete, errorFieldsByRecord);
    }

    // Save token usage
    const usage = getTotalUsage();
    if (usage.total_tokens > 0) {
      await db.prepare(`
        UPDATE claim_files SET ai_prompt_tokens = ?, ai_completion_tokens = ?, ai_total_tokens = ? WHERE id = ?
      `).run(usage.prompt_tokens, usage.completion_tokens, usage.total_tokens, fileId);
    }

    // Update file status to completed
    await db.prepare(`
      UPDATE claim_files
      SET status = 'completed', valid_count = ?, error_count = ?, pending_count = ?, validated_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(validCount, errorCount, pendingCount, fileId);

    // Cleanup uploaded file
    try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }

    // Audit log
    logAudit({
      userId: req.user.id,
      userEmail: req.user.email,
      action: 'upload_and_validate',
      resourceType: 'claim_file',
      resourceId: fileId,
      details: {
        fileName: req.file.originalname,
        totalRecords: parseResult.records.length,
        valid: validCount,
        error: errorCount,
        pending: pendingCount,
        columnCount: parseResult.metadata.columnCount
      },
      ipAddress: req.ip
    });

    if (io) {
      io.emit('validation:status', { fileId, status: 'completed', progress: 100, message: 'Validasi Selesai!' });
      io.emit('validation:complete', { fileId, summary: { valid: validCount, error: errorCount, pending: pendingCount } });
    }

    res.status(202).json({
      file_id: fileId,
      status: 'completed',
      message: 'File berhasil diproses',
      summary: {
        total_records: parseResult.records.length,
        valid: validCount,
        error: errorCount,
        pending: pendingCount
      }
    });
  } catch (err) {
    console.error('Upload error:', err);
    if (fileId) {
      try {
        const db = getDb();
        await db.prepare('UPDATE claim_files SET status = ?, error_message = ? WHERE id = ?')
          .run('error', err.message, fileId);
      } catch (e) { /* ignore */ }
    }
    res.status(500).json({ error: 'Gagal memproses file: ' + err.message });
  }
});

/**
 * GET /api/v1/claim-files
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { page = 1, limit = 20, status } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = 'WHERE 1=1';
    const params = [];

    if (status) {
      where += ' AND cf.status = ?';
      params.push(status);
    }

    const totalResult = await db.prepare(`SELECT COUNT(*) as count FROM claim_files cf ${where}`).get(...params);
    const total = Number(totalResult ? totalResult.count : 0);

    const filesRaw = await db.prepare(`
      SELECT cf.*, u.full_name as uploaded_by_name
      FROM claim_files cf
      LEFT JOIN users u ON cf.uploaded_by = u.id
      ${where}
      ORDER BY cf.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    const files = filesRaw.map(f => ({
      ...f,
      total_records: Number(f.total_records || 0),
      valid_count: Number(f.valid_count || 0),
      error_count: Number(f.error_count || 0),
      pending_count: Number(f.pending_count || 0),
      ai_prompt_tokens: Number(f.ai_prompt_tokens || 0),
      ai_completion_tokens: Number(f.ai_completion_tokens || 0),
      ai_total_tokens: Number(f.ai_total_tokens || 0)
    }));

    res.json({ total, page: parseInt(page), limit: parseInt(limit), files });
  } catch (err) {
    console.error('[claimFiles] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/claim-files/:id
 */
router.get('/:id', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const fileRaw = await db.prepare(`
      SELECT cf.*, u.full_name as uploaded_by_name, ua.full_name as approved_by_name
      FROM claim_files cf
      LEFT JOIN users u ON cf.uploaded_by = u.id
      LEFT JOIN users ua ON cf.approved_by = ua.id
      WHERE cf.id = ?
    `).get(req.params.id);

    if (!fileRaw) return res.status(404).json({ error: 'File tidak ditemukan.' });

    // PDF asli tersimpan & bisa disajikan ke halaman review (path valid, .pdf, ada di disk).
    const has_pdf = !!resolvePdfPath(fileRaw);

    const file = {
      ...fileRaw,
      has_pdf,
      total_records: Number(fileRaw.total_records || 0),
      valid_count: Number(fileRaw.valid_count || 0),
      error_count: Number(fileRaw.error_count || 0),
      pending_count: Number(fileRaw.pending_count || 0),
      ai_prompt_tokens: Number(fileRaw.ai_prompt_tokens || 0),
      ai_completion_tokens: Number(fileRaw.ai_completion_tokens || 0),
      ai_total_tokens: Number(fileRaw.ai_total_tokens || 0)
    };

    // Get error summary by rule
    const errorsByRuleRaw = await db.prepare(`
      SELECT ve.rule_id, vr.rule_name, ve.severity, COUNT(*) as count
      FROM validation_errors ve
      JOIN claim_records cr ON ve.record_id = cr.id
      JOIN validation_rules vr ON ve.rule_id = vr.id
      WHERE cr.file_id = ?
      GROUP BY ve.rule_id, vr.rule_name, ve.severity
      ORDER BY count DESC
    `).all(req.params.id);

    const errorsByRule = errorsByRuleRaw.map(e => ({
      ...e,
      count: Number(e.count)
    }));

    res.json({ ...file, error_summary: errorsByRule });
  } catch (err) {
    console.error('[claimFiles] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/claim-files/:id/records
 */
router.get('/:id/records', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { status = 'all', page = 1, limit = 50, search, error_type } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = 'WHERE cr.file_id = ?';
    const params = [req.params.id];

    if (status !== 'all') {
      where += ' AND cr.validation_status = ?';
      params.push(status);
    }

    if (search) {
      where += ' AND (cr.nama_pasien ILIKE ? OR cr.sep ILIKE ? OR cr.nokartu ILIKE ? OR cr.inacbg_code ILIKE ?)';
      const searchParam = `%${search}%`;
      params.push(searchParam, searchParam, searchParam, searchParam);
    }

    if (error_type) {
      where += ' AND cr.id IN (SELECT record_id FROM validation_errors WHERE rule_id = ?)';
      params.push(error_type);
    }

    const totalResult = await db.prepare(`SELECT COUNT(*) as count FROM claim_records cr ${where}`).get(...params);
    const total = Number(totalResult ? totalResult.count : 0);

    const records = await db.prepare(`
      SELECT cr.* FROM claim_records cr ${where}
      ORDER BY cr.row_number ASC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    // Attach errors to each record
    const getErrors = db.prepare(`
      SELECT ve.*, vr.rule_name FROM validation_errors ve
      JOIN validation_rules vr ON ve.rule_id = vr.id
      WHERE ve.record_id = ?
    `);

    const recordsWithErrors = [];
    for (const rec of records) {
      const errors = await getErrors.all(rec.id);
      recordsWithErrors.push({
        ...rec,
        errors
      });
    }

    res.json({ total, page: parseInt(page), limit: parseInt(limit), records: recordsWithErrors });
  } catch (err) {
    console.error('[claimFiles] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

// Helper to reconstruct fixed file content
async function getFixedFileContent(fileId, db) {
  const file = await db.prepare('SELECT * FROM claim_files WHERE id = ?').get(fileId);
  if (!file) throw new Error('File tidak ditemukan.');

  const records = await db.prepare('SELECT * FROM claim_records WHERE file_id = ? ORDER BY row_number ASC').all(fileId);
  if (records.length === 0) {
    throw new Error('Tidak ada rekor data untuk file ini.');
  }

  let headers = [];
  try {
    const firstRaw = JSON.parse(records[0].raw_data || '{}');
    headers = Object.keys(firstRaw);
  } catch (e) {
    headers = [
      'KODE_RS', 'KELAS_RS', 'KELAS_RAWAT', 'KODE_TARIF', 'PTD', 'ADMISSION_DATE', 'DISCHARGE_DATE',
      'BIRTH_DATE', 'BIRTH_WEIGHT', 'SEX', 'DISCHARGE_STATUS', 'DIAGLIST', 'PROCLIST', 'ADL1', 'ADL2',
      'IN_SP', 'IN_SR', 'IN_SI', 'IN_SD', 'INACBG', 'SUBACUTE', 'CHRONIC', 'SP', 'SR', 'SI', 'SD',
      'DESKRIPSI_INACBG', 'TARIF_INACBG', 'TARIF_SUBACUTE', 'TARIF_CHRONIC', 'DESKRIPSI_SP', 'TARIF_SP',
      'DESKRIPSI_SR', 'TARIF_SR', 'DESKRIPSI_SI', 'TARIF_SI', 'DESKRIPSI_SD', 'TARIF_SD', 'TOTAL_TARIF',
      'TARIF_RS', 'TARIF_POLI_EKS', 'LOS', 'ICU_INDIKATOR', 'ICU_LOS', 'VENT_HOUR', 'NAMA_PASIEN',
      'MRN', 'UMUR_TAHUN', 'UMUR_HARI', 'DPJP', 'SEP', 'NOKARTU', 'PAYOR_ID', 'CODER_ID', 'VERSI_INACBG',
      'VERSI_GROUPER', 'C1', 'C2', 'C3', 'C4'
    ];
  }

  const outputLines = [];
  outputLines.push(headers.join('\t'));

  records.forEach(rec => {
    let rawDataObj = {};
    try {
      rawDataObj = JSON.parse(rec.raw_data || '{}');
    } catch (e) { /* ignore */ }

    const sepKey = Object.keys(rawDataObj).find(k => normalizeColumnName(k) === 'sep') || 'SEP';
    rawDataObj[sepKey] = rec.sep;

    const nokartuKey = Object.keys(rawDataObj).find(k => normalizeColumnName(k) === 'nokartu') || 'NOKARTU';
    rawDataObj[nokartuKey] = rec.nokartu;

    const rowValues = headers.map(header => {
      const val = rawDataObj[header];
      return val !== undefined && val !== null ? val : '';
    });

    outputLines.push(rowValues.join('\t'));
  });

  const fileContent = outputLines.join('\r\n');
  const safeName = "PERBAIKAN_" + file.file_name.replace(/\.[^/.]+$/, "") + ".TXT";

  return { fileContent, fileName: safeName, file };
}

/**
 * POST /api/v1/claim-files/:id/approve
 */
router.post('/:id/approve', authenticate, authorize('supervisor', 'admin'), async (req, res) => {
  try {
    const db = getDb();
    const file = await db.prepare('SELECT * FROM claim_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'File tidak ditemukan.' });
    if (file.status !== 'completed') {
      return res.status(400).json({ error: 'File belum selesai divalidasi.' });
    }

    await db.prepare(`
      UPDATE claim_files SET status = 'approved', approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(req.user.id, req.params.id);

    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'approve', resourceType: 'claim_file', resourceId: req.params.id,
      ipAddress: req.ip
    });

    // Check if SIMRS Callback URL is configured
    const callbackUrl = process.env.SIMRS_CALLBACK_URL;
    let callbackStatus = 'not_configured';
    let callbackError = null;

    if (callbackUrl) {
      try {
        const { fileContent, fileName } = await getFixedFileContent(req.params.id, db);
        
        const formData = new FormData();
        const fileBlob = new Blob([fileContent], { type: 'text/plain' });
        formData.append('file', fileBlob, fileName);
        formData.append('file_id', req.params.id);
        formData.append('original_name', file.file_name);
        formData.append('records_count', String(file.total_records));

        const callbackHeaders = {};
        if (process.env.SIMRS_CALLBACK_API_KEY) {
          callbackHeaders['X-API-Key'] = process.env.SIMRS_CALLBACK_API_KEY;
        }

        const response = await fetch(callbackUrl, {
          method: 'POST',
          body: formData,
          headers: callbackHeaders
        });

        if (!response.ok) {
          throw new Error(`SIMRS returned status ${response.status}: ${await response.text().catch(() => '')}`);
        }

        callbackStatus = 'sent';
        logAudit({
          userId: req.user.id, userEmail: req.user.email,
          action: 'callback_success', resourceType: 'claim_file', resourceId: req.params.id,
          details: { callbackUrl, status: response.status },
          ipAddress: req.ip
        });
      } catch (callbackErr) {
        callbackStatus = 'failed';
        callbackError = callbackErr.message;
        console.error(`❌ Failed to send approved claim file callback to SIMRS:`, callbackErr);
        
        logAudit({
          userId: req.user.id, userEmail: req.user.email,
          action: 'callback_failure', resourceType: 'claim_file', resourceId: req.params.id,
          details: { callbackUrl, error: callbackErr.message },
          ipAddress: req.ip
        });
      }
    }

    res.json({ 
      file_id: req.params.id, 
      status: 'approved', 
      approved_at: new Date().toISOString(), 
      approved_by: req.user.id, 
      message: 'File disetujui, siap dikirim ke vClaim',
      callback_status: callbackStatus,
      callback_error: callbackError
    });
  } catch (err) {
    console.error('[claimFiles] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/claim-files/:id/export
 */
router.get('/:id/export', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const file = await db.prepare('SELECT * FROM claim_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'File tidak ditemukan.' });

    const { filter = 'error' } = req.query;

    const records = await db.prepare('SELECT * FROM claim_records WHERE file_id = ? ORDER BY row_number ASC').all(req.params.id);
    const getErrors = db.prepare('SELECT * FROM validation_errors WHERE record_id = ?');

    const recordsWithErrors = [];
    for (const rec of records) {
      const errors = await getErrors.all(rec.id);
      recordsWithErrors.push({
        ...rec,
        errors
      });
    }

    const buffer = generateExcel(recordsWithErrors, file, filter);

    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'export', resourceType: 'claim_file', resourceId: req.params.id,
      details: { format: 'excel', filter },
      ipAddress: req.ip
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=validasi_${file.file_name || 'klaim'}_${new Date().toISOString().split('T')[0]}.xlsx`);
    res.send(buffer);
  } catch (err) {
    console.error('[claimFiles] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * POST /api/v1/claim-files/:id/auto-fix
 * Automatically fix eligible errors (specifically lowercase SEP RV-01 and invalid NOKARTU format RV-02)
 * Keeps raw_data column strictly pristine as original reference point.
 */
router.post('/:id/auto-fix', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const fileId = req.params.id;
    const file = await db.prepare('SELECT * FROM claim_files WHERE id = ?').get(fileId);
    if (!file) return res.status(404).json({ error: 'File tidak ditemukan.' });

    const records = await db.prepare('SELECT * FROM claim_records WHERE file_id = ?').all(fileId);
    const activeRules = await db.prepare('SELECT * FROM validation_rules WHERE is_active = 1').all();

    let autoFixedCount = 0;
    let validCount = 0;
    let errorCount = 0;
    let pendingCount = 0;

    await db.transaction(async (tx) => {
      const updateRecordStmt = tx.prepare(`
        UPDATE claim_records 
        SET sep = ?, nokartu = ?, validation_status = ?, error_count = ?
        WHERE id = ?
      `);

      const deleteErrorsStmt = tx.prepare('DELETE FROM validation_errors WHERE record_id = ?');

      const insertErrorStmt = tx.prepare(`
        INSERT INTO validation_errors (id, record_id, rule_id, field_name, error_message, expected_value, actual_value, severity)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const updateFileStmt = tx.prepare(`
        UPDATE claim_files
        SET valid_count = ?, error_count = ?, pending_count = ?, updated_at = datetime('now')
        WHERE id = ?
      `);

      for (const rec of records) {
        let isModified = false;
        let updatedSep = rec.sep;
        let updatedNokartu = rec.nokartu;

        // Fix RV-01: Lowercase SEP
        if (rec.sep && rec.sep !== rec.sep.toUpperCase()) {
          updatedSep = rec.sep.toUpperCase();
          isModified = true;
        }

        // Fix RV-02: NOKARTU format with spaces/dashes
        if (rec.nokartu && !/^\d{13}$/.test(rec.nokartu)) {
          const cleaned = rec.nokartu.replace(/\D/g, '');
          if (cleaned.length === 13) {
            updatedNokartu = cleaned;
            isModified = true;
          }
        }

        let errors = [];
        let status = rec.validation_status;

        if (isModified) {
          autoFixedCount++;
          
          // Re-validate the record with fixed values
          const tempRecord = {
            ...rec,
            sep: updatedSep,
            nokartu: updatedNokartu,
            diagnosa_list: rec.diagnosa_list,
            prosedur_list: rec.prosedur_list,
            umur_tahun: rec.umur_tahun,
            admission_date: rec.admission_date,
            discharge_date: rec.discharge_date,
            nama_pasien: rec.nama_pasien,
            kelas_rawat: rec.kelas_rawat,
            discharge_status: rec.discharge_status,
            tarif_rs: rec.tarif_rs,
            total_tarif: rec.total_tarif
          };
          
          errors = validateRecord(tempRecord, activeRules);
          status = determineStatus(errors);

          // Update record
          await updateRecordStmt.run(updatedSep, updatedNokartu, status, errors.length, rec.id);

          // Delete old errors
          await deleteErrorsStmt.run(rec.id);

          // Insert new errors
          for (const err of errors) {
            await insertErrorStmt.run(
              uuidv4(), rec.id, err.rule_id, err.field_name,
              err.error_message, err.expected_value || '', err.actual_value || '',
              err.severity
            );
          }
        } else {
          // If not modified, just count the existing status
          status = rec.validation_status;
        }

        if (status === 'valid') validCount++;
        else if (status === 'error') errorCount++;
        else pendingCount++;
      }

      // Update the main claim file record
      await updateFileStmt.run(validCount, errorCount, pendingCount, fileId);
    });

    logAudit({
      userId: req.user.id,
      userEmail: req.user.email,
      action: 'auto_fix',
      resourceType: 'claim_file',
      resourceId: fileId,
      details: {
        autoFixedRecords: autoFixedCount,
        newValid: validCount,
        newError: errorCount,
        newPending: pendingCount
      },
      ipAddress: req.ip
    });

    res.json({
      message: `Auto-fix berhasil diterapkan pada ${autoFixedCount} rekor.`,
      auto_fixed_count: autoFixedCount,
      summary: {
        total_records: file.total_records,
        valid: validCount,
        error: errorCount,
        pending: pendingCount
      }
    });
  } catch (err) {
    console.error('[claimFiles] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/claim-files/:id/download-fixed
 * Reconstruct the original TSV file with all applied auto-fixes dynamically injected
 */
router.get('/:id/download-fixed', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const fileId = req.params.id;
    const file = await db.prepare('SELECT * FROM claim_files WHERE id = ?').get(fileId);
    if (!file) return res.status(404).json({ error: 'File tidak ditemukan.' });

    const records = await db.prepare('SELECT * FROM claim_records WHERE file_id = ? ORDER BY row_number ASC').all(fileId);
    if (records.length === 0) {
      return res.status(400).json({ error: 'Tidak ada rekor data untuk diunduh.' });
    }

    // Determine original column headers from the first record's raw_data keys
    let headers = [];
    try {
      const firstRaw = JSON.parse(records[0].raw_data || '{}');
      headers = Object.keys(firstRaw);
    } catch (e) {
      // Fallback standard 60-column headers if raw_data parsing fails
      headers = [
        'KODE_RS', 'KELAS_RS', 'KELAS_RAWAT', 'KODE_TARIF', 'PTD', 'ADMISSION_DATE', 'DISCHARGE_DATE',
        'BIRTH_DATE', 'BIRTH_WEIGHT', 'SEX', 'DISCHARGE_STATUS', 'DIAGLIST', 'PROCLIST', 'ADL1', 'ADL2',
        'IN_SP', 'IN_SR', 'IN_SI', 'IN_SD', 'INACBG', 'SUBACUTE', 'CHRONIC', 'SP', 'SR', 'SI', 'SD',
        'DESKRIPSI_INACBG', 'TARIF_INACBG', 'TARIF_SUBACUTE', 'TARIF_CHRONIC', 'DESKRIPSI_SP', 'TARIF_SP',
        'DESKRIPSI_SR', 'TARIF_SR', 'DESKRIPSI_SI', 'TARIF_SI', 'DESKRIPSI_SD', 'TARIF_SD', 'TOTAL_TARIF',
        'TARIF_RS', 'TARIF_POLI_EKS', 'LOS', 'ICU_INDIKATOR', 'ICU_LOS', 'VENT_HOUR', 'NAMA_PASIEN',
        'MRN', 'UMUR_TAHUN', 'UMUR_HARI', 'DPJP', 'SEP', 'NOKARTU', 'PAYOR_ID', 'CODER_ID', 'VERSI_INACBG',
        'VERSI_GROUPER', 'C1', 'C2', 'C3', 'C4'
      ];
    }

    // Generate output lines
    const outputLines = [];
    
    // Header line
    outputLines.push(headers.join('\t'));

    // Data lines
    records.forEach(rec => {
      let rawDataObj = {};
      try {
        rawDataObj = JSON.parse(rec.raw_data || '{}');
      } catch (e) { /* ignore */ }

      // DYNAMICALLY SUBSTITUTE CORRECTED DATABASE VALUES INTO TSV OUTPUT BEFORE GENERATION
      const sepKey = Object.keys(rawDataObj).find(k => normalizeColumnName(k) === 'sep') || 'SEP';
      rawDataObj[sepKey] = rec.sep;

      const nokartuKey = Object.keys(rawDataObj).find(k => normalizeColumnName(k) === 'nokartu') || 'NOKARTU';
      rawDataObj[nokartuKey] = rec.nokartu;

      const rowValues = headers.map(header => {
        const val = rawDataObj[header];
        return val !== undefined && val !== null ? val : '';
      });

      outputLines.push(rowValues.join('\t'));
    });

    const fileContent = outputLines.join('\r\n');
    
    logAudit({
      userId: req.user.id,
      userEmail: req.user.email,
      action: 'download_fixed',
      resourceType: 'claim_file',
      resourceId: fileId,
      details: { fileName: `fixed_${file.file_name}` },
      ipAddress: req.ip
    });

    // Make filename extremely clear that it is the fixed version
    const safeName = "PERBAIKAN_" + file.file_name.replace(/\.[^/.]+$/, "") + ".TXT";
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.send(fileContent);
  } catch (err) {
    console.error('[claimFiles] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/claim-files/:id/comparison
 * Compares pristine original values in raw_data with corrected columns in claim_records
 */
router.get('/:id/comparison', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const fileId = req.params.id;
    const file = await db.prepare('SELECT * FROM claim_files WHERE id = ?').get(fileId);
    if (!file) return res.status(404).json({ error: 'File tidak ditemukan.' });

    const records = await db.prepare('SELECT id, row_number, nama_pasien, mrn, sep, nokartu, raw_data FROM claim_records WHERE file_id = ? ORDER BY row_number ASC').all(fileId);

    const changes = [];

    records.forEach(rec => {
      let rawDataObj = {};
      try {
        rawDataObj = JSON.parse(rec.raw_data || '{}');
      } catch (e) { /* ignore */ }

      // Compare SEP
      const sepKey = Object.keys(rawDataObj).find(k => k.toUpperCase() === 'SEP' || k.toUpperCase() === 'NOSEP');
      const originalSep = sepKey ? rawDataObj[sepKey] : null;
      if (originalSep && rec.sep !== originalSep) {
        changes.push({
          row_number: rec.row_number,
          nama_pasien: rec.nama_pasien,
          mrn: rec.mrn,
          field_name: 'SEP',
          before: originalSep,
          after: rec.sep
        });
      }

      // Compare NOKARTU
      const nokartuKey = Object.keys(rawDataObj).find(k => k.toUpperCase() === 'NOKARTU' || k.toUpperCase() === 'NO_KARTU');
      const originalNokartu = nokartuKey ? rawDataObj[nokartuKey] : null;
      if (originalNokartu && rec.nokartu !== originalNokartu) {
        changes.push({
          row_number: rec.row_number,
          nama_pasien: rec.nama_pasien,
          mrn: rec.mrn,
          field_name: 'NOKARTU',
          before: originalNokartu,
          after: rec.nokartu
        });
      }
    });

    res.json({
      file_id: fileId,
      file_name: file.file_name,
      total_changes: changes.length,
      changes
    });
  } catch (err) {
    console.error('[claimFiles] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * POST /api/v1/claim-files/:id/ai-audit
 * Runs AI-assisted medical audit on all records of a claim file.
 */
router.post('/:id/ai-audit', authenticate, async (req, res) => {
  const io = req.app.get('io');
  const fileId = req.params.id;

  try {
    const db = getDb();
    const file = await db.prepare('SELECT * FROM claim_files WHERE id = ?').get(fileId);
    if (!file) {
      return res.status(404).json({ error: 'File tidak ditemukan.' });
    }

    // Get all records for this file
    const records = await db.prepare('SELECT * FROM claim_records WHERE file_id = ? ORDER BY row_number ASC').all(fileId);
    if (records.length === 0) {
      return res.status(400).json({ error: 'Tidak ada rekor data untuk diaudit.' });
    }

    // Emit start status
    if (io) io.emit('ai-audit:status', { fileId, status: 'auditing', progress: 0 });

    const updateRecordStmt = db.prepare('UPDATE claim_records SET ai_status = ?, ai_notes = ?, ai_suggestions = ? WHERE id = ?');

    // Callback to process and update each batch in real-time
    const onBatchComplete = async (batchResults, completedCount) => {
      for (const res of batchResults) {
        try {
          await updateRecordStmt.run(res.ai_status, res.ai_notes, res.ai_suggestions || null, res.recordId);
        } catch (dbErr) {
          console.error(`Failed to update DB for record ${res.recordId}:`, dbErr);
        }
      }

      // Emit progress updates
      if (io) {
        const progress = Math.round((completedCount / records.length) * 100);
        io.emit('ai-audit:status', { fileId, status: 'auditing', progress });
      }
    };

    // Run the batch-based audit (internally handles batch of 10 and rule fallback)
    await runAiAudit(records, onBatchComplete);

    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'ai_audit', resourceType: 'claim_file', resourceId: fileId,
      details: { totalRecords: records.length },
      ipAddress: req.ip
    });

    if (io) io.emit('ai-audit:complete', { fileId, totalRecords: records.length });

    res.json({
      message: `Audit AI berhasil diselesaikan untuk ${records.length} rekor.`,
      total_records: records.length
    });
  } catch (err) {
    console.error('AI Audit route error:', err);
    res.status(500).json({ error: 'Gagal menjalankan audit AI: ' + err.message });
  }
});

/**
 * DELETE /api/v1/claim-files/:id
 */
router.delete('/:id', authenticate, authorize('admin', 'supervisor'), async (req, res) => {
  try {
    const db = getDb();
    const file = await db.prepare('SELECT * FROM claim_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'File tidak ditemukan.' });

    await db.prepare('DELETE FROM claim_files WHERE id = ?').run(req.params.id);

    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'delete', resourceType: 'claim_file', resourceId: req.params.id,
      ipAddress: req.ip
    });

    res.json({ message: 'File berhasil dihapus.' });
  } catch (err) {
    console.error('[claimFiles] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/claim-files/:id/ai-token-estimate
 * Estimate AI token usage for a file's error records
 */
router.get('/:id/ai-token-estimate', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const fileId = req.params.id;

    const file = await db.prepare('SELECT * FROM claim_files WHERE id = ?').get(fileId);
    if (!file) return res.status(404).json({ error: 'File tidak ditemukan.' });

    const records = await db.prepare('SELECT * FROM claim_records WHERE file_id = ? AND validation_status != ?').all(fileId, 'valid');

    if (records.length === 0) {
      return res.json({
        file_id: fileId,
        total_records: file.total_records,
        records_to_audit: 0,
        estimated_tokens: {
          prompt: 0,
          completion: 0,
          total: 0
        },
        per_record_avg: 0,
        cost_estimate_usd: 0,
        note: 'Semua record valid - tidak perlu AI audit'
      });
    }

    // Get error fields for estimation
    const errors = await db.prepare(`
      SELECT record_id, field_name FROM validation_errors
      WHERE record_id IN (SELECT id FROM claim_records WHERE file_id = ?)
    `).all(fileId);

    const errorFieldsByRecord = {};
    errors.forEach(err => {
      if (!errorFieldsByRecord[err.record_id]) {
        errorFieldsByRecord[err.record_id] = [];
      }
      if (!errorFieldsByRecord[err.record_id].includes(err.field_name)) {
        errorFieldsByRecord[err.record_id].push(err.field_name);
      }
    });

    const estimatedPrompt = estimatePromptTokens(records, errorFieldsByRecord);
    const estimatedCompletion = estimateCompletionTokens(records.length);
    const totalEstimate = estimatedPrompt + estimatedCompletion;

    // DeepSeek pricing: $0.014 per 1M input tokens, $0.042 per 1M output tokens
    const costEstimate = (estimatedPrompt * 0.014 + estimatedCompletion * 0.042) / 1_000_000;

    res.json({
      file_id: fileId,
      total_records: Number(file.total_records),
      records_to_audit: records.length,
      estimated_tokens: {
        prompt: estimatedPrompt,
        completion: estimatedCompletion,
        total: totalEstimate
      },
      per_record_avg: Math.round(totalEstimate / records.length),
      cost_estimate_usd: costEstimate.toFixed(6),
      cost_estimate_rp: Math.round(costEstimate * 16500),
      provider: 'deepseek-v4-flash'
    });
  } catch (err) {
    console.error('[claimFiles] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

// PDF upload config — accept .pdf files
const pdfUpload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.pdf') cb(null, true);
    else cb(new Error('Hanya file PDF yang diperbolehkan.'));
  }
});

// Field validation helper — keys match vClaim field names sent by FE (extract page)
function validateField(fieldName, value) {
  const rules = {
    NOKARTU: v => /^\d{13}$/.test((v || '').replace(/\D/g, '')) || 'Harus 13 digit angka',
    SEP: v => /^0170[A-Z0-9]{20}$/.test((v || '').toUpperCase()) || 'Format SEP invalid (0170...)',
    NAMA_PASIEN: v => (v || '').trim().length > 2 || 'Minimal 3 karakter',
    BIRTH_DATE: v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') || 'Format: YYYY-MM-DD',
    ADMISSION_DATE: v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') || 'Format: YYYY-MM-DD',
    DISCHARGE_DATE: v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') || 'Format: YYYY-MM-DD',
    KELAS_RAWAT: v => ['1', '2', '3'].includes(String(v || '')) || 'Hanya 1, 2, atau 3',
    SEX: v => ['L', 'P', 'Laki-laki', 'Perempuan', '1', '2'].includes(v || '') || 'L/P atau 1/2',
    DISCHARGE_STATUS: v => ['1', '2', '3', '4', '5'].includes(String(v || '')) || 'Hanya 1-5',
  };

  if (rules[fieldName] && value) {
    const result = rules[fieldName](value);
    return result === true ? null : result;
  }
  return null;
}

/**
 * POST /api/v1/claim-files/upload-pdf
 * Upload PDF dari SIMRS, extract field digital, SAVE immediately, return untuk user review
 */
// vClaim pakai DD/MM/YYYY; kolom tanggal di DB pakai YYYY-MM-DD.
function vclaimDateToISO(v) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((v || '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Convert vClaim format (uppercase, vClaim field names) to database format (lowercase snake_case)
function vclaimToDbFormat(vclaimRecord) {
  const MAPPING = {
    'KODE_RS': 'kode_rs',
    'KELAS_RS': 'kelas_rs',
    'KELAS_RAWAT': 'kelas_rawat',
    'ADMISSION_DATE': 'admission_date',
    'DISCHARGE_DATE': 'discharge_date',
    'BIRTH_DATE': 'birth_date',
    'BIRTH_WEIGHT': 'birth_weight',
    'SEX': 'gender',
    'DISCHARGE_STATUS': 'discharge_status',
    'DIAGLIST': 'diagnosa_list',
    'PROCLIST': 'prosedur_list',
    'DESKRIPSI_INACBG': 'deskripsi_inacbg',
    'TARIF_INACBG': 'tarif_inacbg',
    'TARIF_RS': 'tarif_rs',
    'TARIF_POLI_EKS': 'tarif_poli_eks',
    'LOS': 'los',
    'ICU_INDIKATOR': 'icu_indikator',
    'ICU_LOS': 'icu_los',
    'VENT_HOUR': 'vent_hour',
    'NAMA_PASIEN': 'nama_pasien',
    'MRN': 'mrn',
    'UMUR_TAHUN': 'umur_tahun',
    'UMUR_HARI': 'umur_hari',
    'DPJP': 'dpjp_name',
    'SEP': 'sep',
    'NOKARTU': 'nokartu',
    'PAYOR_ID': 'payor_id',
    'CODER_ID': 'coder_id',
    'INACBG': 'inacbg_code',
    'TOTAL_TARIF': 'total_tarif',
    'KODE_TARIF': 'kode_tarif',
    'JENIS_RAWAT': 'jenis_rawat',
    'JENIS_KONSULTASI': 'jenis_konsultasi',
    'JUMLAH_EPISODE_KLAIM': 'jumlah_episode_klaim',
    'IS_SAME_DAY': 'is_same_day',
    'HISTORI_OBAT_KRONIS_BULAN_BERTURUT': 'histori_obat_kronis_bulan_berturut',
    'STATUS_PASIEN': 'status_pasien',
    'FLAG_RUJUK_BALIK_PRB': 'flag_rujuk_balik_prb',
    'URUTAN_ITERASI': 'urutan_iterasi',
    'JENIS_KLAIM': 'jenis_klaim',
  };

  const dbRecord = {};
  for (const [vclaimKey, dbKey] of Object.entries(MAPPING)) {
    const value = vclaimRecord[vclaimKey];
    if (value !== undefined && value !== null) {
      if (['admission_date', 'discharge_date', 'birth_date'].includes(dbKey)) {
        dbRecord[dbKey] = vclaimDateToISO(value);
      } else if (['kelas_rawat', 'discharge_status', 'umur_tahun', 'umur_hari', 'los', 'icu_indikator', 'icu_los', 'vent_hour', 'birth_weight'].includes(dbKey)) {
        const num = parseInt(value, 10);
        dbRecord[dbKey] = isNaN(num) ? null : num;
      } else if (['tarif_rs', 'tarif_inacbg', 'tarif_poli_eks', 'total_tarif'].includes(dbKey)) {
        const num = parseFloat(value);
        dbRecord[dbKey] = isNaN(num) ? null : num;
      } else {
        dbRecord[dbKey] = String(value).trim();
      }
    }
  }
  return dbRecord;
}

router.post('/upload-pdf', authenticate, pdfUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Belum ada berkas yang dipilih. Silakan pilih berkas PDF terlebih dahulu.' });
    }

    const { extractFromPDF } = require('../services/pdfExtractionPipeline');
    const result = await extractFromPDF(req.file.path);

    if (!result.success) {
      // Detail teknis hanya untuk log server, tidak dikirim ke pengguna.
      console.error('[upload-pdf] gagal:', req.file.originalname, JSON.stringify(result.errors));
      return res.status(400).json({ error: result.pesan });
    }

    const db = getDb();
    const fileId = uuidv4();
    const recordId = uuidv4();

    // Record vClaim lengkap 60 kolom (urutan & format sesuai output vClaim asli).
    const extractedData = result.record;

    // Convert vClaim format to database format for validation
    const dbRecord = vclaimToDbFormat(extractedData);

    // Run validation on extracted record
    const activeRules = await db.prepare('SELECT * FROM validation_rules WHERE is_active = 1').all();
    const validationErrors = validateRecord(dbRecord, activeRules);
    const validationStatus = determineStatus(validationErrors);

    // Save file record with status='uploaded' (data extraction complete)
    await db.prepare(`
      INSERT INTO claim_files (id, hospital_code, file_name, file_path, status, uploaded_by, total_records, description)
      VALUES (?, ?, ?, ?, 'uploaded', ?, 1, 'Extracted from PDF')
    `).run(fileId, req.user.hospital_code || '3371084', req.file.originalname, req.file.path, req.user.id);

    // Save extracted record with validation results using transaction
    await db.transaction(async (tx) => {
      const txInsertRecord = tx.prepare(`
        INSERT INTO claim_records (
          id, file_id, row_number, kode_rs, sep, nokartu, nama_pasien, mrn,
          birth_date, gender, kelas_rawat, admission_date, discharge_date,
          discharge_status, diagnosa_list, prosedur_list, dpjp_name,
          tarif_rs, jenis_klaim, validation_status, error_count, raw_data
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      await txInsertRecord.run(
        recordId, fileId, extractedData.KODE_RS, extractedData.SEP, extractedData.NOKARTU,
        extractedData.NAMA_PASIEN, extractedData.MRN,
        vclaimDateToISO(extractedData.BIRTH_DATE), extractedData.SEX,
        /^\d+$/.test(extractedData.KELAS_RAWAT) ? parseInt(extractedData.KELAS_RAWAT) : null,
        vclaimDateToISO(extractedData.ADMISSION_DATE), vclaimDateToISO(extractedData.DISCHARGE_DATE),
        /^\d+$/.test(extractedData.DISCHARGE_STATUS) ? parseInt(extractedData.DISCHARGE_STATUS) : 1,
        extractedData.DIAGLIST, extractedData.PROCLIST,
        extractedData.DPJP,
        /^\d+$/.test(extractedData.TARIF_RS) ? parseInt(extractedData.TARIF_RS) : null, 'RAWAT_INAP',
        validationStatus, validationErrors.length, JSON.stringify(extractedData)
      );

      // Save validation errors if any
      if (validationErrors.length > 0) {
        const txInsertError = tx.prepare(`
          INSERT INTO validation_errors (id, record_id, rule_id, field_name, error_message, expected_value, actual_value, severity)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const err of validationErrors) {
          await txInsertError.run(
            uuidv4(), recordId, err.rule_id, err.field_name,
            err.error_message, err.expected_value || '', err.actual_value || '',
            err.severity
          );
        }
      }
    });

    res.json({
      status: 'success',
      file_id: fileId,
      record_id: recordId,
      original_name: req.file.originalname,
      vclaimFormat: extractedData,
      validation_status: validationStatus,
      validation_errors: validationErrors,
      metadata: result.metadata,
    });
  } catch (err) {
    console.error('[upload-pdf] error tak terduga:', err);
    res.status(500).json({ error: 'Terjadi gangguan saat memproses berkas. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/claim-files/:file_id/extracted
 * Fetch extracted data dari database (untuk review halaman)
 */
router.get('/:file_id/extracted', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const record = await db.prepare(`
      SELECT * FROM claim_records WHERE file_id = ? ORDER BY row_number ASC LIMIT 1
    `).get(req.params.file_id);

    if (!record) {
      return res.status(404).json({ error: 'Record tidak ditemukan' });
    }

    // Parse raw_data jika ada
    const data = record.raw_data ? JSON.parse(record.raw_data) : record;
    res.json(data);
  } catch (err) {
    console.error('Fetch extracted error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

// Bantu validasi/penyajian PDF asli: kembalikan path absolut jika file valid
// (path-nya ada, ekstensi .pdf, dan benar-benar ada di disk), selain itu null.
function resolvePdfPath(file) {
  if (!file || !file.file_path) return null;
  const filePath = String(file.file_path);
  if (path.extname(filePath).toLowerCase() !== '.pdf') return null;
  if (!fs.existsSync(filePath)) return null;
  return path.resolve(process.cwd(), filePath);
}

/**
 * GET /api/v1/claim-files/:file_id/file
 * Sajikan file PDF asli yang di-upload agar bisa ditampilkan berdampingan
 * dengan data klaim yang sudah diekstrak di halaman review.
 */
router.get('/:file_id/file', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const file = await db.prepare(`
      SELECT * FROM claim_files WHERE id = ?
    `).get(req.params.file_id);

    if (!file) {
      return res.status(404).json({ error: 'File tidak ditemukan.' });
    }

    const pdfPath = resolvePdfPath(file);
    if (!pdfPath) {
      return res.status(404).json({ error: 'Dokumen PDF tidak ditemukan di sistem.' });
    }

    // Nama file asli dipakai di Content-Disposition — buang karakter kontrol dan
    // kutip supaya tidak bisa dipakai untuk injeksi header; fallback ke nama netral.
    let safeFileName = String(file.file_name || '').replace(/[\x00-\x1f\x7f"]+/g, '');
    if (!safeFileName) safeFileName = 'file.pdf';

    res.sendFile(pdfPath, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${safeFileName}"`
      }
    }, (err) => {
      // File bisa saja dihapus antara pengecekan dan pengiriman (TOCTOU) — tangani
      // dengan JSON 404 yang sama, bukan halaman error default Express.
      if (err && err.code === 'ENOENT') {
        if (!res.headersSent) {
          return res.status(404).json({ error: 'Dokumen PDF tidak ditemukan di sistem.' });
        }
      }
      if (err && !res.headersSent) {
        console.error('[claimFiles] error:', err);
        return res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
      }
    });
  } catch (err) {
    console.error('[claimFiles] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/claim-files/:record_id/validation-errors
 * Fetch validation errors untuk record (form verifikasi berbasis eksepsi)
 * Response format:
 * {
 *   validation_status: 'valid' | 'error' | 'pending',
 *   error_count: number,
 *   errors_by_field: {
 *     field_name: [
 *       { rule_id, error_message, expected_value, actual_value, severity }
 *     ]
 *   },
 *   all_errors: [...]
 * }
 */
router.get('/:record_id/validation-errors', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const record = await db.prepare(`
      SELECT id, validation_status, error_count FROM claim_records WHERE id = ?
    `).get(req.params.record_id);

    if (!record) {
      return res.status(404).json({ error: 'Record tidak ditemukan' });
    }

    // Fetch all validation errors for this record
    const errors = await db.prepare(`
      SELECT rule_id, field_name, error_message, expected_value, actual_value, severity
      FROM validation_errors
      WHERE record_id = ?
      ORDER BY severity DESC, field_name ASC
    `).all(req.params.record_id);

    // Group errors by field
    const errorsByField = {};
    errors.forEach(err => {
      if (!errorsByField[err.field_name]) {
        errorsByField[err.field_name] = [];
      }
      errorsByField[err.field_name].push({
        rule_id: err.rule_id,
        error_message: err.error_message,
        expected_value: err.expected_value,
        actual_value: err.actual_value,
        severity: err.severity
      });
    });

    res.json({
      validation_status: record.validation_status,
      error_count: record.error_count,
      errors_by_field: errorsByField,
      all_errors: errors
    });
  } catch (err) {
    console.error('Fetch validation errors:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * POST /api/v1/claim-files/:record_id/update-values
 * Simpan perubahan field dari form verifikasi, lalu validasi ulang.
 * Body: { updates: { NAMA_PASIEN: 'Baru', SEP: '...', ... } } — key = nama kolom vClaim (uppercase)
 */
router.post('/:record_id/update-values', authenticate, async (req, res) => {
  try {
    const { updates } = req.body;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ error: 'Data perubahan tidak valid.' });
    }

    const db = getDb();
    const existing = await db.prepare(`
      SELECT id, file_id, raw_data, kode_rs, sep, nokartu, nama_pasien, mrn,
        birth_date, gender, kelas_rawat, admission_date, discharge_date,
        discharge_status, diagnosa_list, prosedur_list, dpjp_name, tarif_rs
      FROM claim_records WHERE id = ?
    `).get(req.params.record_id);

    if (!existing) {
      return res.status(404).json({ error: 'Record tidak ditemukan' });
    }

    // raw_data adalah salinan PRISTINE dari upload asli (dipakai untuk perbandingan
    // auto-fix) — bukan status terkini record. Kolom-kolom yang punya field
    // tersendiri di claim_records (dpjp_name, dst.) bisa saja sudah dikoreksi
    // sejak upload dan tidak ada/berbeda di raw_data. Kalau merge langsung dari
    // raw_data, field yang tidak ikut di-edit verifikator bisa ke-null-kan.
    // Jadi: mulai dari raw_data (sumber untuk ~44 kolom yang cuma ada di JSON),
    // timpa dengan nilai kolom terkini punya field khusus, baru terapkan updates.
    // Tanggal SENGAJA tidak ikut ditimpa di sini: kolom DB menyimpannya dalam
    // format ISO (YYYY-MM-DD), sedangkan vclaimDateToISO() di bawah hanya
    // mengerti format vClaim asli (DD/MM/YYYY) dari raw_data — kalau ISO ikut
    // dioper ke sana hasilnya null dan tanggal malah hilang.
    const CURRENT_FIELD_KEY_MAP = {
      kode_rs: 'KODE_RS', sep: 'SEP', nokartu: 'NOKARTU', nama_pasien: 'NAMA_PASIEN', mrn: 'MRN',
      gender: 'SEX', kelas_rawat: 'KELAS_RAWAT', discharge_status: 'DISCHARGE_STATUS',
      diagnosa_list: 'DIAGLIST', prosedur_list: 'PROCLIST', dpjp_name: 'DPJP', tarif_rs: 'TARIF_RS',
    };
    const currentColumnValues = {};
    for (const [dbField, vclaimKey] of Object.entries(CURRENT_FIELD_KEY_MAP)) {
      if (existing[dbField] !== null && existing[dbField] !== undefined) {
        currentColumnValues[vclaimKey] = existing[dbField];
      }
    }

    const pristineData = existing.raw_data ? JSON.parse(existing.raw_data) : {};
    const mergedData = { ...pristineData, ...currentColumnValues, ...updates };

    // Convert ke format database, lalu validasi ulang dengan rule engine
    const dbRecord = vclaimToDbFormat(mergedData);
    const activeRules = await db.prepare('SELECT * FROM validation_rules WHERE is_active = 1').all();
    const validationErrors = validateRecord(dbRecord, activeRules);
    const validationStatus = determineStatus(validationErrors);

    await db.transaction(async (tx) => {
      const txUpdateRecord = tx.prepare(`
        UPDATE claim_records SET
          kode_rs = ?, sep = ?, nokartu = ?, nama_pasien = ?, mrn = ?,
          birth_date = ?, gender = ?, kelas_rawat = ?, admission_date = ?, discharge_date = ?,
          discharge_status = ?, diagnosa_list = ?, prosedur_list = ?, dpjp_name = ?,
          tarif_rs = ?, validation_status = ?, error_count = ?, raw_data = ?
        WHERE id = ?
      `);

      await txUpdateRecord.run(
        mergedData.KODE_RS, mergedData.SEP, mergedData.NOKARTU,
        mergedData.NAMA_PASIEN, mergedData.MRN,
        vclaimDateToISO(mergedData.BIRTH_DATE), mergedData.SEX,
        /^\d+$/.test(mergedData.KELAS_RAWAT) ? parseInt(mergedData.KELAS_RAWAT) : null,
        vclaimDateToISO(mergedData.ADMISSION_DATE), vclaimDateToISO(mergedData.DISCHARGE_DATE),
        /^\d+$/.test(mergedData.DISCHARGE_STATUS) ? parseInt(mergedData.DISCHARGE_STATUS) : 1,
        mergedData.DIAGLIST, mergedData.PROCLIST, mergedData.DPJP,
        /^\d+$/.test(mergedData.TARIF_RS) ? parseInt(mergedData.TARIF_RS) : null,
        validationStatus, validationErrors.length, JSON.stringify(mergedData),
        req.params.record_id
      );

      // Ganti seluruh validation_errors lama dengan hasil validasi baru
      await tx.prepare('DELETE FROM validation_errors WHERE record_id = ?').run(req.params.record_id);

      if (validationErrors.length > 0) {
        const txInsertError = tx.prepare(`
          INSERT INTO validation_errors (id, record_id, rule_id, field_name, error_message, expected_value, actual_value, severity)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const err of validationErrors) {
          await txInsertError.run(
            uuidv4(), req.params.record_id, err.rule_id, err.field_name,
            err.error_message, err.expected_value || '', err.actual_value || '',
            err.severity
          );
        }
      }
    });

    res.json({
      status: 'success',
      record_id: req.params.record_id,
      vclaimFormat: mergedData,
      validation_status: validationStatus,
      validation_errors: validationErrors,
    });
  } catch (err) {
    console.error('[update-values] error tak terduga:', err);
    res.status(500).json({ error: 'Terjadi gangguan saat menyimpan perubahan. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * POST /api/v1/claim-files/validate-pdf
 * Validate data dari PDF (after user review/input handwritten fields)
 * Body: { file_id, fields: { NOKARTU, NAMA_PASIEN, ... } }
 */
router.post('/validate-pdf', authenticate, async (req, res) => {
  try {
    const { file_id, fields } = req.body;
    if (!file_id || !fields) return res.status(400).json({ error: 'file_id dan fields wajib.' });

    const db = getDb();

    // Validate each field with rules
    const fieldErrors = [];
    for (const [key, value] of Object.entries(fields)) {
      const err = validateField(key, value);
      if (err) fieldErrors.push({ field: key, message: err });
    }

    // Map fields to record format
    const record = {
      kode_rs: fields.KODE_RS || '3371084',
      sep: (fields.SEP || '').toUpperCase(),
      nokartu: (fields.NOKARTU || '').replace(/\D/g, ''),
      nama_pasien: fields.NAMA_PASIEN || '',
      mrn: fields.MRN || '',
      birth_date: fields.BIRTH_DATE || '',
      admission_date: fields.ADMISSION_DATE || '',
      discharge_date: fields.DISCHARGE_DATE || '',
      kelas_rawat: fields.KELAS_RAWAT ? parseInt(fields.KELAS_RAWAT) : null, // Don't default - let validator catch empty
      discharge_status: fields.DISCHARGE_STATUS ? parseInt(fields.DISCHARGE_STATUS) : null, // Don't default - let validator catch empty
      diagnosa_list: fields.DIAGLIST || '',
      prosedur_list: fields.PROCLIST || '',
      dpjp_name: fields.DPJP || '',
      gender: fields.SEX || '', // Don't default - let validator catch empty
      tarif_rs: fields.TARIF_RS ? parseInt(fields.TARIF_RS) : null, // Allow NULL for optional
    };

    // Validate with rule engine
    const activeRules = await db.prepare('SELECT * FROM validation_rules WHERE is_active = 1').all();
    const ruleErrors = validateRecord(record, activeRules);
    const allErrors = [...fieldErrors.map(e => ({ ...e, rule_id: 'FIELD_VALIDATION' })), ...ruleErrors];
    const status = allErrors.length === 0 ? 'valid' : 'error';

    // Get existing record ID
    const existingRecord = await db.prepare('SELECT id FROM claim_records WHERE file_id = ?').get(file_id);
    const recordId = existingRecord?.id;

    if (!recordId) {
      return res.status(404).json({ error: 'Record tidak ditemukan, lakukan upload PDF terlebih dahulu.' });
    }

    // UPDATE existing record
    await db.prepare(`
      UPDATE claim_records SET
        sep = ?, nokartu = ?, nama_pasien = ?, mrn = ?,
        birth_date = ?, gender = ?, kelas_rawat = ?, admission_date = ?, discharge_date = ?,
        discharge_status = ?, diagnosa_list = ?, prosedur_list = ?, dpjp_name = ?,
        tarif_rs = ?, validation_status = ?, error_count = ?, raw_data = ?
      WHERE id = ?
    `).run(
      record.sep, record.nokartu, record.nama_pasien, record.mrn,
      record.birth_date, record.gender, record.kelas_rawat, record.admission_date, record.discharge_date,
      record.discharge_status, record.diagnosa_list, record.prosedur_list, record.dpjp_name,
      record.tarif_rs, status, allErrors.length, JSON.stringify(record),
      recordId
    );

    // Delete old errors & insert new
    await db.prepare('DELETE FROM validation_errors WHERE record_id = ?').run(recordId);
    for (const err of allErrors) {
      await db.prepare(`
        INSERT INTO validation_errors (id, record_id, rule_id, field_name, error_message, expected_value, actual_value, severity)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), recordId, err.rule_id || 'FIELD_VALIDATION', err.field || err.field_name,
        err.message || err.error_message, err.expected_value || '', err.actual_value || '', err.severity || 'major'
      );
    }

    // Update file status
    await db.prepare(`
      UPDATE claim_files SET status = ?, valid_count = ?, error_count = ?, validated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status === 'valid' ? 'completed' : 'error', status === 'valid' ? 1 : 0, allErrors.length, file_id);

    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'validate_pdf', resourceType: 'claim_file', resourceId: file_id,
      ipAddress: req.ip, details: { status, error_count: allErrors.length }
    });

    // ruleEngine reports lowercase DB column names — map back to vClaim field keys used by FE
    const FIELD_KEY_MAP = {
      sep: 'SEP', nokartu: 'NOKARTU', nama_pasien: 'NAMA_PASIEN', mrn: 'MRN',
      birth_date: 'BIRTH_DATE', gender: 'SEX', kelas_rawat: 'KELAS_RAWAT',
      admission_date: 'ADMISSION_DATE', discharge_date: 'DISCHARGE_DATE',
      discharge_status: 'DISCHARGE_STATUS', diagnosa_list: 'DIAGLIST',
      prosedur_list: 'PROCLIST', dpjp_name: 'DPJP', tarif_rs: 'TARIF_RS', kode_rs: 'KODE_RS',
    };
    res.json({
      file_id,
      record_id: recordId,
      status,
      error_count: allErrors.length,
      errors: allErrors.map(e => {
        const rawField = e.field_name || e.field || '';
        return {
          rule_id: e.rule_id || 'FIELD_VALIDATION',
          field_name: FIELD_KEY_MAP[rawField] || rawField,
          severity: e.severity || 'major',
          error_message: e.error_message || e.message,
          expected: e.expected_value || '', actual: e.actual_value || '',
        };
      }),
    });
  } catch (err) {
    console.error('PDF validate error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * POST /api/v1/claim-files/:record_id/ocr
 * Request OCR processing for a claim record
 * Body: { pageNumbers?: [1,2,3] }  // if empty, process all available pages
 */
router.post('/:record_id/ocr', authenticate, async (req, res) => {
  try {
    const { isAvailable, ocrPdfPages } = require('../services/ocrService');
    if (!isAvailable()) {
      return res.status(503).json({
        error: 'OCR service tidak tersedia. Silakan hubungi administrator.'
      });
    }

    const db = getDb();
    const { record_id } = req.params;
    const { pageNumbers } = req.body || {};

    // Verify record exists
    const record = await db.prepare(`
      SELECT f.*, c.id as record_id FROM claim_files f
      JOIN claim_records c ON c.file_id = f.id
      WHERE c.id = ?
    `).get(record_id);

    if (!record) {
      return res.status(404).json({ error: 'Record tidak ditemukan' });
    }

    // Check if file still exists
    if (!fs.existsSync(record.file_path)) {
      return res.status(400).json({ error: 'File PDF tidak ditemukan di sistem' });
    }

    // Request OCR — proses sesungguhnya di-dedupe per record_id (lihat
    // runDedupedOcr di atas), request ini cuma menunggu maksimal 2 menit lalu
    // menyerah kalau belum selesai; proses & penyimpanan hasilnya tetap lanjut.
    try {
      const ocrResult = await Promise.race([
        runDedupedOcr(db, record_id, record.file_path, pageNumbers || 'auto-scan', ocrPdfPages),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('OCR timeout')), 120000) // 2min max
        )
      ]);

      res.json({
        status: ocrResult.success ? 'completed' : 'error',
        record_id,
        pages_processed: ocrResult.pages?.length || 0,
        total_duration_ms: ocrResult.total_duration_ms,
        errors: ocrResult.errors || []
      });

    } catch (ocrErr) {
      console.error('[OCR] Processing failed:', ocrErr);
      res.status(500).json({
        error: 'Gagal memproses OCR. Silakan coba lagi.',
        details: process.env.NODE_ENV === 'development' ? ocrErr.message : undefined
      });
    }

  } catch (err) {
    console.error('[OCR] Unexpected error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi.' });
  }
});

/**
 * GET /api/v1/claim-files/:record_id/ocr-pages
 * Fetch OCR results for a record
 * AUTO-TRIGGERS OCR if no results exist yet (lazy evaluation)
 */
router.get('/:record_id/ocr-pages', authenticate, async (req, res) => {
  try {
    const { isAvailable, ocrPdfPages } = require('../services/ocrService');
    const db = getDb();
    const { record_id } = req.params;

    // Verify record exists and get file path
    const record = await db.prepare(`
      SELECT c.id as record_id, f.file_path
      FROM claim_records c
      JOIN claim_files f ON c.file_id = f.id
      WHERE c.id = ?
    `).get(record_id);

    if (!record) {
      return res.status(404).json({ error: 'Record tidak ditemukan' });
    }

    // Check if OCR results already exist
    let ocrResults = await db.prepare(`
      SELECT page_number, ocr_text, confidence, block_count, processing_duration_ms, created_at
      FROM ocr_results
      WHERE record_id = ?
      ORDER BY page_number ASC
    `).all(record_id);

    // If no results AND OCR service is available, auto-trigger OCR
    if (ocrResults.length === 0 && isAvailable()) {
      console.log(`[OCR-PAGES] Auto-triggering OCR for record ${record_id}`);

      if (!fs.existsSync(record.file_path)) {
        return res.status(400).json({ error: 'File PDF tidak ditemukan di sistem' });
      }

      try {
        const ocrResult = await Promise.race([
          runDedupedOcr(db, record_id, record.file_path, 'auto-scan', ocrPdfPages),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('OCR timeout')), 120000) // 2min max
          )
        ]);

        // runDedupedOcr sudah menyimpan hasilnya sendiri — cukup baca ulang kalau berhasil
        if (ocrResult.success && ocrResult.pages && ocrResult.pages.length > 0) {
          // Fetch newly saved results
          ocrResults = await db.prepare(`
            SELECT page_number, ocr_text, confidence, block_count, processing_duration_ms, created_at
            FROM ocr_results
            WHERE record_id = ?
            ORDER BY page_number ASC
          `).all(record_id);
        }

      } catch (ocrErr) {
        console.warn(`[OCR-PAGES] Auto-trigger failed: ${ocrErr.message}`);
        // Continue with empty results instead of failing
      }
    }

    res.json({
      record_id,
      page_count: ocrResults.length,
      pages: ocrResults.map(r => ({
        page_number: r.page_number,
        ocr_text: r.ocr_text,
        confidence: r.confidence,
        confidence_status: r.confidence >= 50 ? 'readable' : 'unclear',
        // 'readable': confidence >= 50% (likely correct, suitable for audit)
        // 'unclear': confidence < 50% (needs verification, typically handwritten)
        block_count: r.block_count,
        processing_duration_ms: r.processing_duration_ms,
        created_at: r.created_at
      }))
    });

  } catch (err) {
    console.error('[OCR-PAGES] Error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi.' });
  }
});

/**
 * Tahap 4 — Audit suggestions endpoint (AI semantic matching with anti-upcoding validation)
 * POST /api/v1/claim-files/:record_id/audit-suggestions
 *
 * Logic:
 * 1. Get record (DIAGLIST, PROCLIST)
 * 2. Get all OCR results for this record
 * 3. If no OCR → return available: false
 * 4. Call AI to match codes against OCR text
 * 5. Validate all quotations server-side
 * 6. Filter financial terms
 * 7. Return validated results
 */
router.post('/:record_id/audit-suggestions', authenticate, async (req, res) => {
  try {
    const { generateAuditSuggestions } = require('../services/auditSuggestionsService');
    const db = getDb();
    const { record_id } = req.params;

    // Get record with diagnosis and procedure codes + file_path (untuk baca halaman NATIVE)
    const record = await db.prepare(`
      SELECT c.id, c.diagnosa_list, c.prosedur_list, c.raw_data, f.file_path
      FROM claim_records c
      JOIN claim_files f ON c.file_id = f.id
      WHERE c.id = ?
    `).get(record_id);

    if (!record) {
      return res.status(404).json({ error: 'Record tidak ditemukan' });
    }

    // Get all OCR results (halaman SCAN) untuk record ini
    const ocrResults = await db.prepare(`
      SELECT page_number, ocr_text, confidence, block_count, processing_duration_ms
      FROM ocr_results
      WHERE record_id = ?
      ORDER BY page_number ASC
    `).all(record_id);

    // Sertakan juga halaman NATIVE (teks bersih, tanpa OCR, gratis) sebagai bukti —
    // sebelumnya cuma halaman SCAN yang dicek, padahal NATIVE bisa berisi bukti klinis
    // (resume medis, catatan, dll) yang sama validnya. Confidence 100 karena teks asli.
    let evidencePool = [...ocrResults];
    if (record.file_path && fs.existsSync(record.file_path)) {
      try {
        const { classifyPdfPages } = require('../services/pdfPageClassifier');
        const classified = await classifyPdfPages(record.file_path);
        if (classified.success) {
          const scanPageNumbers = new Set(ocrResults.map(o => o.page_number));
          // PENTING: kecualikan halaman "Berkas Klaim Individual" (has_claim_data) —
          // itu SUMBER ASLI ekstraksi DIAGLIST/PROCLIST (Tahap 1). Kalau ikut dimasukkan,
          // audit jadi sirkular (kode "terbukti" cuma karena tertulis di halaman asalnya
          // sendiri, bukan diverifikasi lewat dokumen klinis independen) — meniadakan
          // tujuan anti-upcoding. Hanya halaman NATIVE non-klaim (rekam medis, surat
          // keterangan, dst) yang boleh jadi bukti pendukung.
          const nativePages = classified.pages
            .filter(p => p.type === 'NATIVE' && !p.has_claim_data && !scanPageNumbers.has(p.page_num) && p.text_length > 0)
            .map(p => ({ page_number: p.page_num, ocr_text: p.text_full, confidence: 100 }));
          evidencePool = [...evidencePool, ...nativePages];
        }
      } catch (classifyErr) {
        console.warn('[AUDIT-SUGGESTIONS] Gagal ambil halaman NATIVE:', classifyErr.message);
      }
    }

    // Generate audit suggestions
    const suggestions = await generateAuditSuggestions(record, evidencePool);

    // Return to frontend
    res.json({
      record_id,
      available: suggestions.available,
      message: suggestions.message,
      claimed_evidence: suggestions.claimed_evidence || [],
      suggested_codes: suggestions.suggested_codes || [],
      tokens_used: suggestions.tokens_used,
      errors: suggestions.errors && suggestions.errors.length > 0 ? suggestions.errors : undefined,
    });

  } catch (err) {
    console.error('[AUDIT-SUGGESTIONS] Error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi.' });
  }
});

module.exports = router;
module.exports.vclaimToDbFormat = vclaimToDbFormat;
module.exports.vclaimDateToISO = vclaimDateToISO;
module.exports.resolvePdfPath = resolvePdfPath;
