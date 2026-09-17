const express = require('express');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/v1/audit-logs — daftar audit_logs (siapa melakukan apa, kapan).
 * Admin/superadmin-only — ini data sensitif (aktivitas semua user).
 * Filter opsional: user_email, action, resource_type, from_date, to_date.
 */
router.get('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const db = getDb();
    const { page = 1, limit = 30, user_email, action, resource_type, from_date, to_date } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = 'WHERE 1=1';
    const params = [];

    if (user_email) {
      where += ' AND user_email ILIKE ?';
      params.push(`%${user_email}%`);
    }
    if (action) {
      where += ' AND action = ?';
      params.push(action);
    }
    if (resource_type) {
      where += ' AND resource_type = ?';
      params.push(resource_type);
    }
    if (from_date) {
      where += ' AND created_at >= ?';
      params.push(from_date);
    }
    if (to_date) {
      where += ' AND created_at <= ?';
      params.push(to_date + 'T23:59:59');
    }

    const totalResult = await db.prepare(`SELECT COUNT(*) as count FROM audit_logs ${where}`).get(...params);
    const total = Number(totalResult ? totalResult.count : 0);

    const logs = await db.prepare(`
      SELECT id, user_id, user_email, action, resource_type, resource_id, details, ip_address, created_at
      FROM audit_logs
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    // action/resource_type lists buat dropdown filter FE — distinct dari data
    // yang benar-benar ada, bukan daftar statis (supaya otomatis ikut kalau
    // ada action baru ditambahkan di kode tanpa perlu update FE).
    const [actionsResult, resourceTypesResult] = await Promise.all([
      db.prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action').all(),
      db.prepare("SELECT DISTINCT resource_type FROM audit_logs WHERE resource_type IS NOT NULL ORDER BY resource_type").all(),
    ]);

    res.json({
      total, page: parseInt(page), limit: parseInt(limit),
      logs: logs.map(l => ({ ...l, details: l.details ? JSON.parse(l.details) : null })),
      available_actions: actionsResult.map(r => r.action),
      available_resource_types: resourceTypesResult.map(r => r.resource_type),
    });
  } catch (err) {
    console.error('[audit-logs] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

module.exports = router;
