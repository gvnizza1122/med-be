const express = require('express');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

const VALID_KELAS_RS = ['A', 'B', 'C', 'D'];

/**
 * GET /api/v1/hospital-settings
 * Profil RS milik hospital_code user yang login. kelas_rs dipakai otomatis
 * saat upload PDF untuk mengisi kolom KELAS_RS (tidak pernah ada di dokumen
 * SEP/Resume Medis pasien, jadi diisi manual sekali di sini oleh admin).
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const row = await db.prepare('SELECT hospital_code, kelas_rs, updated_at FROM hospital_settings WHERE hospital_code = ?').get(req.user.hospital_code);
    res.json({
      hospital_code: req.user.hospital_code,
      kelas_rs: row?.kelas_rs || '',
      updated_at: row?.updated_at || null,
    });
  } catch (err) {
    console.error('[hospitalSettings] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

/**
 * PUT /api/v1/hospital-settings
 * Body: { kelas_rs: 'A'|'B'|'C'|'D' }
 */
router.put('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { kelas_rs } = req.body;
    if (!VALID_KELAS_RS.includes(kelas_rs)) {
      return res.status(400).json({ error: `Kelas RS harus salah satu dari: ${VALID_KELAS_RS.join(', ')}.` });
    }

    const db = getDb();
    await db.prepare(`
      INSERT INTO hospital_settings (hospital_code, kelas_rs, updated_by, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT (hospital_code) DO UPDATE SET kelas_rs = ?, updated_by = ?, updated_at = datetime('now')
    `).run(req.user.hospital_code, kelas_rs, req.user.id, kelas_rs, req.user.id);

    res.json({ hospital_code: req.user.hospital_code, kelas_rs });
  } catch (err) {
    console.error('[hospitalSettings] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

module.exports = router;
