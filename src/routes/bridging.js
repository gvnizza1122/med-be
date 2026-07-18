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

module.exports = router;
