const { Worker } = require('bullmq');
const fs = require('fs');
const { getDb } = require('../database/init');
const { parsePDF } = require('../services/pdfParser');
const { validateRecord, determineStatus } = require('../services/ruleEngine');
const { updateBatchProgress, logQueueEvent, getBatchStatus } = require('../services/queueService');
const { v4: uuidv4 } = require('uuid');
const { isiPeriodeUntukFile } = require('../services/periodeKlaimService');

const redisOptions = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
};

// Background worker processing PDF files with concurrency control
const worker = new Worker('pdf-processing', async (job) => {
  const startTime = Date.now();
  const { fileId, batchId, filePath, fileName, metadata } = job.data;
  const db = getDb();

  try {
    // Log: Processing started
    await logQueueEvent(job.id, batchId, fileId, 'processing', `Processing ${fileName}`, null, null);

    // Step 1: Parse PDF (extract text/data)
    console.log(`[Worker] Processing file: ${fileId} from batch ${batchId}`);

    // ponytail: check if file exists first
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const parseResult = await parsePDF(filePath);

    if (!parseResult.success) {
      throw new Error(`PDF parsing failed: ${parseResult.errors?.join(', ')}`);
    }

    // Step 2: Extract & map to vClaim format
    const extractedData = parseResult.vclaimFormat || {};
    const activeRules = await db.prepare('SELECT * FROM validation_rules WHERE is_active = 1').all();

    // Step 3: Validate extracted data
    const validationErrors = validateRecord(extractedData, activeRules);
    const validationStatus = determineStatus(validationErrors);

    // Step 4: Update claim_files table with extracted data
    const recordId = uuidv4();
    await db.prepare(`
      UPDATE claim_files
      SET
        batch_id = ?,
        status = 'ready_for_review',
        review_status = 'pending',
        error_count = ?,
        raw_data = ?
      WHERE id = ?
    `).run(batchId, validationErrors.length, JSON.stringify(parseResult.fields), fileId);

    // Step 5: Insert validation records
    await db.prepare(`
      INSERT INTO claim_records (
        id, file_id,
        nama_pasien, gender, birth_date,
        nokartu, mrn, kode_rs,
        sep, kelas_rawat,
        admission_date, discharge_date, discharge_status,
        diagnosa_list, prosedur_list,
        validation_status, error_count, raw_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      recordId, fileId,
      extractedData.NAMA_PASIEN || '',
      extractedData.SEX || '',
      extractedData.BIRTH_DATE || null,
      extractedData.NOKARTU || '',
      extractedData.MRN || '',
      extractedData.KODE_RS || '',
      extractedData.SEP || '',
      extractedData.KELAS_RAWAT || null,
      extractedData.ADMISSION_DATE || null,
      extractedData.DISCHARGE_DATE || null,
      extractedData.DISCHARGE_STATUS || null,
      extractedData.DIAGLIST || '',
      extractedData.PROCLIST || '',
      validationStatus,
      validationErrors.length,
      JSON.stringify(extractedData)
    );

    // Step 6: Store validation errors if any
    if (validationErrors.length > 0) {
      for (const error of validationErrors) {
        await db.prepare(`
          INSERT INTO validation_logs (record_id, rule_id, severity, error_message)
          VALUES (?, ?, ?, ?)
        `).run(recordId, error.rule_id || 'UNKNOWN', error.severity || 'major', error.error_message || error.message);
      }
    }

    // Periode diisi di sini, setelah record tersimpan, supaya pengelompokan
    // dan arsip per bulan ikut terbentuk untuk berkas yang baru masuk.
    try {
      await isiPeriodeUntukFile(db, fileId);
    } catch (e) {
      // periode bukan syarat berkas dianggap berhasil diproses
      console.warn('[periode] gagal mengisi periode:', e.message);
    }

    const duration = Date.now() - startTime;

    // Log: Processing completed
    await logQueueEvent(job.id, batchId, fileId, 'completed', `Successfully processed ${fileName}`, duration, null);

    // Step 7: Update batch progress
    const batch = await getBatchStatus(batchId);
    const processedCount = (batch.processed_files || 0) + 1;
    const successCount = validationErrors.length === 0 ? (batch.successful_files || 0) + 1 : batch.successful_files;
    const failedCount = validationErrors.length > 0 ? (batch.failed_files || 0) + 1 : batch.failed_files;

    await updateBatchProgress(batchId, processedCount, successCount, failedCount);

    console.log(`✅ [Worker] Completed: ${fileId} (${duration}ms, ${validationErrors.length} errors)`);

    return {
      success: true,
      fileId,
      recordId,
      errors: validationErrors.length,
      duration,
      status: validationStatus,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    console.error(`❌ [Worker] Failed: ${fileId} - ${error.message}`);

    // Log error
    await logQueueEvent(job.id, batchId, fileId, 'failed', `Error: ${error.message}`, duration, { message: error.message, stack: error.stack });

    // Update file status to error
    await db.prepare(`
      UPDATE claim_files
      SET status = 'error', error_message = ?
      WHERE id = ?
    `).run(error.message, fileId);

    // Update batch failed count
    const batch = await getBatchStatus(batchId);
    const processedCount = (batch.processed_files || 0) + 1;
    const failedCount = (batch.failed_files || 0) + 1;
    await updateBatchProgress(batchId, processedCount, batch.successful_files || 0, failedCount);

    throw error; // BullMQ will retry based on config
  }
}, {
  connection: redisOptions,
  concurrency: parseInt(process.env.WORKER_CONCURRENCY || '5'),
  maxStalledCount: 2,
  stalledInterval: 30000,
});

// Worker event handlers
worker.on('completed', (job, result) => {
  console.log(`📊 Job ${job.id} completed:`, result);
});

worker.on('failed', (job, error) => {
  console.error(`❌ Job ${job.id} failed (attempt ${job.attemptsMade}):`, error.message);
});

worker.on('error', (error) => {
  console.error('Worker error:', error);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down worker...');
  await worker.close();
  process.exit(0);
});

module.exports = { worker };
