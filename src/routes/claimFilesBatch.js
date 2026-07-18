const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { createBatch, queueBatch, startBatch, getBatchStatus } = require('../services/queueService');

const router = express.Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads/batch';
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer setup untuk batch upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${uuidv4().substring(0, 8)}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const uploadBatch = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB per file
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.pdf', '.txt', '.tsv', '.csv'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Hanya file PDF, TXT, TSV, atau CSV yang diperbolehkan.'));
    }
  }
});

/**
 * POST /api/v1/claim-files/upload-batch
 * Receive multiple files, queue them, and return immediately with batch_id
 * Response: 202 Accepted (dalam < 1 detik)
 */
router.post(
  '/upload-batch',
  authenticate,
  authorize('admin', 'supervisor', 'verifikator'),
  uploadBatch.array('files', 200), // Max 200 files per batch
  async (req, res) => {
    const db = getDb();
    const startTime = Date.now();

    try {
      // Validate files
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Tidak ada file yang diunggah.' });
      }

      if (req.files.length > 200) {
        return res.status(400).json({ error: 'Maksimal 200 file per batch.' });
      }

      // Step 1: Create batch record (SYNC)
      const batchId = await createBatch(
        req.user.hospital_code,
        req.user.id,
        req.files.length,
        req.body.notes || null
      );

      // Step 2: Prepare file metadata (SYNC)
      const fileList = [];
      const claimFilesData = [];

      req.files.forEach((file) => {
        const fileId = uuidv4();
        const ext = path.extname(file.originalname).toLowerCase();

        fileList.push({
          fileId,
          filePath: file.path,
          fileName: file.originalname,
          metadata: {
            size: file.size,
            mimetype: file.mimetype,
            uploadedAt: new Date().toISOString(),
          },
        });

        claimFilesData.push({
          fileId,
          batchId,
          fileName: file.originalname,
          filePath: file.path,
          fileType: ext,
          status: 'pending',
          uploadedBy: req.user.id,
          hospitalCode: req.user.hospital_code,
        });
      });

      // Step 3: Insert into database (SYNC - transaction)
      await db.transaction(async (tx) => {
        const insertStmt = tx.prepare(`
          INSERT INTO claim_files (
            id, batch_id, hospital_code, file_name, file_path, status,
            uploaded_by, file_type, created_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, CURRENT_TIMESTAMP)
        `);

        for (const file of claimFilesData) {
          insertStmt.run(
            file.fileId,
            file.batchId,
            file.hospitalCode,
            file.fileName,
            file.filePath,
            file.uploadedBy,
            file.fileType
          );
        }
      });

      // Step 4: Queue files (ASYNC - fire and forget)
      // ponytail: don't await queueing to keep response fast
      (async () => {
        try {
          await startBatch(batchId);
          await queueBatch(fileList, batchId);
          console.log(`✅ Batch ${batchId} queued with ${fileList.length} files`);
        } catch (error) {
          console.error(`❌ Error queueing batch ${batchId}:`, error);
          await db.prepare(`
            UPDATE processing_jobs SET status = 'failed', error_message = ?
            WHERE batch_id = ?
          `).run(error.message, batchId);
        }
      })();

      const responseTime = Date.now() - startTime;

      // IMMEDIATE Response (202 Accepted)
      return res.status(202).json({
        batch_id: batchId,
        status: 'accepted',
        total_files: req.files.length,
        message: 'Files accepted for processing. Check batch status using batch_id.',
        response_time_ms: responseTime,
      });
    } catch (error) {
      console.error('Batch upload error:', error);

      // Cleanup uploaded files on error
      if (req.files) {
        req.files.forEach((file) => {
          try {
            fs.unlinkSync(file.path);
          } catch (e) {
            /* ignore */
          }
        });
      }

      return res.status(500).json({
        error: 'Gagal memproses batch upload',
        message: error.message,
      });
    }
  }
);

/**
 * GET /api/v1/claim-files/batch/:batch_id/status
 * Get batch processing status
 */
router.get('/batch/:batch_id/status', authenticate, async (req, res) => {
  const db = getDb();

  try {
    const batch = await db.prepare(`
      SELECT
        id, batch_id, status, progress_percent,
        total_files, processed_files, successful_files, failed_files,
        created_at, started_at, completed_at, error_message
      FROM processing_jobs
      WHERE batch_id = ? AND hospital_code = ?
    `).get(req.params.batch_id, req.user.hospital_code);

    if (!batch) {
      return res.status(404).json({ error: 'Batch tidak ditemukan.' });
    }

    // Get file details
    const files = await db.prepare(`
      SELECT id, file_name, status, review_status, error_count, created_at
      FROM claim_files
      WHERE batch_id = ?
      ORDER BY created_at DESC
    `).all(req.params.batch_id);

    return res.json({
      batch_id: batch.batch_id,
      status: batch.status,
      progress: {
        percent: batch.progress_percent,
        total: batch.total_files,
        processed: batch.processed_files,
        successful: batch.successful_files,
        failed: batch.failed_files,
      },
      timestamps: {
        created_at: batch.created_at,
        started_at: batch.started_at,
        completed_at: batch.completed_at,
      },
      error_message: batch.error_message,
      files: files.map((f) => ({
        file_id: f.id,
        name: f.file_name,
        status: f.status,
        review_status: f.review_status,
        errors: f.error_count,
      })),
    });
  } catch (error) {
    console.error('Batch status error:', error);
    return res.status(500).json({ error: 'Gagal mengambil status batch', message: error.message });
  }
});

/**
 * GET /api/v1/claim-files/batch/stats
 * Get queue statistics
 */
router.get('/stats', authenticate, authorize('admin'), async (req, res) => {
  const db = getDb();

  try {
    const stats = await db.prepare(`
      SELECT
        status,
        COUNT(*) as count,
        AVG(progress_percent) as avg_progress
      FROM processing_jobs
      WHERE created_at > datetime('now', '-7 days')
      GROUP BY status
    `).all();

    const totalBatches = await db.prepare('SELECT COUNT(*) as count FROM processing_jobs').get();
    const totalFiles = await db.prepare('SELECT COUNT(*) as count FROM claim_files WHERE batch_id IS NOT NULL').get();

    return res.json({
      total_batches: totalBatches.count,
      total_files: totalFiles.count,
      stats_by_status: stats,
      last_7_days: true,
    });
  } catch (error) {
    console.error('Stats error:', error);
    return res.status(500).json({ error: 'Gagal mengambil statistik', message: error.message });
  }
});

module.exports = router;
