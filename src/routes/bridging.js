const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/init');
const { validateRecord, determineStatus } = require('../services/ruleEngine');
const { validateRecordWithAI } = require('../services/aiValidationService');
const { parseClaimFile } = require('../services/fileParser');

const router = express.Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const uniqueName = `bridge-${Date.now()}-${uuidv4().substring(0, 8)}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

const pdfUpload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.pdf') cb(null, true);
    else cb(new Error('Hanya file PDF yang diperbolehkan.'));
  }
});

const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const expectedApiKey = process.env.SIMRS_API_KEY || 'eclaim-simrs-secret-key-12345';
  
  if (!apiKey || apiKey !== expectedApiKey) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing X-API-Key header.' });
  }
  next();
};


router.post('/validate', authenticateApiKey, async (req, res) => {
  try {
    const record = req.body;
    
    if (!record || Object.keys(record).length === 0) {
      return res.status(400).json({ error: 'Request body is empty.' });
    }

    const db = getDb();
    const activeRules = await db.prepare('SELECT * FROM validation_rules WHERE is_active = 1').all();

    const ruleErrors = validateRecord(record, activeRules);
    const validationStatus = determineStatus(ruleErrors);

    const runAi = req.query.ai === 'true' || req.body.run_ai === true;
    let aiResult = null;

    if (runAi) {
      try {
        aiResult = await validateRecordWithAI(record);
      } catch (e) {
        console.error('AI audit error during bridging:', e);
        aiResult = {
          status: 'warning',
          reason: `Gagal audit AI: ${e.message}`,
          suggestion: 'Saran: Lakukan audit AI manual di dashboard.'
        };
      }
    }

    res.json({
      status: 'success',
      validation_status: validationStatus,
      rule_errors_count: ruleErrors.length,
      errors: ruleErrors.map(e => ({
        rule_id: e.rule_id,
        field_name: e.field_name,
        severity: e.severity,
        error_message: e.error_message,
        expected: e.expected_value,
        actual: e.actual_value
      })),
      ai_audit: aiResult ? {
        status: aiResult.status,
        reason: aiResult.reason,
        suggestion: aiResult.suggestion
      } : null
    });
  } catch (err) {
    console.error('Bridging validation error:', err);
    res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
});


router.post('/validate-file', authenticateApiKey, upload.single('file'), async (req, res) => {
  let tempFilePath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File tidak ditemukan. Kirim berkas TXT Anda pada key "file".' });
    }

    tempFilePath = req.file.path;

    const parseResult = parseClaimFile(tempFilePath);
    
    try { fs.unlinkSync(tempFilePath); tempFilePath = null; } catch (e) { /* ignore */ }

    if (parseResult.errors.length > 0 && parseResult.records.length === 0) {
      return res.status(400).json({ error: 'Gagal memproses file: ' + parseResult.errors.map(e => e.message).join('; ') });
    }

    const db = getDb();
    const activeRules = await db.prepare('SELECT * FROM validation_rules WHERE is_active = 1').all();

    const runAi = req.query.ai === 'true' || req.body.run_ai === 'true' || req.body.run_ai === true;
    const validatedRecords = [];

    for (let idx = 0; idx < parseResult.records.length; idx++) {
      const record = parseResult.records[idx];
      const errors = validateRecord(record, activeRules);
      const status = determineStatus(errors);

      let aiResult = null;
      if (runAi) {
        try {
          aiResult = await validateRecordWithAI(record);
        } catch (e) {
          console.error(`AI audit error on bridging record index ${idx}:`, e);
          aiResult = {
            status: 'warning',
            reason: `Gagal audit AI: ${e.message}`,
            suggestion: 'Saran: Lakukan audit AI manual di dashboard.'
          };
        }
      }

      validatedRecords.push({
        row_number: record._rowNumber || idx + 1,
        nama_pasien: record.nama_pasien || '',
        sep: record.sep || '',
        nokartu: record.nokartu || '',
        mrn: record.mrn || '',
        validation_status: status,
        errors: errors.map(e => ({
          rule_id: e.rule_id,
          field_name: e.field_name,
          severity: e.severity,
          error_message: e.error_message,
          expected: e.expected_value,
          actual: e.actual_value
        })),
        ai_audit: aiResult ? {
          status: aiResult.status,
          reason: aiResult.reason,
          suggestion: aiResult.suggestion
        } : null
      });
    }

    res.json({
      status: 'success',
      total_records: parseResult.records.length,
      errors_found: validatedRecords.some(r => r.validation_status === 'error'),
      records: validatedRecords
    });

  } catch (err) {
    console.error('File bridging validation error:', err);
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (e) { /* ignore */ }
    }
    res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
});

/**
 * POST /api/v1/bridging/upload-pdf
 * Terima PDF klaim langsung dari sistem SIMRS (bukan login manusia — pakai X-API-Key).
 * Pipeline SAMA PERSIS dengan upload manual di aplikasi (ekstraksi AI + validasi rule
 * engine RV-01–17), supaya hasilnya konsisten dan bisa langsung dilihat verifikator
 * di aplikasi eClaim (cari lewat Riwayat Upload, atau pakai record_id di response ini).
 *
 * Body: multipart/form-data, field "file" = berkas PDF (maks 20MB)
 * Header wajib: X-API-Key
 *
 * Response sukses (200):
 * {
 *   "status": "success",
 *   "file_id": "...",
 *   "record_id": "...",
 *   "validation_status": "valid" | "error" | "pending",
 *   "error_count": 0,
 *   "nama_pasien": "...",
 *   "sep": "...",
 *   "view_url": "https://<host-eclaim>/results/<file_id>"
 * }
 */
/**
 * Ekstrak + validasi + simpan 1 PDF ke database. Dipakai bersama oleh
 * /upload-pdf (single) dan /upload-pdf-batch, supaya logikanya satu tempat.
 * @returns {Promise<{success: true, ...}|{success: false, error: string}>}
 */
async function processSinglePdf(filePath, originalFilename, hospitalCode, publicHost) {
  const { extractFromPDF } = require('../services/pdfExtractionPipeline');
  const { vclaimToDbFormat, vclaimDateToISO } = require('./claimFiles');

  const result = await extractFromPDF(filePath);
  if (!result.success) {
    console.error('[bridging] ekstraksi gagal:', originalFilename, JSON.stringify(result.errors));
    return { success: false, filename: originalFilename, error: result.pesan };
  }

  const db = getDb();
  const fileId = uuidv4();
  const recordId = uuidv4();
  const extractedData = result.record;

  const dbRecord = vclaimToDbFormat(extractedData);
  const activeRules = await db.prepare('SELECT * FROM validation_rules WHERE is_active = 1').all();
  const validationErrors = validateRecord(dbRecord, activeRules);
  const validationStatus = determineStatus(validationErrors);

  await db.prepare(`
    INSERT INTO claim_files (id, hospital_code, file_name, file_path, status, uploaded_by, total_records, description)
    VALUES (?, ?, ?, ?, 'uploaded', NULL, 1, 'Diterima via SIMRS Bridging API')
  `).run(fileId, hospitalCode, originalFilename, filePath);

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

  return {
    success: true,
    filename: originalFilename,
    file_id: fileId,
    record_id: recordId,
    validation_status: validationStatus,
    error_count: validationErrors.length,
    nama_pasien: extractedData.NAMA_PASIEN,
    sep: extractedData.SEP,
    view_url: `${publicHost}/results/${fileId}`,
  };
}

function resolvePublicHost(req) {
  return process.env.ECLAIM_PUBLIC_URL || `${req.protocol}://${req.get('host').replace(/:\d+$/, ':60132')}`;
}

router.post('/upload-pdf', authenticateApiKey, pdfUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Berkas PDF tidak ditemukan. Kirim pada field "file".' });
    }

    const hospitalCode = req.body.hospital_code || process.env.SIMRS_DEFAULT_HOSPITAL_CODE || '3371084';
    const result = await processSinglePdf(req.file.path, req.file.originalname, hospitalCode, resolvePublicHost(req));

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    const { filename, ...body } = result;
    res.json({ status: 'success', ...body });
  } catch (err) {
    console.error('[bridging/upload-pdf] error tak terduga:', err);
    res.status(500).json({ error: 'Terjadi gangguan saat memproses berkas di sisi eClaim. Coba lagi, atau hubungi tim eClaim bila terus berulang.' });
  }
});

/**
 * POST /api/v1/bridging/upload-pdf-batch
 * Sama seperti /upload-pdf, tapi terima beberapa berkas sekaligus (field "files").
 * Diproses satu per satu secara berurutan dalam request yang sama (bukan antrian
 * background) — respons baru dikirim setelah SEMUA berkas selesai. Maksimal 10
 * berkas per panggilan supaya waktu tunggu tetap wajar (lihat dokumentasi untuk
 * estimasi waktu & saran timeout client).
 */
router.post('/upload-pdf-batch', authenticateApiKey, pdfUpload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Tidak ada berkas ditemukan. Kirim pada field "files" (bisa lebih dari satu).' });
    }

    const hospitalCode = req.body.hospital_code || process.env.SIMRS_DEFAULT_HOSPITAL_CODE || '3371084';
    const publicHost = resolvePublicHost(req);
    const results = [];

    for (const file of req.files) {
      try {
        const result = await processSinglePdf(file.path, file.originalname, hospitalCode, publicHost);
        const { success, ...rest } = result;
        results.push(success
          ? { status: 'success', ...rest }
          : { status: 'error', filename: file.originalname, error: result.error });
      } catch (fileErr) {
        console.error('[bridging/upload-pdf-batch] gagal di file:', file.originalname, fileErr);
        results.push({
          filename: file.originalname,
          status: 'error',
          error: 'Terjadi gangguan saat memproses berkas ini. Coba kirim ulang berkas ini secara terpisah.',
        });
      }
    }

    const successCount = results.filter(r => r.status === 'success').length;

    res.json({
      status: 'success',
      total: results.length,
      successful: successCount,
      failed: results.length - successCount,
      results,
    });
  } catch (err) {
    console.error('[bridging/upload-pdf-batch] error tak terduga:', err);
    res.status(500).json({ error: 'Terjadi gangguan saat memproses batch di sisi eClaim. Coba lagi, atau hubungi tim eClaim bila terus berulang.' });
  }
});

module.exports = router;
