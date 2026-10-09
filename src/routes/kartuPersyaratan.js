const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const { getDb } = require('../database/init');
const service = require('../services/kartuPersyaratanService');
const router = express.Router();
router.use(authenticate);
// Status telaah dibaca dari DB sekali per permintaan daftar/detail agar konsisten antar instance.
router.get('/', async (req, res, next) => { try { await service.muatTelaah(getDb()); res.json(service.daftarKartu()); } catch (e) { next(e); } });
router.get('/:id', async (req, res, next) => {
  try {
    await service.muatTelaah(getDb());
    const k = service.getKartu(req.params.id);
    if (!k) return res.status(404).json({ error: 'Kartu tidak ditemukan.' });
    res.json({ kartu: k });
  } catch (e) { next(e); }
});
// Telaah butir oleh casemix/dokter: disetujui, ditolak (tidak dipakai agen), atau perlu_revisi.
router.post('/:id/butir/:butirId/telaah', authorize('admin', 'supervisor', 'verifikator'), async (req, res, next) => {
  try {
    await service.simpanTelaah(getDb(), { kartu_id: req.params.id, butir_id: req.params.butirId, status: req.body?.status,
      catatan: req.body?.catatan, user_id: req.user?.id || null });
    res.json({ kartu: service.getKartu(req.params.id) });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
});
module.exports = router;
