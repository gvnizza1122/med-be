const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { logAudit } = require('../services/auditService');

const router = express.Router();

/**
 * GET /api/v1/users
 */
router.get('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const db = getDb();
    const users = await db.prepare(`
      SELECT id, email, full_name, nik, role, hospital_code, is_active, last_login, created_at
      FROM users ORDER BY created_at DESC
    `).all();
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/users
 */
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { email, password, full_name, nik, role } = req.body;

    if (!email || !password || !full_name || !role) {
      return res.status(400).json({ error: 'Email, password, nama lengkap, dan role wajib diisi.' });
    }

    if (!['admin', 'supervisor', 'verifikator'].includes(role)) {
      return res.status(400).json({ error: 'Role tidak valid.' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password minimal 8 karakter.' });
    }

    const db = getDb();
    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return res.status(400).json({ error: 'Email sudah terdaftar.' });
    }

    const id = uuidv4();
    const passwordHash = bcrypt.hashSync(password, 10);

    await db.prepare(`
      INSERT INTO users (id, email, password_hash, full_name, nik, role, hospital_code)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, email, passwordHash, full_name, nik || null, role, req.user.hospital_code);

    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'create_user', resourceType: 'user', resourceId: id,
      details: { email, role },
      ipAddress: req.ip
    });

    res.status(201).json({
      id, email, full_name, nik, role,
      hospital_code: req.user.hospital_code,
      is_active: true
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/v1/users/:id
 */
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const db = getDb();
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan.' });

    const { full_name, nik, role, is_active, password } = req.body;
    const updates = [];
    const params = [];

    if (full_name) { updates.push('full_name = ?'); params.push(full_name); }
    if (nik !== undefined) { updates.push('nik = ?'); params.push(nik); }
    if (role) { updates.push('role = ?'); params.push(role); }
    if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }
    if (password) {
      updates.push('password_hash = ?');
      params.push(bcrypt.hashSync(password, 10));
    }

    if (updates.length === 0) return res.status(400).json({ error: 'Tidak ada perubahan.' });

    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);

    // Jalankan query update
    await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updated = await db.prepare('SELECT id, email, full_name, nik, role, is_active, hospital_code FROM users WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/v1/users/:id (soft delete)
 */
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const db = getDb();
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Tidak bisa menghapus akun sendiri.' });
    }

    await db.prepare("UPDATE users SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(req.params.id);

    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'deactivate_user', resourceType: 'user', resourceId: req.params.id,
      ipAddress: req.ip
    });

    res.json({ message: 'User berhasil dinonaktifkan.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
