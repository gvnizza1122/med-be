const { v4: uuidv4 } = require('uuid');
const { pdfProcessingQueue } = require('../config/queue');
const { getDb } = require('../database/init');

// Create batch job and return batch_id
async function createBatch(hospitalCode, uploadedBy, totalFiles, uploadNotes = null) {
  const db = getDb();
  const batchId = uuidv4();

  await db.prepare(`
    INSERT INTO processing_jobs (batch_id, hospital_code, uploaded_by, total_files, status, progress_percent)
    VALUES (?, ?, ?, ?, 'pending', 0)
  `).run(batchId, hospitalCode, uploadedBy, totalFiles);

  return batchId;
}

// Queue a file for processing
async function queueFile(fileId, batchId, filePath, fileName, metadata = {}) {
  const jobData = {
    fileId,
    batchId,
    filePath,
    fileName,
    metadata,
    timestamp: new Date().toISOString(),
  };

  const job = await pdfProcessingQueue.add(`pdf-${fileId}`, jobData, {
    jobId: fileId,
    priority: 10,
  });

  return job;
}

// Batch queue multiple files at once
async function queueBatch(fileList, batchId) {
  const jobs = fileList.map(file => ({
    name: `pdf-${file.fileId}`,
    data: {
      fileId: file.fileId,
      batchId,
      filePath: file.filePath,
      fileName: file.fileName,
      metadata: file.metadata || {},
      timestamp: new Date().toISOString(),
    },
    opts: { jobId: file.fileId, priority: 10 },
  }));

  const addedJobs = await pdfProcessingQueue.addBulk(jobs);
  return addedJobs;
}

// Update batch progress
async function updateBatchProgress(batchId, processedCount, successCount, failedCount) {
  const db = getDb();

  const batch = await db.prepare('SELECT total_files FROM processing_jobs WHERE batch_id = ?').get(batchId);
  if (!batch) throw new Error(`Batch ${batchId} not found`);

  const progressPercent = Math.round((processedCount / batch.total_files) * 100);
  const status = processedCount === batch.total_files ? 'completed' : 'processing';

  await db.prepare(`
    UPDATE processing_jobs
    SET processed_files = ?, successful_files = ?, failed_files = ?, status = ?, progress_percent = ?
    WHERE batch_id = ?
  `).run(processedCount, successCount, failedCount, status, progressPercent, batchId);
}

// Mark batch as started
async function startBatch(batchId) {
  const db = getDb();
  await db.prepare(`
    UPDATE processing_jobs
    SET status = 'processing', started_at = CURRENT_TIMESTAMP, progress_percent = 1
    WHERE batch_id = ?
  `).run(batchId);
}

// Mark batch as completed
async function completeBatch(batchId, hasErrors = false) {
  const db = getDb();
  const status = hasErrors ? 'completed_with_errors' : 'completed';

  await db.prepare(`
    UPDATE processing_jobs
    SET status = ?, completed_at = CURRENT_TIMESTAMP, progress_percent = 100
    WHERE batch_id = ?
  `).run(status, batchId);
}

// Record file processing in queue history
async function logQueueEvent(jobId, batchId, fileId, eventType, message, durationMs = null, errorDetails = null) {
  const db = getDb();

  await db.prepare(`
    INSERT INTO queue_history (job_id, batch_id, file_id, event_type, message, duration_ms, error_details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(jobId, batchId, fileId, eventType, message, durationMs, errorDetails ? JSON.stringify(errorDetails) : null);
}

// Get batch status
async function getBatchStatus(batchId) {
  const db = getDb();
  return await db.prepare('SELECT * FROM processing_jobs WHERE batch_id = ?').get(batchId);
}

// Get queue stats
async function getQueueStats() {
  const counts = await pdfProcessingQueue.getCountsPerStatus();
  const stats = {
    queue: counts,
    timestamp: new Date().toISOString(),
  };
  return stats;
}

// Clear old completed jobs (cleanup)
async function cleanupOldJobs(ageHours = 24) {
  const db = getDb();
  const cutoffTime = new Date(Date.now() - ageHours * 60 * 60 * 1000);

  await db.prepare(`
    DELETE FROM queue_history
    WHERE created_at < ?
  `).run(cutoffTime);
}

module.exports = {
  createBatch,
  queueFile,
  queueBatch,
  updateBatchProgress,
  startBatch,
  completeBatch,
  logQueueEvent,
  getBatchStatus,
  getQueueStats,
  cleanupOldJobs,
};
