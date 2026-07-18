/**
 * SIMRS Ingestion Routes — Phase 2
 * POST /api/v1/simrs/ingest - JSON payload or PDF file upload
 */

const express = require('express');
const multer = require('multer');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');
const { ingestJsonRecords, ingestPdfFile, validateSimrsPayload } = require('../services/simrsIngestionService');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// Configure multer for file uploads (10MB limit, PDF only)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.pdf')) {
      return cb(new Error('Only PDF files are accepted.'));
    }
    cb(null, true);
  },
});

/**
 * POST /api/v1/simrs/ingest
 * Ingest medical records from SIMRS (JSON or PDF)
 *
 * Content-Type: application/json
 * Body: { records: [...] }
 *
 * OR
 *
 * Content-Type: multipart/form-data
 * Form field: file (PDF)
 */
router.post('/ingest', authenticate, upload.single('file'), async (req, res) => {
  let db;
  try {
    db = getDb();
    const hospitalCode = req.user?.hospital_code || '3371084';

    // Determine ingestion mode: JSON or PDF
    const isJsonMode = req.is('application/json') && req.body;
    const isPdfMode = req.file && req.file.mimetype === 'application/pdf';

    if (!isJsonMode && !isPdfMode) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Kirim JSON payload (Content-Type: application/json) atau file PDF (multipart/form-data).',
        details: {
          json_example: { records: [{ sep: '...', nokartu: '...' }] },
          pdf_example: 'POST with multipart file field named "file"',
        },
      });
    }

    // Mode 1: JSON Payload
    if (isJsonMode) {
      console.log('[SIMRS] Processing JSON payload');

      // Validate payload structure
      const validation = validateSimrsPayload(req.body);
      if (!validation.valid) {
        return res.status(400).json({
          error: 'Invalid payload',
          message: 'Payload tidak sesuai format SIMRS.',
          details: validation.errors,
        });
      }

      // Ingest records
      const result = await ingestJsonRecords(db, req.body.records, hospitalCode);

      // Log audit
      try {
        await db.prepare(`
          INSERT INTO audit_logs (id, user_id, user_email, action, resource_type, resource_id, details)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          uuidv4(),
          req.user?.id || null,
          req.user?.email || 'simrs-ingest',
          'SIMRS_INGEST_JSON',
          'claim_files',
          result.file_id,
          `Ingested ${result.inserted} records from SIMRS JSON payload`
        );
      } catch (auditErr) {
        console.warn(`[SIMRS] Audit log failed: ${auditErr.message}`);
      }

      return res.status(201).json({
        ok: result.failed === 0,
        message: `Berhasil menyimpan ${result.inserted} data klaim dari SIMRS.`,
        file_id: result.file_id,
        summary: result.summary,
        errors: result.errors.length > 0 ? result.errors : undefined,
      });
    }

    // Mode 2: PDF Upload
    if (isPdfMode) {
      console.log(`[SIMRS] Processing PDF upload: ${req.file.originalname}`);

      const result = await ingestPdfFile(db, req.file.buffer, req.file.originalname, hospitalCode);

      // Log audit
      try {
        await db.prepare(`
          INSERT INTO audit_logs (id, user_id, user_email, action, resource_type, resource_id, details)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          uuidv4(),
          req.user?.id || null,
          req.user?.email || 'simrs-ingest',
          'SIMRS_INGEST_PDF',
          'claim_files',
          result.file_id,
          `Ingested ${result.inserted} records from PDF: ${req.file.originalname}`
        );
      } catch (auditErr) {
        console.warn(`[SIMRS] Audit log failed: ${auditErr.message}`);
      }

      return res.status(201).json({
        ok: result.failed === 0,
        message: `File PDF diproses. ${result.inserted} data klaim berhasil disimpan.`,
        file_id: result.file_id,
        summary: result.summary,
        errors: result.errors.length > 0 ? result.errors : undefined,
      });
    }

  } catch (err) {
    console.error('[SIMRS Ingest] Error:', err);

    // Structured error response
    let statusCode = 500;
    let message = 'Gagal memproses ingestion SIMRS.';

    if (err.message.includes('PDF parsing failed')) statusCode = 400;
    if (err.message.includes('Only PDF files')) statusCode = 400;
    if (err.message.includes('No records extracted')) statusCode = 400;

    res.status(statusCode).json({
      error: 'Ingestion failed',
      message,
      details: err.message,
    });
  }
});

module.exports = router;
