const express = require('express');
const { authenticate } = require('../middleware/auth');
const { deskripsiDiagnosis, deskripsiProsedur } = require('../services/kamusKodeService');

const router = express.Router();

// Respons memakai kode seperti yang diminta (huruf besar, tanpa spasi);
// kode yang tidak ada di kamus tidak dimasukkan.
function lookup(codes, cariDeskripsi) {
  const descriptions = {};
  for (const rawCode of codes) {
    if (typeof rawCode !== 'string') continue;
    const code = rawCode.trim().toUpperCase();
    const description = cariDeskripsi(code);
    if (description) descriptions[code] = description;
  }
  return descriptions;
}

// Kamus kode lokal SATUSEHAT. Hanya kode dikirim; data pasien tidak diperlukan.
router.post('/lookup', authenticate, (req, res) => {
  const { diagnosis = [], procedure = [] } = req.body || {};
  if (!Array.isArray(diagnosis) || !Array.isArray(procedure) || diagnosis.length > 50 || procedure.length > 50) {
    return res.status(400).json({ error: 'Daftar kode tidak sesuai. Maksimal 50 kode per jenis.' });
  }

  res.json({
    diagnosis: lookup(diagnosis, deskripsiDiagnosis),
    procedure: lookup(procedure, deskripsiProsedur),
  });
});

module.exports = router;
