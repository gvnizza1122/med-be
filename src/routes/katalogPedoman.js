const express = require('express');
const { authenticate } = require('../middleware/auth');
const service = require('../services/katalogPedomanService');
const router = express.Router();
router.use(authenticate);
router.get('/', (req,res,next) => { try { res.json(service.daftar(req.query)); } catch(e) { next(e); } });
router.get('/:id/pdf', (req,res) => {
  const v = req.query.varian === undefined ? 0 : Number(req.query.varian);
  if (!Number.isInteger(v) || v < 0) return res.status(400).json({error:'Pilihan salinan tidak sesuai.'});
  const file = service.berkasDokumen(req.params.id,v);
  if (!file) return res.status(404).json({error:'Berkas sumber belum tersedia.'});
  res.type('pdf').set('Content-Disposition','inline; filename="pedoman.pdf"');
  res.sendFile(file);
});
router.get('/:id', (req,res) => {
  const d=service.getDokumen(req.params.id);
  if (!d) return res.status(404).json({error:'Pedoman tidak ditemukan.'});
  res.json({dokumen:d, cuplikan:service.cuplikan(d,String(req.query.q || '').slice(0,160),10)});
});
module.exports=router;
