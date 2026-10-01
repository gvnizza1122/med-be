const express = require('express');
const { authenticate } = require('../middleware/auth');
const icd10 = require('../data/icd10_who_dictionary.json');
const icd9cm = require('../data/icd9cm_procedures.json');

const router = express.Router();
const diagnosisDescriptions = new Map(icd10.codes.map(({ code, description_en }) => [code.toUpperCase(), description_en]));
const procedureDescriptions = new Map(icd9cm.codes.map(({ code, description_en }) => [code.toUpperCase(), description_en]));

// Kode kadang tersimpan tanpa titik ("N209", "9904"). Kamus memakai titik,
// jadi coba sisipkan titik di posisi bakunya: ICD-10 setelah 3 karakter,
// ICD-9-CM setelah 2 digit. Respons tetap memakai kode seperti yang diminta.
function lookup(codes, dictionary, posisiTitik) {
  const descriptions = {};
  for (const rawCode of codes) {
    if (typeof rawCode !== 'string') continue;
    const code = rawCode.trim().toUpperCase();
    if (!/^[A-Z0-9.]{2,10}$/.test(code)) continue;
    const description = dictionary.get(code)
      || (!code.includes('.') && code.length > posisiTitik
        ? dictionary.get(`${code.slice(0, posisiTitik)}.${code.slice(posisiTitik)}`)
        : undefined);
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
    diagnosis: lookup(diagnosis, diagnosisDescriptions, 3),
    procedure: lookup(procedure, procedureDescriptions, 2),
  });
});

module.exports = router;
