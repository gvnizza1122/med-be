const express = require('express');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

/**
 * GET /api/v1/validation-rules
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const rows = await db.prepare('SELECT * FROM validation_rules ORDER BY id ASC').all();
    
    // Normalisasi output: Ubah integer SQLite/PG (1/0) menjadi Boolean JS (true/false)
    const rules = rows.map(rule => ({
      ...rule,
      is_active: rule.is_active === 1
    }));

    res.json({ rules });
  } catch (err) {
    console.error('[validationRules] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * PUT /api/v1/validation-rules/:id
 */
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const db = getDb();
    const rule = await db.prepare('SELECT * FROM validation_rules WHERE id = ?').get(req.params.id);
    if (!rule) return res.status(404).json({ error: 'Rule tidak ditemukan.' });

    const { error_message, priority, is_active, description } = req.body;

    const updates = [];
    const params = [];

    if (error_message !== undefined) { updates.push('error_message = ?'); params.push(error_message); }
    if (priority !== undefined) { updates.push('priority = ?'); params.push(priority); }
    if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Tidak ada field yang diupdate.' });
    }

    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);

    // Jalankan query update
    await db.prepare(`UPDATE validation_rules SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updated = await db.prepare('SELECT * FROM validation_rules WHERE id = ?').get(req.params.id);
    
    // INTEGRASI AUDIT LOG
    try {
      await db.prepare(`
        INSERT INTO audit_logs (id, user_id, user_email, action, resource_type, resource_id, details)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(),
        req.user?.id || null,
        req.user?.email || 'unknown',
        'UPDATE_VALIDATION_RULE',
        'validation_rules',
        req.params.id,
        `Mengubah konfigurasi rule ${req.params.id}. Parameter terupdate: ${Object.keys(req.body).join(', ')}`
      );
    } catch (auditErr) {
      console.error('Gagal mencatat audit log:', auditErr.message);
    }

    // Normalisasi output response sebelum dikirim
    res.json({
      ...updated,
      is_active: updated.is_active === 1
    });

  } catch (err) {
    console.error('[validationRules] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

// ─── AI Field Audit (Phase 1) — mounted di /api/v1/records ────────────────

const { auditRecordField, logFieldAudit } = require('../services/aiValidationService');

const recordsRouter = express.Router();

const AUDITABLE_FIELDS = new Set([
  'sep', 'nokartu', 'diagnosa_list', 'prosedur_list', 'los',
  'admission_date', 'discharge_date', 'tarif_rs', 'tarif_inacbg',
  'kelas_rawat', 'vent_hour',
]);

/**
 * POST /api/v1/records/:recordId/rv20-confirm
 * Body: { checklist_items: { tvv_abnormal: bool, tampak_sakit_berat: bool, ... } }
 * Audit trail konfirmasi manual RV-20 (kriteria kegawatan IGD) — verifikator
 * sudah cek checklist sebelum lanjut walau RV-20 (non-blocking) terdeteksi.
 */
recordsRouter.post('/:recordId/rv20-confirm', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const record = await db.prepare('SELECT id, sep, mrn FROM claim_records WHERE id = ?').get(req.params.recordId);
    if (!record) return res.status(404).json({ error: 'Record tidak ditemukan.' });

    const checklistItems = req.body?.checklist_items;
    if (!checklistItems || typeof checklistItems !== 'object') {
      return res.status(400).json({ error: 'checklist_items wajib diisi.' });
    }

    const id = uuidv4();
    await db.prepare(`
      INSERT INTO rv20_confirmations (id, record_id, sep, mrn, checklist_items, confirmed_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, record.id, record.sep, record.mrn, JSON.stringify(checklistItems), req.user.id);

    res.status(201).json({ id, message: 'Konfirmasi kegawatan IGD tersimpan.' });
  } catch (err) {
    console.error('[rv20-confirm] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * GET /api/v1/records/:recordId/rv20-confirm
 * Cek apakah record ini sudah pernah dikonfirmasi (supaya modal tidak
 * berulang tiap kali halaman detail dibuka).
 */
recordsRouter.get('/:recordId/rv20-confirm', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const confirmation = await db.prepare(`
      SELECT id, checklist_items, confirmed_by, confirmed_at FROM rv20_confirmations
      WHERE record_id = ? ORDER BY confirmed_at DESC LIMIT 1
    `).get(req.params.recordId);
    res.json({ confirmed: !!confirmation, confirmation: confirmation || null });
  } catch (err) {
    console.error('[rv20-confirm] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * POST /api/v1/records/:recordId/audit
 * Body: { fields: ['SEP', 'NOKARTU'], style: 'ponytail' }
 * AI audit per-field, hanya untuk record yang gagal validasi rules (cost optimization).
 */
recordsRouter.post('/:recordId/audit', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const record = await db.prepare('SELECT * FROM claim_records WHERE id = ?').get(req.params.recordId);
    if (!record) return res.status(404).json({ error: 'Record tidak ditemukan.' });

    if (record.validation_status === 'valid') {
      return res.status(400).json({ error: 'Record sudah valid — AI audit hanya untuk record yang gagal rules (hemat token).' });
    }

    const style = ['ponytail', 'caveman', 'neutral'].includes(req.body?.style) ? req.body.style : 'ponytail';
    let fields = Array.isArray(req.body?.fields) ? req.body.fields.map(f => String(f).toLowerCase()) : [];

    // Default: audit field yang punya validation error
    if (fields.length === 0) {
      const errs = await db.prepare('SELECT DISTINCT field_name, error_message FROM validation_errors WHERE record_id = ?').all(req.params.recordId);
      fields = errs.map(e => (e.field_name || '').toLowerCase());
    }
    fields = fields.filter(f => AUDITABLE_FIELDS.has(f));
    if (fields.length === 0) {
      return res.status(400).json({ error: 'Tidak ada field yang bisa diaudit.' });
    }

    // Map error messages per field untuk enrichment prompt
    const errorMsgMap = {};
    const errDetails = await db.prepare('SELECT field_name, error_message FROM validation_errors WHERE record_id = ?').all(req.params.recordId);
    errDetails.forEach(e => {
      if (!errorMsgMap[e.field_name]) errorMsgMap[e.field_name] = [];
      errorMsgMap[e.field_name].push(e.error_message);
    });

    const audits = [];
    for (const field of fields) {
      try {
        const validationError = errorMsgMap[field]?.join('; ') || null;
        const result = await auditRecordField(record, field, style, validationError);
        const auditId = await logFieldAudit(db, {
          fileId: record.file_id, recordId: record.id, fieldName: field, result,
        });
        audits.push({ audit_id: auditId, field, ...result });
      } catch (err) {
        // Satu field gagal jangan gugurkan sisanya
        console.error(`[AI Audit] Field ${field} error:`, err.message);
        audits.push({ field, error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
      }
    }

    res.json({ record_id: record.id, style, audits });
  } catch (err) {
    res.status(500).json({ error: 'Gagal menjalankan AI audit: ' + err.message });
  }
});

/**
 * POST /api/v1/records/audit/:auditId/feedback
 * Body: { nurse_action: 'accepted' | 'rejected' | 'unsure' }
 */
recordsRouter.post('/audit/:auditId/feedback', authenticate, async (req, res) => {
  try {
    const { nurse_action } = req.body || {};
    if (!['accepted', 'rejected', 'unsure'].includes(nurse_action)) {
      return res.status(400).json({ error: 'nurse_action harus accepted/rejected/unsure.' });
    }
    const db = getDb();
    const wasCorrect = nurse_action === 'accepted' ? true : nurse_action === 'rejected' ? false : null;
    const result = await db.prepare('UPDATE ai_audit_log SET nurse_action = ?, was_correct = ? WHERE id = ?')
      .run(nurse_action, wasCorrect, req.params.auditId);
    if (result.changes === 0) return res.status(404).json({ error: 'Audit log tidak ditemukan.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[validationRules] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

// ─── Batch Audit (Phase 2) ────────────────────────────────────────────────

const { batchAuditWithErrorHandling } = require('../services/batchAuditService');

/**
 * POST /api/v1/records/batch-audit
 * Body: { record_ids: string[], style: 'ponytail' | 'caveman' | 'neutral' }
 */
recordsRouter.post('/batch-audit', authenticate, async (req, res) => {
  try {
    const db = getDb();
    let recordIds = req.body?.record_ids || [];
    const style = ['ponytail', 'caveman', 'neutral'].includes(req.body?.style) ? req.body.style : 'ponytail';

    // Validate input
    if (!Array.isArray(recordIds) || recordIds.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'record_ids harus berupa array non-kosong (max 100).',
      });
    }

    if (recordIds.length > 100) {
      return res.status(400).json({
        error: 'Too many records',
        message: 'Maksimal 100 record per batch. Gunakan batch terpisah untuk lebih banyak.',
      });
    }

    // Filter out invalid IDs
    recordIds = recordIds.filter(id => typeof id === 'string' && id.length > 0);

    if (recordIds.length === 0) {
      return res.status(400).json({
        error: 'No valid record IDs',
        message: 'Tidak ada record ID valid di payload.',
      });
    }

    console.log(`[Batch Audit] Starting audit for ${recordIds.length} records (${style})`);

    // Run batch audit
    const result = await batchAuditWithErrorHandling(db, recordIds, style);

    // Log audit action
    try {
      const { v4: uuidv4 } = require('uuid');
      await db.prepare(`
        INSERT INTO audit_logs (id, user_id, user_email, action, resource_type, resource_id, details)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(),
        req.user?.id || null,
        req.user?.email || 'batch-audit',
        'BATCH_AUDIT',
        'claim_records',
        recordIds.join(',').substring(0, 100),
        `Batch audit ${recordIds.length} records (${style}): ${result.summary.audited} audited, ${result.summary.failed} failed`
      );
    } catch (auditErr) {
      console.warn(`[Batch Audit] Audit log failed: ${auditErr.message}`);
    }

    res.json({
      ok: result.ok,
      message: `Batch audit selesai. ${result.summary.audited} record diaudit, ${result.summary.failed} gagal.`,
      summary: result.summary,
      results: result.successful,
      skipped: result.skipped.length > 0 ? result.skipped : undefined,
      failures: result.failed.length > 0 ? result.failed : undefined,
    });
  } catch (err) {
    console.error('[Batch Audit] Error:', err);
    res.status(500).json({
      error: 'Batch audit failed',
      message: err.message,
    });
  }
});

module.exports = router;
module.exports.recordsRouter = recordsRouter;