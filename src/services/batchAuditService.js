/**
 * Batch Audit Service — Phase 2
 * Handles bulk auditing of multiple records with rate limiting
 */

const { auditRecordField, logFieldAudit } = require('./aiValidationService');

// Rate limiter: max 5 concurrent OpenRouter calls (avoid timeouts/rate limits)
const MAX_CONCURRENT = 5;

class BatchAuditQueue {
  constructor() {
    this.queue = [];
    this.running = 0;
  }

  async add(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.process();
    });
  }

  async process() {
    while (this.running < MAX_CONCURRENT && this.queue.length > 0) {
      this.running++;
      const { task, resolve, reject } = this.queue.shift();

      try {
        const result = await task();
        resolve(result);
      } catch (err) {
        reject(err);
      } finally {
        this.running--;
        if (this.queue.length > 0) {
          this.process();
        }
      }
    }
  }
}

/**
 * Run batch audit on multiple records
 * @param {Object} db - Database instance
 * @param {string[]} recordIds - Record IDs to audit
 * @param {string} style - Audit style (ponytail/caveman/neutral)
 * @param {Function} onProgress - Callback: (completed, total, current)
 * @returns {{completed: number, failed: number, results: object[]}}
 */
async function batchAuditRecords(db, recordIds, style = 'ponytail', onProgress = null) {
  if (!Array.isArray(recordIds) || recordIds.length === 0) {
    throw new Error('Record IDs must be a non-empty array.');
  }

  const queue = new BatchAuditQueue();
  const results = [];
  let completed = 0;
  let failed = 0;

  console.log(`[Batch Audit] Starting audit for ${recordIds.length} records (${style} style)`);

  // Create audit tasks for each record
  const auditTasks = recordIds.map((recordId, index) => async () => {
    try {
      const record = await db.prepare('SELECT * FROM claim_records WHERE id = ?').get(recordId);

      if (!record) {
        throw new Error(`Record not found: ${recordId}`);
      }

      // Skip already valid records
      if (record.validation_status === 'valid') {
        return { record_id: recordId, skipped: true, reason: 'Record already valid' };
      }

      // Get validation errors for this record
      const errors = await db.prepare(`
        SELECT DISTINCT field_name, error_message FROM validation_errors
        WHERE record_id = ?
        LIMIT 5
      `).all(recordId);

      if (errors.length === 0) {
        return { record_id: recordId, skipped: true, reason: 'No validation errors found' };
      }

      // Audit each failed field
      const fieldAudits = [];
      for (const err of errors) {
        try {
          const auditResult = await auditRecordField(
            record,
            err.field_name || 'unknown',
            style,
            err.error_message,
            { db }
          );

          // Log audit to DB
          const auditId = await logFieldAudit(db, {
            fileId: record.file_id,
            recordId: record.id,
            fieldName: err.field_name,
            result: auditResult,
          });

          fieldAudits.push({
            field: err.field_name,
            audit_id: auditId,
            status: auditResult.status,
            confidence: auditResult.confidence_score,
            tokens: auditResult.tokens_used?.total || 0,
          });
        } catch (fieldErr) {
          console.warn(`[Batch Audit] Field audit failed: ${err.field_name} - ${fieldErr.message}`);
          fieldAudits.push({
            field: err.field_name,
            error: fieldErr.message,
          });
        }
      }

      completed++;
      if (onProgress) onProgress(completed, recordIds.length, record.nama_pasien || recordId);

      return {
        record_id: recordId,
        record_name: record.nama_pasien,
        audited_fields: fieldAudits,
        total_fields: fieldAudits.length,
      };
    } catch (err) {
      failed++;
      if (onProgress) onProgress(completed, recordIds.length, null);

      return {
        record_id: recordId,
        error: err.message,
      };
    }
  });

  // Queue all tasks with rate limiting
  const queuedTasks = auditTasks.map(task => queue.add(task));
  const auditResults = await Promise.allSettled(queuedTasks);

  // Collect results
  auditResults.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
      results.push(result.value);
    } else {
      results.push({
        record_id: recordIds[idx],
        error: result.reason?.message || 'Unknown error',
      });
      failed++;
    }
  });

  console.log(`[Batch Audit] Complete: ${completed} audited, ${failed} failed`);

  return {
    total: recordIds.length,
    completed,
    failed,
    results,
  };
}

/**
 * Batch audit with automatic error grouping (for API responses)
 */
async function batchAuditWithErrorHandling(db, recordIds, style = 'ponytail') {
  try {
    const result = await batchAuditRecords(db, recordIds, style);

    // Separate success/error results
    const successful = result.results.filter(r => !r.error && !r.skipped);
    const skipped = result.results.filter(r => r.skipped);
    const failed = result.results.filter(r => r.error);

    return {
      ok: failed.length === 0,
      summary: {
        total: result.total,
        audited: result.completed,
        failed: result.failed,
        skipped: skipped.length,
      },
      successful,
      skipped,
      failed: failed.map(f => ({
        record_id: f.record_id,
        error_message: f.error,
      })),
    };
  } catch (err) {
    throw new Error(`Batch audit failed: ${err.message}`);
  }
}

module.exports = {
  batchAuditRecords,
  batchAuditWithErrorHandling,
  BatchAuditQueue,
};
