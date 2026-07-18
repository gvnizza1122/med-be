const express = require('express');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/v1/dashboard/summary
 */
router.get('/summary', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const { period } = req.query;

    let where = '';
    const params = [];
    if (period) {
      where = 'WHERE cf.period = ?';
      params.push(period);
    }

    // Overall stats
    const totalFilesResult = await db.prepare(`SELECT COUNT(*) as count FROM claim_files cf ${where}`).get(...params);
    const totalFiles = Number(totalFilesResult ? totalFilesResult.count : 0);

    const totalClaimsResult = await db.prepare(`
      SELECT COALESCE(SUM(cf.total_records), 0) as count FROM claim_files cf ${where}
    `).get(...params);
    const totalClaims = Number(totalClaimsResult ? totalClaimsResult.count : 0);

    const validCountResult = await db.prepare(`
      SELECT COALESCE(SUM(cf.valid_count), 0) as count FROM claim_files cf ${where}
    `).get(...params);
    const validCount = Number(validCountResult ? validCountResult.count : 0);

    const errorCountResult = await db.prepare(`
      SELECT COALESCE(SUM(cf.error_count), 0) as count FROM claim_files cf ${where}
    `).get(...params);
    const errorCount = Number(errorCountResult ? errorCountResult.count : 0);

    const pendingCountResult = await db.prepare(`
      SELECT COALESCE(SUM(cf.pending_count), 0) as count FROM claim_files cf ${where}
    `).get(...params);
    const pendingCount = Number(pendingCountResult ? pendingCountResult.count : 0);

    // Error breakdown by type
    let errorByTypeQuery = `
      SELECT ve.rule_id, vr.rule_name, COUNT(*) as count
      FROM validation_errors ve
      JOIN validation_rules vr ON ve.rule_id = vr.id
      JOIN claim_records cr ON ve.record_id = cr.id
      JOIN claim_files cf ON cr.file_id = cf.id
    `;
    if (period) {
      errorByTypeQuery += ' WHERE cf.period = ?';
    }
    errorByTypeQuery += ' GROUP BY ve.rule_id, vr.rule_name ORDER BY count DESC';

    const rawErrorByType = period
      ? await db.prepare(errorByTypeQuery).all(period)
      : await db.prepare(errorByTypeQuery).all();

    const errorByType = rawErrorByType.map(e => ({
      ...e,
      count: Number(e.count)
    }));

    // Recent files
    const recentFilesRaw = await db.prepare(`
      SELECT cf.id, cf.file_name, cf.period, cf.status, cf.total_records,
             cf.valid_count, cf.error_count, cf.pending_count, cf.created_at,
             u.full_name as uploaded_by_name
      FROM claim_files cf
      LEFT JOIN users u ON cf.uploaded_by = u.id
      ORDER BY cf.created_at DESC
      LIMIT 5
    `).all();

    const recentFiles = recentFilesRaw.map(f => ({
      ...f,
      total_records: Number(f.total_records || 0),
      valid_count: Number(f.valid_count || 0),
      error_count: Number(f.error_count || 0),
      pending_count: Number(f.pending_count || 0)
    }));

    // Available periods
    const periodsRaw = await db.prepare(`
      SELECT DISTINCT period FROM claim_files WHERE period IS NOT NULL ORDER BY period DESC
    `).all();
    const periods = periodsRaw.map(p => p.period);

    res.json({
      period: period || 'all',
      total_files: totalFiles,
      total_claims: totalClaims,
      valid: validCount,
      error: errorCount,
      pending: pendingCount,
      error_by_type: errorByType,
      recent_files: recentFiles,
      available_periods: periods
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/v1/dashboard/error-trends
 */
router.get('/error-trends', authenticate, async (req, res) => {
  try {
    const db = getDb();

    const trendsRaw = await db.prepare(`
      SELECT cf.period,
             SUM(cf.total_records) as total,
             SUM(cf.valid_count) as valid,
             SUM(cf.error_count) as error,
             SUM(cf.pending_count) as pending
      FROM claim_files cf
      WHERE cf.period IS NOT NULL AND cf.status IN ('completed', 'approved')
      GROUP BY cf.period
      ORDER BY cf.period ASC
      LIMIT 12
    `).all();

    const trends = trendsRaw.map(t => ({
      period: t.period,
      total: Number(t.total || 0),
      valid: Number(t.valid || 0),
      error: Number(t.error || 0),
      pending: Number(t.pending || 0)
    }));

    res.json({ trends });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
