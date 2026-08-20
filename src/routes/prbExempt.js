const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { logAudit } = require('../services/auditService');

const router = express.Router();

/**
 * Manajemen daftar pasien kronis yang SENGAJA di-exempt dari Program Rujuk
 * Balik (PRB) walau sudah stabil >=3 bulan berturut (mis. komplikasi berat,
 * komorbid) — dicek otomatis oleh detectAndFlagPRB() sebelum RV-15 menyala.
 * Admin-only, sama seperti users.js.
 */

// GET /api/v1/prb-exempt
router.get('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const db = getDb();
    const rows = await db.prepare(`
      SELECT * FROM prb_exemption_list WHERE hospital_code = ? ORDER BY created_at DESC
    `).all(req.user.hospital_code);
    res.json({ exemptions: rows });
  } catch (err) {
    console.error('[prb-exempt] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

// POST /api/v1/prb-exempt
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { mrn, nokartu, nama_pasien, alasan_exempt, dpjp, tanggal_exempt, berlaku_sampai } = req.body;
    if (!mrn || !alasan_exempt) {
      return res.status(400).json({ error: 'MRN dan alasan exempt wajib diisi.' });
    }

    const db = getDb();
    const id = uuidv4();
    await db.prepare(`
      INSERT INTO prb_exemption_list
        (id, hospital_code, mrn, nokartu, nama_pasien, alasan_exempt, dpjp, tanggal_exempt, berlaku_sampai, diinput_oleh)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, req.user.hospital_code, mrn, nokartu || null, nama_pasien || null,
      alasan_exempt, dpjp || null, tanggal_exempt || null, berlaku_sampai || null, req.user.id
    );

    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'create_prb_exemption', resourceType: 'prb_exemption', resourceId: id,
      details: { mrn, alasan_exempt }, ipAddress: req.ip,
    });

    res.status(201).json({ id, mrn, nokartu, nama_pasien, alasan_exempt, dpjp, tanggal_exempt, berlaku_sampai });
  } catch (err) {
    console.error('[prb-exempt] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

// PUT /api/v1/prb-exempt/:id
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.prepare('SELECT id FROM prb_exemption_list WHERE id = ? AND hospital_code = ?')
      .get(req.params.id, req.user.hospital_code);
    if (!existing) return res.status(404).json({ error: 'Data exempt tidak ditemukan.' });

    const { nama_pasien, alasan_exempt, dpjp, tanggal_exempt, berlaku_sampai } = req.body;
    if (!alasan_exempt) return res.status(400).json({ error: 'Alasan exempt wajib diisi.' });

    await db.prepare(`
      UPDATE prb_exemption_list
      SET nama_pasien = ?, alasan_exempt = ?, dpjp = ?, tanggal_exempt = ?, berlaku_sampai = ?
      WHERE id = ?
    `).run(nama_pasien || null, alasan_exempt, dpjp || null, tanggal_exempt || null, berlaku_sampai || null, req.params.id);

    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'update_prb_exemption', resourceType: 'prb_exemption', resourceId: req.params.id,
      details: { alasan_exempt }, ipAddress: req.ip,
    });

    res.json({ message: 'Data exempt berhasil diperbarui.' });
  } catch (err) {
    console.error('[prb-exempt] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

// DELETE /api/v1/prb-exempt/:id
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.prepare('SELECT id, mrn FROM prb_exemption_list WHERE id = ? AND hospital_code = ?')
      .get(req.params.id, req.user.hospital_code);
    if (!existing) return res.status(404).json({ error: 'Data exempt tidak ditemukan.' });

    await db.prepare('DELETE FROM prb_exemption_list WHERE id = ?').run(req.params.id);

    logAudit({
      userId: req.user.id, userEmail: req.user.email,
      action: 'delete_prb_exemption', resourceType: 'prb_exemption', resourceId: req.params.id,
      details: { mrn: existing.mrn }, ipAddress: req.ip,
    });

    res.json({ message: 'Data exempt berhasil dihapus.' });
  } catch (err) {
    console.error('[prb-exempt] error:', err);
    res.status(500).json({ error: 'Terjadi gangguan pada sistem. Silakan coba lagi. Bila terus berulang, hubungi petugas IT rumah sakit.' });
  }
});

module.exports = router;
