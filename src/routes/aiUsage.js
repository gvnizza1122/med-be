const express = require('express');
const { getDb } = require('../database/init');
const { authenticate, authorize } = require('../middleware/auth');
const { ringkasanBulanan,biayaBerkas } = require('../services/penggunaanAiService');
const router = express.Router();
router.get('/files',authenticate,authorize('admin'),async(req,res)=>{
  res.set('Cache-Control','no-store');
  try {res.json(await biayaBerkas(getDb(),req.user.hospital_code,req.query.month,req.query.page||1));}
  catch(err) {res.status(err.status||500).json({error:err.status?err.message:'Rincian biaya berkas belum dapat dimuat.'});}
});

router.get('/', authenticate, authorize('admin'), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json(await ringkasanBulanan(getDb(), req.user.hospital_code, req.query.month));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[PenggunaanAI] laporan gagal:', err.message);
    res.status(500).json({ error: 'Laporan penggunaan AI belum dapat dimuat. Silakan coba lagi.' });
  }
});
module.exports = router;
