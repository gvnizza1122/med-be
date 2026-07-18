const express = require('express');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticate, authorize('admin', 'supervisor'), async (req, res) => {
  try {
    const db = getDb();
    const { page = 1, limit = 50, user_id, action, from_date, to_date } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = 'WHERE 1=1';
    const params = [];

    if (user_id) { where += ' AND al.user_id = ?'; params.push(user_id); }
    if (action) { where += ' AND al.action = ?'; params.push(action); }
    if (from_date) { where += ' AND al.created_at >= ?'; params.push(from_date); }
    if (to_date) { where += ' AND al.created_at <= ?'; params.push(to_date + 'T23:59:59'); }

    const totalResult = await db.prepare(`SELECT COUNT(*) as count FROM audit_logs al ${where}`).get(...params);
    const total = Number(totalResult ? totalResult.count : 0);

    const logs = await db.prepare(`
      SELECT al.*, u.full_name as user_name
      FROM audit_logs al
      LEFT JOIN users u ON al.user_id = u.id
      ${where}
      ORDER BY al.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    res.json({ total, page: parseInt(page), limit: parseInt(limit), logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
